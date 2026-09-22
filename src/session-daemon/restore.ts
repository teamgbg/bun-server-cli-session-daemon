/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * restoreSession — reopens crash-lost OPEN tabs and a named CLOSED archive tab, deduped by windowName.
 */


/**
 * Restore a session's recorded tabs — reopen every tab whose window is NOT
 * currently live, resumed to its conversation (`resume.replay`) and KEPT AT ITS
 * STORED NAME (SCM, DB Theming, …). Two sources, deduped by windowName by
 * `selectRestoreCandidates`:
 *   - dead OPEN tabs — tabs[] entries whose window vanished (the hard-reboot
 *     case the churn-guard preserves but that the old closed-only restore could
 *     never reach — the gap that stranded every crash-lost session);
 *   - CLOSED archive tabs — deliberately-closed panes the operator reopens.
 * `windowName` filters to one tab; omitted restores the whole session. Restored
 * dead-open entries are dropped from tabs[] (the fresh spawn re-adds them with a
 * live windowId); restored closed entries are dropped from closedTabs. This is
 * the engine behind the SOLE restore path (`POST /rpc/restore`), triggered by
 * the picker's session-select action — boot opens nothing, so restore is never
 * automatic.
 */
/** How far before the current boot a closedAt still counts as a reboot victim.
 * Shutdown-to-kernel-boot on this host is 1–3 min; 10 min absorbs a slow stop
 * while staying far narrower than the whole closed archive (over-restore risk
 * is a few extra tabs, under-restore risk is a lost session — err to reopen). */

import { uptime as osUptime } from "node:os";
import { spawn } from "@teamscala/os/spawn/spawn";
import { userHome } from "@teamscala/os/host-paths";
import {
	firstPaneIdForWindow,
	listWindows,
	newWindow,
	paneCurrentPath,
	setOptionSlugMarker,
	windowExists,
} from "@teamscala/tmux-session/windows";
import { recordEvent } from "@teamscala/event-log/record-event";
import { getAppLogger } from "@teamscala/logger/app-loggers";
import { startChannelDaemonDetached } from "./channel-daemon.ts";
import { captureProducedTurn, deliverInitialPrompt } from "./prompt-delivery.ts";
import { cliKindForGroup } from "./cli-kind.ts";
import { runtimeTuningPrefix } from "./runtime-tuning-env.ts";
import { secretEnvPrefix } from "./secret-env.ts";
import { SERVICE_IDENTITY_VARS } from "./tmux-env-hygiene.ts";
import {
	extractLaunchPaths,
	findMissingBinaries,
	formatPreflightError,
} from "./spawn-preflight.ts";
import { assertFleetSpawnable } from "./spawn-runtime-policy.ts";
import { loadSessionState, saveSessionState } from "./load-save.ts";
import { queryActiveOptions } from "./query-options.ts";
import { closeWindowForPane } from "./rename-close.ts";
import {
	absentNamedRestoreOutcome,
	createTabId,
	findLiveIdempotentTab,
	normaliseTabs,
	reconcileRestore,
	selectRestoreCandidates,
	type RestoreOutcome,
	type RestoreSpawnOutcome,
} from "./state-tabs.ts";
import type { MenuOption } from "./types.ts";
import { spawnOps } from "./spawn-ops.ts";
import { registerCliSession } from "./register-cli-session.ts";

const REBOOT_CLOSE_WINDOW_MS = 10 * 60 * 1000;

/** The [fromMs, toMs] epoch window of "closed by the last shutdown": the final
 * REBOOT_CLOSE_WINDOW_MS before the current kernel boot (`os.uptime()`). */
function rebootClosedWindow(): { fromMs: number; toMs: number } | null {
	const uptimeSec = osUptime();
	if (!Number.isFinite(uptimeSec) || uptimeSec <= 0) return null;
	const bootMs = Date.now() - uptimeSec * 1000;
	return { fromMs: bootMs - REBOOT_CLOSE_WINDOW_MS, toMs: bootMs };
}

export async function restoreSession(
	tmuxSession: string,
	opts: { windowName?: string } = {},
): Promise<RestoreOutcome> {
	const state = await loadSessionState(tmuxSession);
	const live = listWindows(tmuxSession).map((w) => ({ id: w.id, name: w.name }));
	const candidates = selectRestoreCandidates(state.tabs, state.closedTabs ?? [], live, {
		filterWindowName: opts.windowName,
		// A full-session restore reopens only crash-lost OPEN tabs; a named
		// request may also reach into the closed archive to reopen one tab.
		includeClosed: Boolean(opts.windowName),
		// Tabs archived in the final minutes BEFORE this boot were closed by the
		// shutdown itself, not by the operator — a graceful reboot closes windows
		// one at a time, so reconcile archives them and tabs[] ends empty. Treat
		// them as crash-lost so a plain restore actually brings the session back.
		rebootClosedWindow: rebootClosedWindow(),
	});

	// A NAMED restore that found the tab NOWHERE must say so — never return the
	// silent `{ok:true, restored:[], degraded:[], failed:[]}` that is
	// indistinguishable from success (2026-08-01: five such restores reported ok
	// while restoring nothing and naming no reason). A genuinely-absent name is a
	// populated `failed[]`; a name that is already live proceeds normally. This
	// is `a-component-may-not-report-a-state-it-has-not-verified` applied to the
	// restore response, and it is emitted durably so the verdict survives even if
	// the HTTP response is missed.
	const absent = absentNamedRestoreOutcome(opts.windowName, candidates, live, tmuxSession);
	if (absent) {
		getAppLogger().warn("rpc/restore: requested tab not found anywhere", {
			session: tmuxSession,
			windowName: opts.windowName,
		});
		recordEvent({
			kind: "cli-session.restore.absent",
			payload: { session: tmuxSession, windowName: opts.windowName },
		});
		return absent;
	}

	// Per-candidate spawn outcome, keyed by windowName. This is the ONLY in-
	// process structure here, and it is safe because it is consumed within this
	// same call by `reconcileRestore` against a freshly re-read live window set —
	// it never survives a restart and never gates a decision alone (the live
	// re-read is the durable fact). The prior shape trusted a `restored[]` built
	// from non-throwing spawns and returned it as success; that is the silent-
	// partial this closes (a spawned-then-died window read as restored).
	const outcomes = new Map<string, RestoreSpawnOutcome>();
	for (const c of candidates) {
		try {
			const result = await spawnOptionInSession(c.optionSlug, tmuxSession, {
				focus: false,
				resumeId: c.sessionId ?? undefined,
				windowName: c.windowName,
				// Pass the original cwd so the CLI starts in the directory where
				// the session was created — critical for cross-slug resume where
				// the new option's cwd may differ from the original session's.
				cwd: c.cwd ?? undefined,
				// A restore is the daemon reopening a tab the operator asked for,
				// so the requester IS the restore path — naming it beats inheriting
				// the original spawn's requester, which would misattribute the
				// reopen to whoever happened to open it the first time.
				requestedBy: "restore",
			});
			outcomes.set(c.windowName, { resumed: result.resumed === true });
		} catch (err) {
			outcomes.set(c.windowName, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// RE-READ live windows AFTER spawning — the durable fact that each
	// candidate's window actually came up AND survived. This is the
	// reconciliation the prior {restored,skipped} return skipped: it trusted an
	// in-memory list of "what didn't throw", so a window that spawned-then-died
	// (CLI crashed after the probe, remain-on-exit off) read as restored while
	// the operator saw no pane. `liveness-by-capability-not-process-existence`:
	// a tab is restored when its window is live, not when a spawn returned ok.
	const liveAfter = listWindows(tmuxSession).map((w) => ({ id: w.id, name: w.name }));
	const outcome = reconcileRestore(candidates, liveAfter, outcomes);

	if (!outcome.ok) {
		// FAIL LOUD: a partial restore is named at every surface — the response
		// body (ok:false + named failed/degraded), the daemon log, and a durable
	// event_log row. Omitting any of these lets the operator read a populated
		// screen as a complete session. The event kind is queryable through
		// query_logs / event_log so the names survive even if the response is
		// missed.
		getAppLogger().warn("rpc/restore partial — not every tab came back", {
			session: tmuxSession,
			failed: outcome.failed,
			degraded: outcome.degraded,
		});
		recordEvent({
			kind: "cli-session.restore.partial",
			payload: {
				session: tmuxSession,
				failed: outcome.failed,
				degraded: outcome.degraded,
			},
		});
	}

	// Row cleanup derives from the RECONCILED outcome, not from an in-memory set
	// built before the live re-read: only a tab that fully restored (window live
	// + resumed where expected) is reconciled away from the row. A failed tab
	// stays a dead-open candidate for the next restore; a degraded tab's stale
	// dead-open entry is left for reconcile to re-archive (preserving its session
	// id for another attempt). Dropping a failed tab here would silently lose it.
	const fullyRestored = new Set(outcome.restored.map((r) => r.windowName));
	const restoredOpenTabIds = new Set<string>();
	const restoredClosedNames = new Set<string>();
	for (const c of candidates) {
		if (!fullyRestored.has(c.windowName)) continue;
		if (c.source === "open" && c.tabId) restoredOpenTabIds.add(c.tabId);
		if (c.source === "closed") restoredClosedNames.add(c.windowName);
	}
	if (restoredOpenTabIds.size > 0 || restoredClosedNames.size > 0) {
		// Re-read: each spawn appended a fresh tab (live windowId, stored name).
		// Drop the stale dead-open entries by tabId and the reopened closed
		// entries by name, leaving exactly one live tab per restored window.
		const fresh = await loadSessionState(tmuxSession);
		const tabs = fresh.tabs.filter((t) => !(t.tabId && restoredOpenTabIds.has(t.tabId)));
		const closedTabs = (fresh.closedTabs ?? []).filter(
			(c) => !restoredClosedNames.has(c.windowName),
		);
		await saveSessionState(tmuxSession, { tabs, closedTabs });
	}
	return outcome;
}
