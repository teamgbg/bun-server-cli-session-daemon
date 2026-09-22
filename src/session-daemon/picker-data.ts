/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Single server-side gather for the rich picker TUI. The TUI is a stateless
 * view: it never queries tmux or the DB itself (that would be a second source
 * of truth). It calls GET /rpc/picker-data once and renders whatever this
 * returns. Every datum the SCALA-DEV session page and the CLI picker need —
 * live tmux sessions, recently-archived sessions, and the launchable options —
 * is gathered here, in the daemon, the one place that owns truth.
 */

import { join } from "node:path";
import { createCache } from "@teamscala/cache/create-cache";
import { run } from "@teamscala/tmux-session/command-runner";
import { buildSizingInfo, type SizingInfo } from "./sizing.ts";
import type { MenuOption  } from "./types.ts";
import { queryActiveOptions, queryPickerConfigOverride } from "./query-options.ts";
import { queryArchivedSessions, queryHiddenSessions, querySessionCreationTimes } from "./resolve-and-query.ts";
// Read ONCE at module load (daemon boot), never per-request: a daemon left
// running on old code after an install reports its TRUE running version here,
// so the picker can show `daemon v<old>` next to `picker v<new>` and the
// version mismatch makes "the daemon needs a restart" visible at a glance.
const DAEMON_VERSION: string = await Bun.file(join(import.meta.dir, "../../package.json"))
	.json()
	.then((pkg: { version?: string }) => pkg.version ?? "unknown")
	.catch(() => "unknown");
const DAEMON_PID = process.pid;
const DAEMON_STARTED_AT = new Date().toISOString();

// The two DB reads dominate the RPC's cost (~200ms each over the Railway
// proxy; a 470ms picker-data was the measured 2026-06-06 baseline, per
// session-picker-rpc-is-cheap). Options are near-static registry config;
// archived sessions change only on reconcile writes — short TTLs keep both
// warm between events while staying fresh enough for the picker UI. The live
// tmux list stays uncached (one ~5ms local spawn, and it's the truth source).
const archivedCache = createCache<Awaited<ReturnType<typeof queryArchivedSessions>>>(
	"cli-session:picker-archived",
	{ ttlMs: 5_000, maxSize: 100, stampedeProtection: true },
);
// Operator-archived (hidden) sessions — change only on archive/unarchive/delete
// writes, so a short TTL keeps the picker fresh after a mutation invalidates.
const hiddenCache = createCache<Awaited<ReturnType<typeof queryHiddenSessions>>>(
	"cli-session:picker-hidden",
	{ ttlMs: 5_000, maxSize: 100, stampedeProtection: true },
);
// session-name -> true creation time (row created_at). Used to order the LIVE
// list by original creation, since tmux session_created resets whenever a
// session is reopened (restore-on-select / reattach).
const creationCache = createCache<Awaited<ReturnType<typeof querySessionCreationTimes>>>(
	"cli-session:picker-creation",
	{ ttlMs: 5_000, maxSize: 100, stampedeProtection: true },
);
const optionsCache = createCache<MenuOption[]>("cli-session:picker-options", {
	ttlMs: 30_000, maxSize: 100,
	stampedeProtection: true,
});
// Picker chrome config is near-static registry config; short TTL keeps a DB
// edit visible on the next picker render (the db-driven re-render path).
const configCache = createCache<Record<string, unknown> | null>("cli-session:picker-config", {
	ttlMs: 10_000, maxSize: 4, stampedeProtection: true,
});

/** Reconcile/spawn writes call this so the next picker-data read is fresh. */
export function invalidatePickerCaches(): void {
	archivedCache.flush();
	hiddenCache.flush();
	creationCache.flush();
	optionsCache.flush();
	configCache.flush();
}

/** Active options, served through the shared 30s-TTL cache so BOTH gatherPickerData
 * and the standalone /rpc/options endpoint are cheap by construction — never a
 * per-request DB round-trip (session-picker-rpc-is-cheap). The uncached
 * /rpc/options was the fuel for the poll-storm pile-up: every open picker home
 * window polls it every 4s, and uncached each poll was a ~200ms proxy DB hit
 * that queued unbounded under any latency blip (108 concurrent × ~200ms ≈ 20s). */
export async function getCachedActiveOptions(): Promise<MenuOption[]> {
	return optionsCache.fetchOrCompute("active", () => queryActiveOptions());
}

export interface LivePickerSession {
	name: string;
	windows: number;
	attached: boolean;
	/** Attached tmux clients (the devices currently viewing this session).
	 * Empty iff detached. Carries tty + WxH + last-activity so the picker can
	 * show WHICH device is attached (e.g. "pts/0 105x87") not just that
	 * something is. */
	clients: AttachedClient[];
}

/** One attached tmux client — a device currently viewing a session. */
export interface AttachedClient {
	/** tmux `client_name` (often the tty path or a tmux-assigned label). */
	name: string;
	/** `client_tty` — the terminal device path (the device identity). */
	tty: string;
	/** `client_width` (columns). */
	width: number;
	/** `client_height` (rows). */
	height: number;
	/** `client_activity` — epoch seconds of last input on this client. */
	activity: number;
}

/**
 * Pure parser for `tmux list-clients -F` output, grouped by session. Extracted
 * so the parsing is unit-testable independent of the tmux spawn. Each line:
 * `#{client_session}|#{client_name}|#{client_tty}|#{client_width}|#{client_height}|#{client_activity}`.
 * Lines with no session (a detached client has none) are dropped — only
 * session-attached clients are relevant to the picker.
 */
export function parseClients(raw: string): Map<string, AttachedClient[]> {
	const bySession = new Map<string, AttachedClient[]>();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [session, name, tty, width, height, activity] = trimmed.split("|");
		const sessionName = (session ?? "").trim();
		if (!sessionName) continue;
		const client: AttachedClient = {
			name: (name ?? "").trim(),
			tty: (tty ?? "").trim(),
			width: Number(width ?? 0),
			height: Number(height ?? 0),
			activity: Number(activity ?? 0),
		};
		const list = bySession.get(sessionName) ?? [];
		list.push(client);
		bySession.set(sessionName, list);
	}
	return bySession;
}

/** Compact one-line device summary shared by every view that renders an
 * attached session — the canonical formatter so the TUI, the tmux `+` menu,
 * and any future surface show devices identically. Each client as
 * `tty-basename WxH` (e.g. "pts/0 105x87"), capped at `max` shown + "+N". */
export function formatClientsCompact(clients: AttachedClient[], max = 2): string {
	if (clients.length === 0) return "";
	const shown = clients.slice(0, max).map((c) => {
		const tty = c.tty.replace(/^\/dev\//, "") || c.name;
		return `${tty} ${c.width}x${c.height}`;
	});
	const extra = clients.length > max ? `, +${clients.length - max}` : "";
	return `${shown.join(", ")}${extra}`;
}

export interface ArchivedPickerSession {
	name: string;
	tabCount: number;
	/** ISO-8601 — serialised for JSON transport; the view renders relative age. */
	updatedAt: string;
	/** True when this entry is a `permanent_sessions` name (config). Permanent
	 * sessions always appear in the restorable list and are never hidden or
	 * aged out — the view may badge them (e.g. "pinned") instead of an age. */
	permanent?: boolean;
}

/**
 * Guarantee every permanent session (`session-picker-config.permanent_sessions`)
 * stays on the list. A permanent name currently LIVE is shown under `live` and
 * skipped here. One not live is ensured present in the restorable (`archived`)
 * list and marked `permanent`, so it can never drop off from history retention,
 * an emptied `tabs[]`, or a missing row. A permanent name the operator archived
 * (in `hidden`) is pulled back into the visible list — permanent overrides hide.
 * Missing names are injected with a fresh timestamp so the view renders them as
 * current, not "archived 56y ago". Pure (now injectable) for unit testing.
 */
export function applyPermanentSessions(
	archived: ArchivedPickerSession[],
	hidden: ArchivedPickerSession[],
	liveNames: Set<string>,
	permanentNames: readonly string[],
	now: Date = new Date(),
): { archived: ArchivedPickerSession[]; hidden: ArchivedPickerSession[] } {
	const perm = (name: string): boolean => permanentNames.includes(name);
	// Permanent sessions are never hidden — surface them in the main list.
	const hiddenOut = hidden.filter((h) => !perm(h.name));
	const archivedOut = archived.map((a) => (perm(a.name) ? { ...a, permanent: true } : a));
	for (const h of hidden) {
		if (perm(h.name) && !liveNames.has(h.name)) archivedOut.push({ ...h, permanent: true });
	}
	const present = new Set(archivedOut.map((a) => a.name));
	for (const name of permanentNames) {
		if (liveNames.has(name) || present.has(name)) continue;
		archivedOut.push({ name, tabCount: 0, updatedAt: now.toISOString(), permanent: true });
		present.add(name);
	}
	return { archived: archivedOut, hidden: hiddenOut };
}

/** Identity of the running daemon, surfaced so the picker can display which
 * daemon (version + pid) it is actually talking to — the troubleshooting line. */
export interface DaemonInfo {
	version: string;
	pid: number;
	startedAt: string;
}

function getDaemonInfo(): DaemonInfo {
	return { version: DAEMON_VERSION, pid: DAEMON_PID, startedAt: DAEMON_STARTED_AT };
}

export interface PickerData {
	live: LivePickerSession[];
	archived: ArchivedPickerSession[];
	/** Operator-archived (hidden) sessions — kept in the DB but excluded from
	 * `archived` (the "Recent" list) and rendered under a separate group with a
	 * restore action. The view offers archive/delete/unarchive on these. */
	hidden: ArchivedPickerSession[];
	options: MenuOption[];
	daemon: DaemonInfo;
	/** Raw `config:session-picker-config` row (or null). The view merges this
	 * over its baked chrome defaults — the db-driven re-render surface. */
	configOverride: Record<string, unknown> | null;
	/** Window-sizing state: current `window-size` + any stale size-clamping
	 * clients the operator should detach. The daemon keeps `window-size=latest`
	 * so the active device is never clamped (sizing.ts). */
	sizing: SizingInfo;
}

/** Live tmux sessions, read from the tmux server (the authority for what is
 * currently running). UNSORTED — the row's true creation date (which survives
 * session reopens) is folded in by `gatherPickerData`, since tmux's session_created
 * resets whenever the daemon reopens a detached session. Returns [] when no
 * server / no sessions. Carries `created` (tmux seconds) as the fallback key. */
function listLiveSessions(): Array<{ name: string; windows: number; attached: boolean; created: number }> {
	const r = run(["list-sessions", "-F", "#{session_created}|#{session_name}|#{session_windows}|#{session_attached}"]);
	if (r.exitCode !== 0) return [];
	return r.stdout
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [created, name, windows, attached] = line.split("|");
			return {
				created: Number(created ?? 0),
				name: name ?? "",
				windows: Number(windows ?? 0),
				attached: Number(attached ?? 0) > 0,
			};
		})
		.filter((s) => s.name.length > 0);
}

/** Attached clients grouped by session name — the devices currently viewing
 * each live session. One ~5ms local spawn, uncached (same class as
 * list-sessions — both stay truth-source per session-picker-rpc-is-cheap). */
function listAttachedClients(): Map<string, AttachedClient[]> {
	const r = run([
		"list-clients",
		"-F",
		"#{client_session}|#{client_name}|#{client_tty}|#{client_width}|#{client_height}|#{client_activity}",
	]);
	if (r.exitCode !== 0) return new Map();
	return parseClients(r.stdout.toString());
}

/**
 * Gather everything the picker TUI renders. Archived sessions that are
 * currently live are dropped from the archived list (they belong under "live").
 */
export async function gatherPickerData(retentionDays = 7): Promise<PickerData> {
	const rawLive = listLiveSessions();
	const clientsBySession = listAttachedClients();
	const liveNames = new Set(rawLive.map((s) => s.name));

	// Order the LIVE list by TRUE creation date (row created_at), falling back to tmux session_created only for sessions with no row yet. tmux's clock resets
	// when a session is reopened (restore-on-select), so without this a session
	// created weeks ago that was reopened today would sort as if just created.
	// The five reads below (creation times, archived, hidden, options, config)
	// are INDEPENDENT — run them wave-parallel, not serial (loading-shape). The
	// cold path was 5 sequential awaits each paying a ~200ms proxy-DB round-trip,
	// stacking to ~1.2s; parallel cuts it to the single slowest (~200ms) so a
	// cold picker-data stays within session-picker-rpc-is-cheap's <hundreds-ms
	// budget. Each is best-effort (.catch fallback): a DB hiccup in one must not
	// blank the others or the live list.
	const [creationTimes, archivedRows, hiddenRows, options, configOverride] = await Promise.all([
		creationCache.fetchOrCompute("all", () => querySessionCreationTimes()).catch(
			// best-effort — fall back to tmux session_created for ordering
			() => new Map<string, Date>(),
		),
		archivedCache
			.fetchOrCompute(`days:${retentionDays}`, () => queryArchivedSessions(retentionDays))
			// History is best-effort; a DB hiccup must not blank the live list.
			.catch(() => [] as Awaited<ReturnType<typeof queryArchivedSessions>>),
		hiddenCache
			.fetchOrCompute("all", () => queryHiddenSessions())
			.catch(() => [] as Awaited<ReturnType<typeof queryHiddenSessions>>),
		getCachedActiveOptions().catch(() => [] as MenuOption[]),
		configCache.fetchOrCompute("row", () => queryPickerConfigOverride()).catch(() => null),
	]);
	const creationTimesMap = creationTimes instanceof Map ? creationTimes : new Map<string, Date>();
	const creationScore = (name: string, tmuxCreated: number): number => {
		const t = creationTimesMap.get(name);
		return t ? t.getTime() : tmuxCreated * 1000;
	};
	const live: LivePickerSession[] = rawLive
		.slice()
		.sort((a, b) => creationScore(b.name, b.created) - creationScore(a.name, a.created))
		.map(({ name, windows, attached }) => ({
			name,
			windows,
			attached,
			clients: attached ? (clientsBySession.get(name) ?? []) : [],
		}));

	// Defensive coerce: hiddenRows/archivedRows come from
	// cache.fetchOrCompute(...).catch(() => []) — typed as arrays, but a stale
	// or edge cache value (or a future compute returning a non-array) must not
	// 500 the whole picker (observed: `hiddenRows.filter is not a function`).
	const archivedRowsArr = Array.isArray(archivedRows) ? archivedRows : [];
	const hiddenRowsArr = Array.isArray(hiddenRows) ? hiddenRows : [];
	const archived: ArchivedPickerSession[] = archivedRowsArr
		.filter((a) => !liveNames.has(a.name))
		.map((a) => ({ name: a.name, tabCount: a.tabCount, updatedAt: a.updatedAt.toISOString() }));
	const hidden: ArchivedPickerSession[] = hiddenRowsArr
		.filter((a) => !liveNames.has(a.name))
		.map((a) => ({ name: a.name, tabCount: a.tabCount, updatedAt: a.updatedAt.toISOString() }));

	// Sizing: scan every attached client for stale size-clamping ones (the
	// window-size value itself is a cheap uncached show-options, same class as
	// list-sessions — both truth-source per session-picker-rpc-is-cheap).
	const allClients = Array.from(clientsBySession.values()).flat();
	const sizing = buildSizingInfo(allClients);

	// Pin the operator's permanent sessions onto the list — they must never drop
	// off (missing row, emptied tabs, aged out, or operator-hidden).
	const permanentNames = Array.isArray(
		(configOverride as { permanent_sessions?: unknown } | null)?.permanent_sessions,
	)
		? ((configOverride as { permanent_sessions: unknown[] }).permanent_sessions.filter(
				(n): n is string => typeof n === "string",
			))
		: [];
	const pinned = applyPermanentSessions(archived, hidden, liveNames, permanentNames);

	return {
		live,
		archived: pinned.archived,
		hidden: pinned.hidden,
		options,
		daemon: getDaemonInfo(),
		configOverride,
		sizing,
	};
}
