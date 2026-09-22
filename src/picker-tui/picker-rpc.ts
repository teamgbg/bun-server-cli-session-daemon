/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The TUI's only data + action surface. The picker reads sessions/options from
 * the daemon and asks the daemon to spawn — it never touches the DB or tmux
 * for state itself. This is what keeps a single source of truth: the daemon.
 *
 * The daemon URL resolves from the injected SESSION_PICKER_URL env var
 * (the daemon listens on :3021 per service_routing/session-picker).
 */

/**
 * Headers for an operator spawn.
 *
 * PROOF THE OPERATOR IS DRIVING. This per-boot capability authenticates the
 * operator-only `/rpc/spawn` route. Fleet dispatch has a separate route, so a
 * missing or stale value can only refuse this request; it cannot apply fleet
 * eligibility to the operator's selection.
 *
 * Absent token → the picker is bound like any other caller: a visible degrade
 * recovered by a daemon restart, never a fail-open.
 *
 * Built as an explicit record rather than an object literal with a computed
 * spread, because a computed key defeats `HeadersInit`'s overload resolution.
 */

		// The picker TUI runs in the OPERATOR's tmux pane, so TMUX_PANE — when set
		// — is the operator's own pane and the best attribution available: the
		// daemon records it as the tab's `requestedBy`, which
		// the spawn attribution record is resolved from.
		//
		// When it is NOT set, the spawn still has a true and useful identity: the
		// operator, driving the picker. Sending nothing was a real outage — the
		// daemon requires a caller identity and answers 400 without one, so every
		// picker-TUI launch failed with no visible reason while the daemon itself
		// was healthy and serving. The picker is the operator's PRIMARY way of
		// opening a CLI, and it runs without TMUX_PANE whenever it is launched
		// outside an attached pane (the picker home window, a fresh session).
		//
		// The fix is an identity, not an exemption — exactly as the tmux `+` menu
		// sends `operator:tmux-menu`. Restoring a sentinel default inside the route
		// would bring back the unattributable value that requirement exists to
		// remove; naming the real caller here keeps every spawn attributable AND
		// keeps the picker working.

import { getSessionPickerUrl } from "@teamscala/cli-session/session-picker-url";
import {
	OPERATOR_TOKEN_HEADER,
	readOperatorToken,
} from "@teamscala/session-contracts/operator-spawn-token";

async function spawnHeaders(
	lanePane: string | undefined,
): Promise<Record<string, string>> {
	const token = await readOperatorToken();
	if (!token) {
		throw new Error(
			"operator spawn token is unavailable; refresh the picker against the current session-picker process.",
		);
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-requested-by": lanePane ?? "operator:picker-tui",
		[OPERATOR_TOKEN_HEADER]: token,
	};
	if (lanePane) headers["x-lane-pane"] = lanePane;
	return headers;
}
import type { ArchivedSession, LiveSession, MenuOption, SizingInfo } from "./types.ts";

/** Identity of the daemon the picker is talking to (server-reported). */
export interface DaemonInfo {
	version: string;
	pid: number;
	startedAt: string;
}

export interface PickerData {
	live: LiveSession[];
	archived: ArchivedSession[];
	/** Operator-archived (hidden) stored sessions — rendered under a separate
	 * "Archived" group with a restore action. Kept in the DB, excludable. */
	hidden: ArchivedSession[];
	options: MenuOption[];
	daemon: DaemonInfo;
	/** Raw db config row (config:session-picker-config) — merged over the baked
	 * chrome defaults so the picker is db-driven (change row → re-render). */
	configOverride: Record<string, unknown> | null;
	/** Window-sizing state + stale clamping clients (sizing.ts). */
	sizing: SizingInfo;
}

/** Per-attempt timeout for a single fetch. A stuck connection (daemon
 * mid-restart) is abandoned at this boundary so the retry opens a fresh one. */
const PICKER_DATA_ATTEMPT_TIMEOUT_MS = 5_000;
/** Total budget to wait for a transiently-unavailable daemon (a restart, a slow
 * reconcile, a flaky/high-latency link) before concluding it is genuinely down.
 * The daemon is the single source of truth, so "can't reach it for a moment"
 * must read as "still loading" — never as "no sessions" (the empty-page bug). */
const PICKER_DATA_WAIT_MS = 25_000;

/** GET /rpc/picker-data — the single read the picker renders from.
 *
 * RETRIES through transient daemon unavailability so the picker LOADS the list
 * when the daemon comes back instead of rendering empty on the first hiccup —
 * a briefly-unreachable daemon is not "no sessions", it is "not loaded yet".
 * Each attempt has its own timeout so a hung connection is retried fresh; the
 * whole call throws only after `PICKER_DATA_WAIT_MS`, surfacing a genuinely-down
 * daemon (the entry then logs it) rather than silently showing an empty page. */
export async function fetchPickerData(): Promise<PickerData> {
	const startedAt = Date.now();
	let lastErr: unknown;
	let attempt = 0;
	while (Date.now() - startedAt < PICKER_DATA_WAIT_MS) {
		attempt += 1;
		try {
			const res = await fetch(`${getSessionPickerUrl()}/rpc/picker-data`, {
				method: "GET",
				signal: AbortSignal.timeout(PICKER_DATA_ATTEMPT_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`picker-data: daemon returned HTTP ${res.status}`);
			const raw = (await res.json()) as {
				live: LiveSession[];
				archived: Array<{ name: string; tabCount: number; updatedAt: string }>;
				hidden?: Array<{ name: string; tabCount: number; updatedAt: string }>;
				options: MenuOption[];
				daemon?: DaemonInfo;
				configOverride?: Record<string, unknown> | null;
				sizing?: SizingInfo | null;
			};
			const mapArchived = (
				rows: Array<{ name: string; tabCount: number; updatedAt: string }> | undefined,
			) =>
				(rows ?? []).map((a) => ({
					name: a.name,
					tabCount: a.tabCount,
					updatedAt: new Date(a.updatedAt),
				}));
			return {
				live: raw.live ?? [],
				archived: mapArchived(raw.archived),
				hidden: mapArchived(raw.hidden),
				options: raw.options ?? [],
				daemon: raw.daemon ?? { version: "unknown", pid: 0, startedAt: "" },
				configOverride: raw.configOverride ?? null,
				sizing: raw.sizing ?? { windowSize: "unknown", clampingClients: [] },
			};
		} catch (err) {
			// Transient: daemon restarting, slow reconcile, link blip. Back off
			// (restart windows are seconds, not ms) and try again until the budget
			// runs out — then surface the last error as a real failure.
			lastErr = err;
			await new Promise((r) => setTimeout(r, 400 * Math.min(attempt, 5)));
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error("picker-data: daemon unreachable (timed out waiting)");
}

export interface SpawnResult {
	ok: boolean;
	/** Set for tmux_window spawns — the created window's name. */
	windowName?: string;
	/** Set for ops spawns — combined stdout/stderr the view renders. */
	output?: string;
	/** Set for ops spawns — the command's exit code. */
	exitCode?: number;
	error?: string;
}

/** GET /rpc/options — the active session_picker_option rows only (lighter than
 * picker-data; used for live hot-reload of the menu without re-fetching
 * sessions). Throws on an unreachable daemon. */
export async function fetchOptions(): Promise<MenuOption[]> {
	const res = await fetch(`${getSessionPickerUrl()}/rpc/options`, {
		method: "GET",
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`options: daemon returned HTTP ${res.status}`);
	const raw = (await res.json()) as { options?: MenuOption[] };
	return raw.options ?? [];
}

export interface PickerEvent {
	type: "picker.changed";
	source: string;
	slug: string;
}

/** Split complete SSE frames from a streaming text buffer. Exported so chunk
 * boundary handling is pinned without a live daemon in the unit suite. */
export function decodeSseFrames(buffer: string): { data: string[]; rest: string } {
	const normalised = buffer.replaceAll("\r\n", "\n");
	const frames = normalised.split("\n\n");
	const rest = frames.pop() ?? "";
	const data: string[] = [];
	for (const frame of frames) {
		const lines = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		if (lines.length > 0) data.push(lines.join("\n"));
	}
	return { data, rest };
}

function waitForReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, delayMs);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Hold one emission stream open. A database event causes one snapshot read;
 * an idle database causes zero reads. Backoff is used only after a broken
 * transport and is therefore reconnection, not state polling. */
export async function watchPickerEvents(
	signal: AbortSignal,
	onEvent: (event: PickerEvent) => void | Promise<void>,
): Promise<void> {
	let failures = 0;
	while (!signal.aborted) {
		try {
			const res = await fetch(`${getSessionPickerUrl()}/rpc/events`, {
				headers: { Accept: "text/event-stream" },
				signal,
			});
			if (!res.ok || !res.body) throw new Error(`picker events: HTTP ${res.status}`);
			failures = 0;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			while (!signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("picker events: stream closed");
				buffered += decoder.decode(chunk.value, { stream: true });
				const decoded = decodeSseFrames(buffered);
				buffered = decoded.rest;
				for (const data of decoded.data) {
					const event = JSON.parse(data) as PickerEvent;
					if (event.type === "picker.changed") await onEvent(event);
				}
			}
		} catch {
			if (signal.aborted) return;
			failures += 1;
			await waitForReconnect(signal, Math.min(5_000, 250 * 2 ** Math.min(failures - 1, 5)));
		}
	}
}

/** POST /rpc/spawn — the daemon owns the entire spawn (window allocation,
 * seed/resume, slug marker, state write, capture). The TUI just names a slug
 * and a target session. */
export async function spawnOption(slug: string, session: string): Promise<SpawnResult> {
	try {
		const lanePane = process.env.TMUX_PANE ? `tmux:${process.env.TMUX_PANE}` : undefined;
		const res = await fetch(`${getSessionPickerUrl()}/rpc/spawn`, {
			method: "POST",
			headers: await spawnHeaders(lanePane),
			body: JSON.stringify({ slug, session, focus: true }),
			signal: AbortSignal.timeout(15000),
		});
		const body = (await res.json().catch(() => ({}))) as SpawnResult;
		if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
		const { ok: _bodyOk, ...bodyRest } = body;
		return body.ok === false ? { ok: false, error: body.error } : { ok: true, ...bodyRest };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** POST /rpc/restore — the SOLE restore path (boot opens nothing, so restore is
 * never automatic). Ensures the session shell exists, then reopens every
 * recorded tab that isn't currently live, resumed to its conversation. The
 * picker calls this on session-select. Idempotent over already-live tabs, so a
 * no-op on a fully-live session. 30s timeout — reopening many tabs takes time.
 *
 * `ok` is the daemon's RECONCILED verdict: true only when every recorded tab
 * came back fully restored. A partial restore returns `ok:false` plus the
 * NAMED `failed`/`degraded` tabs — the picker surfaces these before attach so
 * the operator cannot mistake a partially-restored session for a complete one. */
export interface RestoreProblem {
	kind: "failed" | "degraded";
	windowName: string;
	slug: string;
	reason: string;
}
export interface RestoreResult {
	ok: boolean;
	restored: Array<{ windowName: string; slug: string }>;
	failed: RestoreProblem[];
	degraded: RestoreProblem[];
	error?: string;
}

export async function restoreSession(session: string): Promise<RestoreResult> {
	try {
		const res = await fetch(`${getSessionPickerUrl()}/rpc/restore`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session }),
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			restored?: Array<{ windowName: string; slug: string }>;
			failed?: RestoreProblem[];
			degraded?: RestoreProblem[];
			error?: string;
		};
		// Carry the named problems through even on a partial/failed response —
		// collapsing them to an empty error would drop the very names the daemon
		// reconciled, reproducing the silent-partial at the client boundary.
		return {
			ok: res.ok && body.ok === true,
			restored: body.restored ?? [],
			failed: body.failed ?? [],
			degraded: body.degraded ?? [],
			error: !res.ok ? (body.error ?? `HTTP ${res.status}`) : body.error,
		};
	} catch (err) {
		return {
			ok: false,
			restored: [],
			failed: [],
			degraded: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Result of an archive / unarchive / delete call against a stored row. */
export interface SessionMutationResult {
	ok: boolean;
	error?: string;
}

/** The lifecycle ops the daemon's mutateSessionRow executor accepts (data). */
export type SessionRowOp = "archive" | "unarchive" | "delete";

/**
 * POST /rpc/mutate-session — the single data-driven mutation surface. The view
 * passes `{ session, op }`; the daemon's executor owns the live-guard and the
 * row write. The view never touches the DB (session-picker-is-one-surface).
 */
export async function mutateSession(
	session: string,
	op: SessionRowOp,
): Promise<SessionMutationResult> {
	try {
		const res = await fetch(`${getSessionPickerUrl()}/rpc/mutate-session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session, op }),
			signal: AbortSignal.timeout(5000),
		});
		const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
		if (!res.ok || body.ok === false) {
			return { ok: false, error: body.error ?? `HTTP ${res.status}` };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
