/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: resolveTabBySessionId, queryArchivedSessions, queryHiddenSessions, querySessionCreationTimes, isSessionLive, isSessionIdle, setSessionArchived, deleteSessionState, mutateSessionRow, scrubStoredCommandSecrets.
 */

export interface SessionIdResolveResult {
	ok: boolean;
	sessionName?: string;
	windowName?: string;
	tabId?: string;
	optionSlug?: string;
	/** Live tmux pane id ("%N") — the fleet's run-to-task link key. */
	paneId?: string;
	/** WHO asked for this tab (the orchestrator that opened the lane), the
	 *  `requestedBy` recorded at spawn (`spawnOptionInSession` requires it). The
	 *  spawn attribution path threads this into the recorded orchestrator identity
	 *  so a run's orchestrator is durably recorded from the row, not only
	 *  reconstructable from an event-log join. */
	requestedBy?: string;
}

// sessionId → tab index, cached briefly (hook events are high-frequency;
// session-picker-rpc-is-cheap). Rebuilt from all session-state rows. The cache
// is the ONLY cache surface (cache-is-the-only-cache) — never a hand-rolled Map.
/** One resolved tab from the session-id index. Named (not inlined three
 *  times) so adding a field is one edit, not three drifting copies. */
interface SessionIdIndexEntry {
	sessionName: string;
	windowName: string;
	tabId?: string;
	optionSlug?: string;
	paneId?: string;
	requestedBy?: string;
}

/**
 * Event-driven, not polled (`no-polling-for-pushable-state`): Postgres fires
 * `pg_notify('registry_config_changed', <slug>)` on every `registry_entries`
 * write, so the daemon is told when a tab changes. The old 2s TTL was the
 * wrong MECHANISM, not a wrong number — measured 2026-07-31: 506,476
 * executions, ~36 GB billed egress (incident: reference/
 * coding-philosophy-incident-depth.md). `staleAfterMs` stays as a
 * missed-notification CEILING (`in-memory-state-is-not-durable`), safe because
 * it is the fallback, not the mechanism.
 */

// Lazy, process-stable holder (the configured-primitives accessor shape).
// createNotifyCache REGISTERS process-globally and duplicate names throw, so
// module-scope construction made this file's EVALUATION a process-global side
// effect: bun evaluates once per distinct specifier (plain import + a
// `?subject` copy in close-window.test), and the second eval aborted — exports
// never bound, every later importer died with "Export not found". First-use
// construction makes evaluation side-effect-free; two copies that both
// construct still throw, the honest duplicate-instance signal.
let _sessionIdIndex: ReturnType<typeof createNotifyCache<Map<string, SessionIdIndexEntry>>> | null =
	null;
function sessionIdIndex(): ReturnType<typeof createNotifyCache<Map<string, SessionIdIndexEntry>>> {
	_sessionIdIndex ??= createNotifyCache<Map<string, SessionIdIndexEntry>>({
		name: "session-picker:session-id-index",
		invalidateOn: ["registry_config_changed"],
		staleAfterMs: 60_000,
		load: () => buildSessionIdIndex(),
	});
	return _sessionIdIndex;
}

/**
 * Change-detection state for the probe below. Module-scoped so it outlives the
 * 2s cache entry it exists to spare — the question is whether the rows changed
 * since the LAST build, which is only meaningful across that expiry.
 */
let _idxFingerprint: string | null = null;
let _idxValue: Map<string, SessionIdIndexEntry> | null = null;

async function buildSessionIdIndex(): Promise<Map<string, SessionIdIndexEntry>> {
	// Cheap change-detection before the bulk read (`db-bytes-are-a-budget`).
	// `xmin` is the system column holding the transaction id that last inserted
	// or updated each row, so it moves on EVERY write. `max(updated_at)` would
	// not be safe: registry_entries has only a column DEFAULT and no updated_at
	// trigger, so a writer omitting it leaves the timestamp stale — and a stale
	// pane index is exactly the bug this cache exists to prevent. count(*) covers
	// deletes. Both aggregate server-side, returning ~45 bytes instead of ~71kB.
	// Probe failure falls through to the full read: this index backs fleet pane
	// resolution, so it must degrade to expensive, never to wrong or missing.
	try {
		const fp = await getPrisma().$queryRaw<Array<{ n: bigint; fp: string | null }>>`
			SELECT count(*) AS n,
			       md5(string_agg(id::text || ':' || xmin::text, ',' ORDER BY id)) AS fp
			FROM registry_entries
			WHERE type = 'config' AND slug LIKE 'session-state-%'`;
		const next = `${fp[0]?.n ?? 0n}:${fp[0]?.fp ?? ""}`;
		if (_idxValue !== null && next === _idxFingerprint) return _idxValue;
		_idxFingerprint = next;
	} catch {
		_idxFingerprint = null;
	}

	const rows = await getPrisma().registry_entries.findMany({
		where: { type: "config", slug: { startsWith: "session-state-" } },
		select: { slug: true, config: true },
	});
	const map = new Map<string, SessionIdIndexEntry>();
	// Project-keyed suffixes carry the owning developer project's id, not a tmux
	// name; the fleet needs the LIVE session name — resolved once per build via
	// the seat bridge rather than sliced out of the slug.
	const seats = await loadDeveloperSeatMap().catch(() => []);
	for (const row of rows) {
		const sessionName = row.slug.startsWith("session-state-")
			? displayNameForSuffix(row.slug.slice("session-state-".length), seats)
			: row.slug;
		const parsed = v.safeParse(SessionStateConfigSchema, row.config);
		if (!parsed.success) continue;
		for (const t of normaliseTabs(parsed.output.tabs ?? [])) {
			if (t.sessionId) {
				map.set(t.sessionId, {
					sessionName,
					windowName: t.windowName,
					tabId: t.tabId ?? undefined,
					optionSlug: t.optionSlug ?? undefined,
					// The live tmux pane id ("%N"). The fleet needs it to link an
					// adopted lane's run row to its work_items task; without it that
					// link matches zero rows and every dashboard card reads
					// "Task none".
					paneId: t.paneId ?? undefined,
					// The orchestrator that opened this lane, so the attribution record can
					// record it durably. Absent only on legacy tabs predating the
					// spawn-time recording — the fleet path then carries an explicit
					// sentinel rather than NULL.
					requestedBy: t.requestedBy ?? undefined,
				});
			}
		}
	}
	_idxValue = map;
	return map;
}

/**
 * Resolve a Claude/AI-CLI session id (the seeded --session-id) to its live tmux
 * tab identity — the work-name (windowName) the fleet lane-visibility hook
 * handler needs at event time (lanes-named-by-the-spawner: resolved fresh, never
 * baked into the hook). Returns { ok: false } when no open tab carries the id.
 */
export async function resolveTabBySessionId(
	sessionId: string,
): Promise<SessionIdResolveResult> {
	if (!sessionId) return { ok: false };
	// notify-cache owns the loader (declared at construction), so there is no
	// per-call key or compute callback — get() serves the current value and
	// rehydrates on NOTIFY rather than on a timer.
	const index = await sessionIdIndex().get();
	const hit = index.get(sessionId);
	if (!hit) return { ok: false };
	return { ok: true, ...hit };
}

export async function queryArchivedSessions(
	retentionDays: number,
): Promise<Array<{ name: string; tabCount: number; updatedAt: Date }>> {
	if (retentionDays <= 0) return [];
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const rows = await getPrisma().registry_entries.findMany({
		where: {
			type: "config",
			slug: { startsWith: "session-state-" },
			updated_at: { gte: cutoff },
		},
		select: { slug: true, config: true, updated_at: true },
		orderBy: { created_at: "desc" },
	});
	const seats = await loadDeveloperSeatMap().catch(() => []);
	const result: Array<{ name: string; tabCount: number; updatedAt: Date }> = [];
	for (const row of rows) {
		const name = row.slug.startsWith("session-state-")
			? displayNameForSuffix(row.slug.slice("session-state-".length), seats)
			: row.slug;
		const parsed = v.safeParse(SessionStateConfigSchema, row.config);
		// Hidden (archived) rows are surfaced via queryHiddenSessions, not here.
		if (parsed.success && parsed.output.archived) continue;
		const tabCount = parsed.success ? parsed.output.tabs.length : 0;
		result.push({ name, tabCount, updatedAt: row.updated_at });
	}
	return result;
}

/**
 * Operator-archived (hidden) session rows — kept in the DB but excluded from the
 * picker's "Recent" list and surfaced under a separate "Archived" group with a
 * restore action. No retention cutoff: an explicitly-archived row stays until
 * the operator unarchives or deletes it.
 */
export async function queryHiddenSessions(): Promise<
	Array<{ name: string; tabCount: number; updatedAt: Date }>
> {
	const rows = await getPrisma().registry_entries.findMany({
		where: { type: "config", slug: { startsWith: "session-state-" } },
		select: { slug: true, config: true, updated_at: true },
		orderBy: { created_at: "desc" },
	});
	const seats = await loadDeveloperSeatMap().catch(() => []);
	const result: Array<{ name: string; tabCount: number; updatedAt: Date }> = [];
	for (const row of rows) {
		const parsed = v.safeParse(SessionStateConfigSchema, row.config);
		if (!parsed.success || !parsed.output.archived) continue;
		const name = displayNameForSuffix(row.slug.slice("session-state-".length), seats);
		result.push({ name, tabCount: parsed.output.tabs.length, updatedAt: row.updated_at });
	}
	return result;
}

/**
 * Map of tmux-session-name → the row's true creation time (DB `created_at`).
 * tmux's `session_created` resets whenever the daemon reopens a detached session
 * on boot, so it can't be trusted for "when did the operator create this". The
 * row's `created_at` (first insert) is the durable original creation date.
 */
export async function querySessionCreationTimes(): Promise<Map<string, Date>> {
	const rows = await getPrisma().registry_entries.findMany({
		where: { type: "config", slug: { startsWith: "session-state-" } },
		select: { slug: true, created_at: true },
	});
	const seats = await loadDeveloperSeatMap().catch(() => []);
	const map = new Map<string, Date>();
	for (const row of rows) {
		map.set(
			displayNameForSuffix(row.slug.slice("session-state-".length), seats),
			row.created_at,
		);
	}
	return map;
}

/** True when a tmux server currently has this session. */
export function isSessionLive(tmuxSession: string): boolean {
	return run(["has-session", "-t", tmuxSession]).exitCode === 0;
}

/** Best-effort `tmux kill-session`. No throw on a dead/missing session — the
 * caller (delete) proceeds to drop the row regardless. */
function killTmuxSession(tmuxSession: string): void {
	run(["kill-session", "-t", tmuxSession]);
}

/** A live session is IDLE when it has no tracked CLI tabs and at most its single
 * home window (a bare shell, or the picker launcher) — i.e. nothing doing real
 * work, the session is just keeping itself alive. Such a session is safe to
 * archive (close + hide). A session with real running tabs is NOT idle. */
export async function isSessionIdle(tmuxSession: string): Promise<boolean> {
	if (!isSessionLive(tmuxSession)) return false;
	const state = await loadSessionState(tmuxSession);
	if (normaliseTabs(state.tabs).length > 0) return false;
	return listWindows(tmuxSession).length <= 1;
}

/**
 * Flip the operator-set archived (hidden) flag on a session-state row. No-op
 * (returns found:false) when no row exists — there is nothing to hide. Refuses
 * to hide a LIVE session is the caller's job (the route guards on isSessionLive);
 * the flag flip itself is just a row write that preserves tabs + closedTabs.
 */
export async function setSessionArchived(
	tmuxSession: string,
	archived: boolean,
): Promise<{ found: boolean }> {
	const existing = await getPrisma().registry_entries.findFirst({
		where: { type: "config", slug: await sessionStateRowKey(tmuxSession) },
		select: { config: true },
	});
	if (!existing) return { found: false };
	const parsed = v.safeParse(SessionStateConfigSchema, existing.config);
	const state = parsed.success ? parsed.output : { tabs: [] };
	await saveSessionState(tmuxSession, {
		tabs: state.tabs,
		closedTabs: state.closedTabs,
		archived,
	});
	return { found: true };
}

/** Permanently remove a session-state row. Idempotent (deleted:false if absent). */
export async function deleteSessionState(tmuxSession: string): Promise<{ deleted: boolean }> {
	const r = await getPrisma().registry_entries.deleteMany({
		where: { type: "config", slug: await sessionStateRowKey(tmuxSession) },
	});
	return { deleted: r.count > 0 };
}

/** The set of lifecycle mutations an operator can apply to a stored session row.
 * Data — the daemon's `mutateSessionRow` executor is the single dispatch path. */
export type SessionRowMutation =
	| { op: "archive" }
	| { op: "unarchive" }
	| { op: "delete" };

export interface SessionRowMutationResult {
	ok: boolean;
	/** archive/unarchive: whether a stored row existed to act on. */
	found?: boolean;
	/** delete: whether a row was actually removed. */
	deleted?: boolean;
	error?: string;
}

/**
 * The single executor for session-row lifecycle mutations. `op` is DATA; this
 * function is the one dispatch path — the live-guard (never interrupt a running
 * session), the flag-flip / row-delete, and the row-preserving write all live
 * here. The daemon's `/rpc/mutate-session` is a thin transport over this, and
 * the stateless picker is the only caller (session-picker-is-one-surface).
 * archive + delete refuse a LIVE tmux session (kill it first); unarchive is
 * harmless on a live row and ungated.
 */
export async function mutateSessionRow(
	tmuxSession: string,
	mutation: SessionRowMutation,
): Promise<SessionRowMutationResult> {
	// Archive hides a stored row. A RUNNING session is archivable only if IDLE —
	// no real CLI tabs, at most its single home window (a bare shell or the
	// picker launcher) just keeping the session alive. Archive closes (kills) it
	// and hides its row. A session with running tabs is refused: don't kill real
	// work through archive (delete asks for a confirm instead).
	if (mutation.op === "archive") {
		if (isSessionLive(tmuxSession)) {
			if (!(await isSessionIdle(tmuxSession))) {
				return {
					ok: false,
					error: `'${tmuxSession}' has running tabs — close them first, or Del to kill+delete`,
				};
			}
			killTmuxSession(tmuxSession);
		}
		const r = await setSessionArchived(tmuxSession, true);
		return { ok: true, found: r.found };
	}
	// Delete removes the row. On a RUNNING session it kills the tmux session
	// first (best-effort) then drops the row — the picker's y/n confirm is the
	// guard against accidental interruption. The picker runs outside tmux, so
	// the operator is never deleting the session they are inside.
	if (mutation.op === "delete") {
		if (isSessionLive(tmuxSession)) killTmuxSession(tmuxSession);
		const r = await deleteSessionState(tmuxSession);
		return { ok: true, deleted: r.deleted };
	}
	// unarchive
	const r = await setSessionArchived(tmuxSession, false);
	return { ok: true, found: r.found };
}

/**
 * Boot-time + self-healing scrub: rewrite every stored `command` on
 * session-state rows (tabs[] AND closedTabs[]) back to the owning option's
 * command TEMPLATE. THE LEAK THIS CLOSES: the row is type `config`, NOT
 * `secret`, so a stored materialised command (secret_env inlined) leaked in
 * cleartext via `/rpc/closed-tabs` (2026-08-01, incident: reference/
 * coding-philosophy-incident-depth.md). `command` is INFORMATIONAL ONLY (replay
 * uses `sessionId`); spawn/reconcile now store templates; this heals old rows.
 */
