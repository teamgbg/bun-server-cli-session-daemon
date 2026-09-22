/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure decision helpers for reconcileSessionState's durability guards, kept
 * apart from the DB/tmux-bound reconcile so the clobber-prevention logic is
 * unit-testable in isolation.
 */

/**
 * True when a reconcile's live window set is a "suspected tmux churn" read that
 * must NOT prune the record: the record holds more than one tab but the live
 * windows share ZERO names with it.
 *
 * That shape is a replaced/dead tmux server — socket churn, e.g. the /tmp
 * socket purged out from under a running server — never the operator closing
 * tabs, because real closes always leave overlap (you cannot close N tabs as a
 * single fully-disjoint read). Reconciling against such a read would prune every
 * real tab and adopt the impostor server's windows, wiping the durable record.
 * Preserving the record on this read is what stops the 2026-06-14 moss clobber
 * (7 tabs -> 1 the instant the socket was lost). The companion `liveWindows <= 1`
 * guard misses this because the impostor server can present more than one window
 * of its own.
 */

import type { SessionTab } from "./state-tabs.ts";

export function isSuspectedTmuxChurn(
	existingTabs: SessionTab[],
	liveNames: ReadonlySet<string>,
): boolean {
	return existingTabs.length > 1 && !existingTabs.some((t) => liveNames.has(t.windowName));
}
