/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * `closeTabByName` — the sanctioned teardown of one finished lane, targeted by
 * WINDOW NAME (never a bare index). The counterpart to option-spawn's
 * `spawnOptionInSession`: spawn creates capacity through the daemon, and this
 * removes it through the daemon, so the durable tab record is torn down in the
 * SAME operation rather than orphaned — the exact state the
 * `no-raw-tmux-rename-window` guard exists to prevent (a raw `tmux kill-window`
 * bypasses the daemon and leaves the picker holding a tab for a window that no
 * longer exists, and a bare form targets the server's active window so it can
 * kill an unrelated lane mid-work).
 *
 * This is the server-side half of `close_agent_tab` (the fleet MCP tool). The
 * fleet tool is a thin fetch to `/rpc/close`; every invariant lives here so the
 * picker remains the single close surface (`single-spawn-surface-is-the-daemon`
 * applied to teardown).
 *
 * Three refusals, each returning `{ok:false, error}` rather than throwing — the
 * caller is an orchestrator deciding what to do next, and "this lane is busy" is
 * information it must act on, not an exception to swallow:
 *   1. NOT FOUND — a window name that resolves to nothing live.
 *   2. SELF — a lane must not close the pane it is running in out from under its
 *      own tool call.
 *   3. BUSY unless `force` — closing a lane mid-turn discards its in-flight
 *      work, so that takes a deliberate second action.
 *
 * Kills BY WINDOW ID (`@N` resolved from the window's first pane), never by name
 * or index: names repeat across sessions and indices renumber the instant an
 * earlier window closes, so either other key can kill the WRONG lane. After the
 * kill it archives the tab into `closedTabs[]` eagerly (same operation) and
 * stops any transcript tail keyed under the tab's sessionId, so a
 * Claude/pi/codex lane's watcher does not leak.
 */

import { detectTabBusy } from "@teamscala/pane-inventory/busy-detect";
import { cliKindForGroup } from "./cli-kind.ts";
import type { CliKind } from "@teamscala/pane-inventory/agent-pane-detect";
import { recordEvent } from "@teamscala/event-log/record-event";
import {
	findWindow,
	firstPaneIdForWindow,
	listWindows,
	panePid,
	resolvePaneWindow,
} from "@teamscala/tmux-session/windows";
import { loadSessionState } from "./load-save.ts";
import { queryActiveOptions } from "./query-options.ts";
import { reconcileSessionState } from "./reconcile.ts";
import { closeWindowForPane } from "./rename-close.ts";
import { patchTab } from "./tab-mutation.ts";
import { normaliseTabs } from "./state-tabs.ts";


export interface CloseTabRequest {
	tmuxSession: string;
	/** Target by window NAME — indices renumber on close, so an index targets the
	 *  wrong lane (`agent-not-identity`). */
	windowName: string;
	/** Close a lane that is mid-turn. Off by default: its in-flight work is lost. */
	force?: boolean;
	/**
	 * The CALLER's own tmux target ("session:window.pane"), forwarded so the
	 * daemon can refuse a lane closing itself. Null when the caller is not a tmux
	 * pane (e.g. the operator's dashboard) — no self-risk then, so the check is
	 * skipped rather than failing.
	 */
	callerTmuxTarget?: string | null;
	/** WHO asked, recorded on the close event for audit. */
	requestedBy?: string | null;
	/**
	 * HOW the lane ended, stated by the caller (close_agent_tab forwards its
	 * disposition). Stamped onto the tab BEFORE the archive reconcile so the
	 * closedTabs entry is BORN with it — a deliberate close is never
	 * indistinguishable from a vanished one. Absent on the hook path (a window
	 * that disappeared with no deliberate close), where the archive default
	 * 'orphaned' applies.
	 */
	disposition?: string;
}

export interface CloseTabResult {
	ok: boolean;
	windowName?: string;
	/** Live tmux window id (`@N`) that was targeted. */
	windowId?: string;
	sessionName?: string;
	/**
	 * The closed lane's CLI-native session id — the same value stamped on its
	 * work_items task's kind_data.lane.session (the resolveLaneTask match key).
	 * Surfaced so close_agent_tab can reconcile that task (status + live=false)
	 * in the SAME operation as the teardown, rather than leaving it for the
	 * async dead-pane sweep (which has no disposition and never touches
	 * work_items). Absent when the tab predates sessionId capture.
	 */
	sessionId?: string;
	/** True once the durable tab record has been archived into closedTabs[]. */
	archived?: boolean;
	error?: string;
}

/**
 * Best-effort CLI kind for busy-detection. A finished lane is idle whatever its
 * CLI; the kind only matters to avoid clobbering a WORKING lane, and "unknown"
 * (the fallthrough) makes detectTabBusy return a non-busy state — so an
 * unclassifiable lane is never wrongly REFUSED, only unguarded against a busy
 * state the classification could not see.
 */
async function resolveCliKind(
	tmuxSession: string,
	windowId: string,
	windowName: string,
): Promise<CliKind> {
	try {
		const options = await queryActiveOptions();
		const groupBySlug: Record<string, string | undefined> = {};
		for (const o of options) groupBySlug[o.slug] = o.family?.key;
		const tabs = normaliseTabs((await loadSessionState(tmuxSession)).tabs);
		const tab =
			tabs.find((t) => t.windowId === windowId) ??
			tabs.find((t) => t.windowName === windowName);
		return cliKindForGroup(tab?.optionSlug ? groupBySlug[tab.optionSlug] : undefined);
	} catch {
		// A failed state read must not block the busy check's fallthrough to a
		// non-busy verdict.
		return "unknown";
	}
}

/**
 * Close one lane by window name. Resolves the name to a window id server-side,
 * refuses self/busy, kills by id, archives the tab, and stops the tail — all in
 * one operation. Returns a result on every path; never throws.
 */
export async function closeTabByName(req: CloseTabRequest): Promise<CloseTabResult> {
	const win = findWindow(req.tmuxSession, req.windowName);
	if (!win) {
		return {
			ok: false,
			error: `no live window named "${req.windowName}" in session "${req.tmuxSession}"`,
		};
	}

	// SELF — refuse to close the calling pane. resolvePaneWindow is target-agnostic
	// (tmux resolves any "-t" form, not only "%N"), so the caller's
	// "session:window.pane" resolves to its window id for the comparison. Window
	// ids are stable across closes (they do not renumber like indices), so an id
	// comparison cannot be fooled by a renumbering race.
	if (req.callerTmuxTarget) {
		const caller = resolvePaneWindow(req.callerTmuxTarget);
		if (caller && caller.windowId === win.id) {
			return {
				ok: false,
				windowName: win.name,
				windowId: win.id,
				error: `refusing to close the calling pane (window "${win.name}") — a lane must not close itself out from under its own tool call`,
			};
		}
	}

	const paneId = firstPaneIdForWindow(win.id);
	if (!paneId) {
		return {
			ok: false,
			windowName: win.name,
			windowId: win.id,
			error: `window "${req.windowName}" has no resolvable pane`,
		};
	}

	// BUSY — a lane mid-turn loses its in-flight work when its window dies, so the
	// check is part of closing rather than a warning after the fact.
	if (!req.force) {
		const kind = await resolveCliKind(req.tmuxSession, win.id, win.name);
		const busy = await detectTabBusy(paneId, kind);
		if (busy?.busy) {
			return {
				ok: false,
				windowName: win.name,
				windowId: win.id,
				error: `lane "${req.windowName}" is mid-turn (${busy.activity ?? "working"}) — closing now discards in-flight work; pass force:true to override`,
			};
		}
	}

	// Kill BY ID + stop any transcript tail keyed under the tab's sessionId so it
	// does not leak as a watcher that never receives another line. closeWindowForPane
	// is the same primitive close_run uses (closed-run-leaves-no-session).
	const closed = await closeWindowForPane(paneId);
	if (!closed.ok) {
		return {
			ok: false,
			windowName: win.name,
			windowId: win.id,
			error: closed.error ?? "tmux kill-window failed",
		};
	}


	// Stamp the close disposition onto the tab BEFORE archiving it, so the
	// closedTabs entry is BORN carrying how this lane ended. The subsequent
	// reconcile re-reads the row and carries the stamped disposition into the
	// archive; without it the archive default ('orphaned') would apply — the
	// exact ambiguity this closes (a deliberate close indistinguishable from a
	// vanished lane). Stamped AFTER a successful kill so a refused/failed close
	// leaves no disposition on an still-open tab. Best-effort: a failed stamp
	// falls through to the 'orphaned' default, never blocks the archive.
	if (req.disposition) {
		try {
			await patchTab(req.tmuxSession, win.name, { disposition: req.disposition });
		} catch {
			// The kill already succeeded; a failed disposition stamp degrades to
			// the archive's 'orphaned' default — never blocks the teardown.
		}
	}

	// Tear down the durable tab record in the SAME operation — archive the now-
	// dead tab into closedTabs[] eagerly rather than deferring to the async
	// window-unlinked hook (which can be coalesced or dropped in flight). The
	// hook still fires afterward as a harmless idempotent no-op. This is the half
	// the guard message demands: a close that kills the pane AND clears the row.
	let archived = false;
	try {
		const live = listWindows(req.tmuxSession).filter((w) => Boolean(w.name));
		await reconcileSessionState(req.tmuxSession, live);
		archived = true;
	} catch {
		// The kill already succeeded; a failed archive is recovered by the hook.
	}

	try {
		recordEvent({
			kind: "fleet.lane.closed",
			payload: {
				windowName: win.name,
				windowId: win.id,
				requestedBy: req.requestedBy ?? null,
			},
		});
	} catch {
		// Telemetry must never fail a close that already succeeded.
	}

	return {
		ok: true,
		windowName: win.name,
		windowId: win.id,
		sessionName: closed.sessionName,
		// Surface the lane's session id so close_agent_tab can resolve + reconcile
		// the work_items task bound to this lane in the same teardown. This is the
		// kind_data.lane.session match key (resolveLaneTask); absent on tabs that
		// predate sessionId capture.
		sessionId: closed.sessionId,
		archived,
	};
}
