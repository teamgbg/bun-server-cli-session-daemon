/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * runSessionSelect — the single exported entry. Sets up the alt-screen, the
 * event-log bridge, the daemon-data refresher, the redraw loop, and mounts
 * the stdin key handler. The action closures (attachTo, createSession, row
 * actions, activate) live in picker-actions.ts and reference the same PickerRuntime.
 */
import { spawnSync } from "@teamscala/os/spawn/spawn";
import { attach } from "@teamscala/tmux-session/interact";
import { getClientVersion } from "./client-version.ts";
import { mergePickerConfig } from "./picker-config.ts";
import {
	type DaemonInfo,
	fetchPickerData,
	mutateSession,
	restoreSession,
	type RestoreResult,
	type SessionRowOp,
} from "./picker-rpc.ts";
import { formatRestoreAckLines } from "./restore-ack.ts";
import {
	ALT_OFF,
	ALT_ON,
	AMBER_BRIGHT,
	BLUE,
	BOLD,
	CLEAR,
	CURSOR_HIDE,
	CURSOR_SHOW,
	center,
	clipAnsi,
	DIM,
	DIM_STYLE,
	FG,
	GREEN,
	ITALIC,
	MOUSE_OFF,
	MOUSE_ON,
	RED,
	RESET,
	renderHero,
	rule,
	termCols,
	visibleLen,
} from "./style.ts";
import { createScreenRenderer } from "./screen-renderer.ts";
import type { ArchivedSession, AttachedClient, PickerConfig, SizingInfo } from "./types.ts";
import { recordEvent } from "@teamscala/event-log/record-event";
import { configure as configureEventLog } from "@teamscala/event-log/configure";
import { getSessionPickerUrl } from "@teamscala/cli-session/session-picker-url";
import { formatClientsCompact } from "../session-daemon/picker-data.ts";
import { namedLauncherCommand } from "./named-launcher.ts";
import { buildRows, isSelectable, type Row } from "./row-build.ts";
import { render } from "./render-table.ts";
import { formatSizingWarning } from "./format-helpers.ts";
import { wirePickerActions } from "./picker-actions.ts";
import { mountKeyHandler } from "./picker-key-handler.ts";
import { createPickerRuntime, type PickerRuntime } from "./picker-runtime.ts";


export async function runSessionSelect(config: PickerConfig): Promise<void> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const renderer = createScreenRenderer();
	if (!stdin.isTTY) {
		stdout.write("session-picker: stdin is not a TTY\n");
		process.exit(2);
	}
	// Bridge the picker's recordEvent to the daemon's /rpc/record-event. The
	// picker is a bare bun process (no bootloader/DB), so it POSTs login
	// telemetry to the daemon, which owns the configured event-log + DB.
	configureEventLog({
		write: async (event) => {
			try {
				await fetch(`${getSessionPickerUrl()}/rpc/record-event`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: event.kind,
						payload: event.payload,
						occurredAt: event.occurredAt.toISOString(),
					}),
					signal: AbortSignal.timeout(2000),
				});
			} catch {
				// fire-and-forget — a failed telemetry POST never blocks login
			}
		},
	});
	recordEvent({
		kind: "cli-session.picker.launch",
		payload: { term: process.env.TERM ?? null, colorterm: process.env.COLORTERM ?? null },
	});
	// The picker is shown on every login (operator intent: "every SSH login
	// lands in the session picker"). No singleton auto-attach — the page is
	// always presented so a session can be chosen.
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	stdout.write(`${ALT_ON}${CURSOR_HIDE}${MOUSE_ON}`);
	const cleanupTerminal = (): void => {
		stdout.write(`${MOUSE_OFF}${CURSOR_SHOW}${ALT_OFF}`);
		try {
			stdin.setRawMode(false);
		} catch {
			// ignore
		}
	};
	const quit = (): never => {
		cleanupTerminal();
		process.exit(0);
	};
	process.on("SIGTERM", quit);
	process.on("SIGINT", quit);

	const rt = createPickerRuntime(stdin, stdout, renderer, config);
	rt.cleanupTerminal = cleanupTerminal;
	rt.quit = quit;

	// === core ops wired on rt ===

	async function refreshData(): Promise<void> {
		try {
			const data = await fetchPickerData();
			rt.sessions = data.live.map((s) => ({
				name: s.name,
				windows: s.windows,
				attached: s.attached,
				clients: s.clients ?? [],
			}));
			rt.archived = data.archived;
			rt.hidden = data.hidden;
			rt.daemonInfo = data.daemon;
			rt.sizing = data.sizing ?? null;
			rt.loadError = null;
			rt.config = mergePickerConfig(rt.baseConfig, data.configOverride);
		} catch (err) {
			rt.loadError = err instanceof Error ? err.message : String(err);
			const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
			try {
				await Bun.write("/tmp/session-picker-error.log", `${new Date().toISOString()}\n${msg}\n`);
			} catch {
				// nothing else to do
			}
			if (!rt.retryTimer) {
				rt.retryTimer = setTimeout(() => {
					rt.retryTimer = null;
					void rt.refreshData().then(() => rt.redraw());
				}, 3000);
			}
		}
	}
	rt.refreshData = refreshData;

	function computeLayout(): { rows: Row[]; leftIdx: number[]; rightIdx: number[]; emptyLeft: boolean } {
		const rows = buildRows(rt.sessions, rt.archived, rt.hidden, rt.config.history_retention_days, rt.config.labels);
		const leftIdx: number[] = [];
		const rightIdx: number[] = [];
		for (let i = 0; i < rows.length; i += 1) {
			const r = rows[i] as Row;
			if (
				r.kind === "session" ||
				r.kind === "archived" ||
				r.kind === "hidden" ||
				r.kind === "header"
			)
				leftIdx.push(i);
			else rightIdx.push(i);
		}
		return {
			rows,
			leftIdx,
			rightIdx,
			emptyLeft: rt.sessions.length === 0 && rt.archived.length === 0 && rt.hidden.length === 0,
		};
	}
	rt.computeLayout = computeLayout;

	function selectableIndices(rows: Row[]): number[] {
		const out: number[] = [];
		for (let i = 0; i < rows.length; i += 1) {
			if (isSelectable(rows[i] as Row)) out.push(i);
		}
		return out;
	}
	rt.selectableIndices = selectableIndices;

	// The terminal width last painted at. A width change invalidates the
	// renderer's logical-row -> physical-row map, so ANY width change forces
	// a full clear-and-repaint. Closes the path where a size change without a
	// clean resize event leaves stale wrapped residue on the top rows.
	const redraw = (): void => {
		const layout = rt.computeLayout();
		if (termCols() !== rt.lastPaintCols) {
			rt.renderer.reset();
			rt.lastPaintCols = termCols();
		}
		const identity = `picker v${getClientVersion()} · daemon v${rt.daemonInfo.version} pid ${rt.daemonInfo.pid}`;
		const footerHint = rt.pendingDelete
			? `${rt.pendingDelete.live ? "Kill & delete" : "Delete"} '${rt.pendingDelete.name}'?  y confirm · n cancel`
			: rt.statusMsg ??
				(rt.loadError
					? "⚠ daemon unreachable — showing last-known sessions; retrying…"
					: rt.sizing && rt.sizing.clampingClients.length > 0
						? formatSizingWarning(rt.sizing)
						: rt.config.labels.nav_hint_select);
		const selectable = rt.selectableIndices(layout.rows);
		if (selectable.length === 0) {
			rt.stdout.write(rt.renderer.paint(render(
				rt.config,
				layout.rows,
				layout.leftIdx,
				layout.rightIdx,
				-1,
				layout.emptyLeft,
				identity,
				footerHint,
				rt.loadError,
			).split("\n")));
			return;
		}
		if (!selectable.includes(rt.selectedIdx)) {
			let nearest = selectable[0] as number;
			for (const idx of selectable) {
				if (Math.abs(idx - rt.selectedIdx) < Math.abs(nearest - rt.selectedIdx)) nearest = idx;
			}
			rt.selectedIdx = nearest;
		}
		rt.stdout.write(rt.renderer.paint(render(
			rt.config,
			layout.rows,
			layout.leftIdx,
			layout.rightIdx,
			rt.selectedIdx,
			layout.emptyLeft,
			identity,
			footerHint,
			rt.loadError,
		).split("\n")));
	};
	rt.redraw = redraw;

	// Paint a connecting notice before the first (possibly slow) daemon read —
	// a blank alt-screen for the retry window reads as a hang.
	stdout.write(renderer.paint([`${DIM}${ITALIC}Connecting to session daemon…${RESET}`], true));
	await refreshData();

	// === wire actions onto rt ===
	wirePickerActions(rt);

	rt.redraw();
	// Redraw on terminal resize. Registered AFTER `redraw` is defined.
	process.stdout.on("resize", () => {
		rt.renderer.reset();
		rt.redraw();
	});

	// Mount stdin handler; returns a Promise that resolves on quit (never does).
	return mountKeyHandler(rt);
}
