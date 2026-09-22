/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 * @indivisible-unit owner=split-ts-tooling reason="one tab-state helper family: normalization, live-window matching, closed-tab entry construction for session_picker tabs"
 *
 * Normalises persisted tab state around one stable identity per tmux window.
 * tmux permits duplicate window names, but restore cannot target them safely,
 * so persisted state is kept unique by window name and each tab gets a tab id.
 *
 * Marked: this file holds the three public operations of
 * one concern — tab state normalisation. createTabId, normaliseTabs and
 * markRestoreError share the SessionTab shape and the windowName-uniqueness
 * invariant. Splitting would force every caller that does
 * "createTabId + normaliseTabs" to import from two paths for no reuse benefit.
 */

/**
 * Pure id-only matching of stored tabs against live windows. A stored tab
 * resolves to a live window by its stable window id — and ONLY by id. There is
 * no name fallback: name-based resolution is the hazard that crosses a tab to
 * the wrong window when names collide (the cc-glm52 rename-crossover class — a
 * self-rename must never be able to land on another pane's window). A matched
 * tab is KEPT with label + windowId refreshed in place — so a renamed window
 * (same id, new name) stays the SAME tab (tabId preserved) instead of being
 * closed-and-readopted. A tab whose windowId is absent or stale (rows without
 * without windowId, tmux-server restarts that remint ids) is `closedNow`; its
 * live window is `missing` and re-adopted fresh (sessionId recovered via the
 * capture adapter). Extracted from reconcileSessionState so the core logic is
 * unit-testable without DB/tmux.
 */

/**
 * Build one closed-tab archive entry from a tab whose window is gone — the pure
 * half of `reconcileSessionState`'s archival, extracted so the disposition rule
 * is unit-testable without DB/tmux (same reason `matchTabsToLive` was lifted).
 *
 * The load-bearing rule: a tab CARRIES its end disposition. A deliberate close
 * stamps one onto the tab first, so it flows through verbatim; a window that
 * VANISHED with no deliberate close has none, and 'orphaned' is the default that
 * makes that state self-describing. Without this default a lane killed by an
 * outage was byte-identical in the archive to one closed cleanly (2026-08-02).
 * Pure (time is a caller-supplied ISO string), so it tests alongside
 * `matchTabsToLive`.
 */

/**
 * Find an EXISTING LIVE tab spawned under the same idempotency key — the
 * idempotent-spawn dedup (`spawn_agent_tab` must never create two lanes from one
 * call). A retry of one spawn intent carries the SAME caller-supplied key, and
 * the picker consults this BEFORE creating a window: a hit returns the prior
 * lane's windowName/paneId instead of letting `uniqueWindowName` append "-2" and
 * open a second window doing identical work.
 *
 * Pure (liveness is a predicate the caller supplies from tmux), so it is
 * unit-testable without DB/tmux, same shape as `matchTabsToLive`.
 *
 * A tab carrying the key whose window is DEAD is NOT returned: a retry whose
 * first attempt's lane has already exited should open a fresh lane, not hand
 * back a stale handle to a window that no longer exists. The dead row is left
 * for reconcile to prune, and the fresh spawn re-records the key.
 */

/**
 * Decide which recorded tabs to reopen for a session — the pure core of
 * `restoreSession`, kept here (with matchTabsToLive) so the selection is
 * unit-testable without tmux/DB.
 *
 * Always: every "dead open" tab (in tabs[] but its window vanished — the
 * hard-reboot case the churn-guard preserves), carried at its stored name with
 * its sessionId. This is what was OPEN at the crash — the only thing a reboot
 * should bring back.
 *
 * Only when `includeClosed`: closed-archive tabs whose name isn't already
 * covered by a live window or a dead-open candidate — used for an explicit
 * "reopen that closed tab" request, never on boot. Deduped by windowName (open
 * beats closed) so a restore never opens two windows for one logical tab.
 */

/**
 * Reconcile what a restore SAID should reopen (candidates from the DB row)
 * against what ACTUALLY came up (live windows, re-read AFTER spawning) + how
 * each spawn resolved (resumed vs fresh vs threw). Pure: no tmux, no DB, no
 * clock — fully unit-testable, same shape as `selectRestoreCandidates`/
 * `matchTabsToLive`. This is the load-bearing piece for whole-session crash
 * recovery: a restore that reopens SOME tabs and reports success is worse than
 * one that fails, because the operator sees a populated screen and assumes it
 * is complete. So every candidate resolves to exactly one bucket — restored /
 * degraded / failed — and any non-restored tab makes `ok` false and is NAMED,
 * never omitted.
 *
 * Classification (per candidate, keyed by windowName — candidates are unique by
 * name by `selectRestoreCandidates`):
 *  - FAILED: the spawn threw (`outcome.error` set) OR its window is not in the
 *    re-read live set. "Did not come up" — covers both a thrown spawn and the
 *    spawned-then-died case (a window tmux created whose CLI exited before the
 *    re-read, e.g. a resume whose session file is missing and the CLI bails).
 *    This is the loudest class — a pane the operator never even sees.
 *  - DEGRADED: the window came up BUT the candidate carried a session id we
 *    expected to resume and the spawn did NOT replay it (`outcome.resumed !==
 *    true`). The pane exists under the old name with an EMPTY conversation —
 *    the silent-partial in its purest form. A candidate with NO session id
 *    opening fresh is correct (restored), not degraded.
 *  - RESTORED: the window came up, and either it had no session id (fresh was
 *    right) or it did and the spawn replayed it (`outcome.resumed === true`).
 *
 * `resumable` derives from the candidate's OWN session id — a non-empty value
 * the row stored — not from any process-local accumulator, so the decision is
 * identical before and after a daemon restart.
 */

/**
 * Decide whether a NAMED restore found nothing to restore — and if so, return
 * the honest outcome instead of letting `restoreSession` fall through to a
 * silent `ok:true` with empty arrays. The companion to `reconcileRestore`:
 * that function classifies candidates that EXIST; this one names the candidate
 * that was REQUESTED but found NOWHERE.
 *
 * `a-component-may-not-report-a-state-it-has-not-verified`: a restore that
 * restores nothing must say WHY. Before this, `POST /rpc/restore?windowName=X`
 * for a tab present in NEITHER the live windows, NOR tabs[], NOR closedTabs[]
 * returned `{ok:true, restored:[], degraded:[], failed:[]}` — byte-identical
 * to a successful restore of nothing, so a caller could not tell "restored"
 * from "nothing to restore" from "I could not" (2026-08-01: five lanes'
 * restores returned exactly this and their permanent loss read as success). A
 * genuinely-absent named tab now yields a populated `failed[]` carrying the
 * reason; a tab already LIVE (which `selectRestoreCandidates` correctly skipped,
 * producing no candidate) is NOT an error and proceeds to a normal empty
 * reconcile. Returns null when the normal restore flow should run (a candidate
 * exists, or no single name was requested).
 *
 * Pure (liveness is a caller-supplied list), so it is unit-testable alongside
 * `selectRestoreCandidates` / `reconcileRestore`.
 */

import type {
	SessionClosedTab,
	SessionStateConfig,
} from "@teamscala/db-validation/registry-schemas/session-state";

export type SessionTab = SessionStateConfig["tabs"][number] & {
	tabId?: string;
	restoreError?: string | null;
};

export function createTabId(): string {
	return Bun.randomUUIDv7();
}

function tabSpecificity(tab: SessionTab): number {
	let score = 0;
	if (tab.tabId) score += 8;
	if (tab.sessionId) score += 4;
	if (tab.cwd) score += 2;
	if (tab.command) score += 1;
	return score;
}

function betterTab(current: SessionTab, candidate: SessionTab): SessionTab {
	return tabSpecificity(candidate) > tabSpecificity(current) ? candidate : current;
}

export function normaliseTabs(
	tabs: SessionStateConfig["tabs"],
	makeId: () => string = createTabId,
): SessionTab[] {
	const byWindowName = new Map<string, SessionTab>();
	for (const rawTab of tabs as SessionTab[]) {
		const tab: SessionTab = { ...rawTab, tabId: rawTab.tabId ?? makeId() };
		const current = byWindowName.get(tab.windowName);
		byWindowName.set(tab.windowName, current ? betterTab(current, tab) : tab);
	}
	return [...byWindowName.values()];
}

export function markRestoreError(tab: SessionTab, error: string): SessionTab {
	return {
		...tab,
		restoreError: error,
	};
}

export interface LiveWindowRef {
	id: string;
	name: string;
}

export interface TabMatchResult<W extends LiveWindowRef> {
	/** Tabs still live, label + windowId refreshed from the live window. */
	kept: SessionTab[];
	/** Tabs whose window is gone (no id NOR name match). */
	closedNow: SessionTab[];
	/** Live windows no stored tab claimed — to be adopted as new tabs. */
	missing: W[];
	/** A kept tab's label or windowId changed (e.g. a rename) → needs a save. */
	mutatedKept: boolean;
}

export function matchTabsToLive<W extends LiveWindowRef>(
	existingTabs: SessionTab[],
	liveWindows: W[],
): TabMatchResult<W> {
	const liveById = new Map(
		liveWindows.filter((w) => w.id).map((w) => [w.id, w] as const),
	);
	const kept: SessionTab[] = [];
	const closedNow: SessionTab[] = [];
	const claimedLive = new Set<string>();
	let mutatedKept = false;
	for (const tab of existingTabs) {
		const liveW = tab.windowId ? liveById.get(tab.windowId) : undefined;
		const claimKey = liveW?.id ?? "";
		if (liveW && !claimedLive.has(claimKey)) {
			claimedLive.add(claimKey);
			const nextWindowId = liveW.id || tab.windowId;
			if (tab.windowName !== liveW.name || tab.windowId !== nextWindowId) {
				mutatedKept = true;
			}
			kept.push({ ...tab, windowName: liveW.name, windowId: nextWindowId });
		} else {
			closedNow.push(tab);
		}
	}
	const missing = liveWindows.filter((w) => !claimedLive.has(w.id || w.name));
	return { kept, closedNow, missing, mutatedKept };
}

export function buildClosedTabEntry(tab: SessionTab, nowIso: string): SessionClosedTab {
	return {
		optionSlug: tab.optionSlug,
		windowName: tab.windowName,
		command: tab.command,
		cwd: tab.cwd,
		sessionId: tab.sessionId ?? null,
		closedAt: nowIso,
		disposition: tab.disposition ?? "orphaned",
	};
}

export function findLiveIdempotentTab(
	tabs: SessionTab[],
	idempotencyKey: string,
	isLive: (tab: SessionTab) => boolean,
): SessionTab | null {
	for (const tab of tabs) {
		if (tab.idempotencyKey === idempotencyKey && isLive(tab)) return tab;
	}
	return null;
}

/** A closed-tab archive entry — the subset of fields restore needs. */
export interface ClosedTabRef {
	optionSlug: string;
	windowName: string;
	sessionId?: string | null;
	/** Original working directory — carried so a reopened closed tab resumes in
	 * the directory where the CLI's session file lives. */
	cwd?: string | null;
	/** When the tab was archived (ISO). Drives the reboot-victim window. */
	closedAt?: string | null;
}

/** One tab to reopen, resolved by `selectRestoreCandidates`. `source` lets the
 * caller clean up the right store after a successful reopen (a dead OPEN tab is
 * removed from tabs[] by tabId; a CLOSED tab is removed from closedTabs by
 * windowName). `sessionId` drives resume.replay. `cwd` is the original working
 * directory the session was created in — critical for cross-slug resume (a
 * session created under one LLM slug must be resumed under another with the
 * same cwd so `--resume <id>` finds the .jsonl in the right project dir). */
export interface RestoreCandidate {
	optionSlug: string;
	windowName: string;
	sessionId: string | null;
	source: "open" | "closed";
	tabId?: string;
	/** Original cwd from the tab state — used to set the tmux window's working
	 * directory on restore so the CLI finds its session file. */
	cwd?: string | null;
}

/** Options for `selectRestoreCandidates` / `restoreSession`. */
export interface RestoreSelectOpts {
	/** Restore only this window. */
	filterWindowName?: string;
	/** Also reopen the CLOSED archive (deliberately-closed tabs). Default false:
	 * a full-session restore reopens only what was OPEN at crash. The closed
	 * archive is history — resurrecting all of it floods the session (the
	 * nebula/comet over-restore). It is reopened ONLY for an explicit single-tab
	 * request (windowName), where `restoreSession` sets this. */
	includeClosed?: boolean;
	/** Reboot-victim window [fromMs, toMs] (epoch ms). A graceful shutdown
	 * closes windows one at a time, so the reconcile bursts ARCHIVE the open
	 * tabs into closedTabs — indistinguishable from deliberate closes — leaving
	 * tabs[] empty and a plain restore with nothing to reopen (the 2026-07-14
	 * reboot: every tab landed in closedTabs, restore resumed nothing). Closed
	 * tabs whose closedAt falls inside this window are treated as crash-lost
	 * OPEN tabs: reopened on a FULL restore, without includeClosed. */
	rebootClosedWindow?: { fromMs: number; toMs: number } | null;
}

export function selectRestoreCandidates(
	openTabs: SessionTab[],
	closedTabs: ClosedTabRef[],
	liveWindows: LiveWindowRef[],
	opts: RestoreSelectOpts = {},
): RestoreCandidate[] {
	const liveById = new Map(liveWindows.filter((w) => w.id).map((w) => [w.id, w] as const));
	const liveByName = new Map(liveWindows.map((w) => [w.name, w] as const));
	// id-only for open tabs: a tab is live iff its windowId is live. No name
	// fallback — same hazard class as matchTabsToLive (a colliding name must not
	// make a dead tab look live). liveByName is retained for closed-tab dedup
	// below: a closed tab carries no windowId, so name is the only "is this
	// already reopened" signal — not a fallback, there is no id path for that.
	const isLive = (t: { windowId?: string }): boolean =>
		Boolean(t.windowId && liveById.get(t.windowId));

	const byName = new Map<string, RestoreCandidate>();
	for (const t of openTabs) {
		if (isLive(t)) continue;
		if (byName.has(t.windowName)) continue;
		byName.set(t.windowName, {
			optionSlug: t.optionSlug,
			windowName: t.windowName,
			sessionId: t.sessionId ?? null,
			source: "open",
			cwd: t.cwd ?? null,
			tabId: t.tabId,
		});
	}
	const inRebootWindow = (c: ClosedTabRef): boolean => {
		const w = opts.rebootClosedWindow;
		if (!w || !c.closedAt) return false;
		const t = Date.parse(c.closedAt);
		return Number.isFinite(t) && t >= w.fromMs && t <= w.toMs;
	};
	for (const c of closedTabs) {
		if (!opts.includeClosed && !inRebootWindow(c)) continue;
		if (liveByName.has(c.windowName) || byName.has(c.windowName)) continue;
		byName.set(c.windowName, {
			optionSlug: c.optionSlug,
			windowName: c.windowName,
			sessionId: c.sessionId ?? null,
			source: "closed",
			cwd: c.cwd ?? null,
		});
	}
	const out = [...byName.values()];
	return opts.filterWindowName
		? out.filter((c) => c.windowName === opts.filterWindowName)
		: out;
}

/** Per-candidate spawn outcome, consumed by `reconcileRestore`. `resumed` mirrors
 * `SpawnResult.resumed` — true ONLY when the spawn REPLAYED a prior conversation
 * (not seeded fresh). Absent/undefined when the spawn threw; see `error`. */
export interface RestoreSpawnOutcome {
	resumed?: boolean;
	/** Set when the spawn threw — the candidate produced no window at all. */
	error?: string;
}

/** A tab that did NOT fully restore — NAMED so the operator/picker can surface
 * it rather than omit it. `kind` separates the two partial-restore shapes that
 * both read as a clean pass if silently dropped:
 *  - `failed`: the window did not come up (spawn threw, or spawned-then-died).
 *  - `degraded`: the window came up BUT a resume was expected and did not happen
 *    — the conversation was NOT recovered. The operator sees a pane under the
 *    old name and assumes their work is back; it is not. */
export interface RestoreProblem {
	kind: "failed" | "degraded";
	windowName: string;
	slug: string;
	sessionId: string | null;
	reason: string;
}

/** A fully-restored tab: its window came up live, and if it carried a session id
 * that session was replayed (or it never had one, so fresh was correct). */
export interface RestoreSuccess {
	windowName: string;
	slug: string;
	resumeId: string | null;
}

/** The reconciled outcome of a restore — the daemon's single source of truth
 * for "what actually came back". `ok` is true ONLY when every candidate fully
 * restored (no failed, no degraded). Derived from a RE-READ of the live windows
 * + the per-candidate spawn outcome, NEVER from an in-memory "did I reopen
 * this" set: the decision belongs to the tab (its session id) + reality (the
 * live window), not to accumulated process state (`in-memory-state-is-not-
 * durable`). */
export interface RestoreOutcome {
	ok: boolean;
	restored: RestoreSuccess[];
	degraded: RestoreProblem[];
	failed: RestoreProblem[];
}

export function reconcileRestore(
	candidates: RestoreCandidate[],
	liveWindows: LiveWindowRef[],
	outcomes: Map<string, RestoreSpawnOutcome>,
): RestoreOutcome {
	const liveByName = new Set(liveWindows.map((w) => w.name));
	const restored: RestoreSuccess[] = [];
	const degraded: RestoreProblem[] = [];
	const failed: RestoreProblem[] = [];
	for (const c of candidates) {
		const outcome = outcomes.get(c.windowName);
		// FAILED: spawn threw, or the window never came up / did not survive to
		// the re-read. Either way the operator has no pane for this tab.
		if (outcome?.error || !liveByName.has(c.windowName)) {
			failed.push({
				kind: "failed",
				windowName: c.windowName,
				slug: c.optionSlug,
				sessionId: c.sessionId,
				reason: outcome?.error ?? "window did not come up",
			});
			continue;
		}
		// DEGRADED: the tab carried a session id we expected to resume, but the
		// spawn did not replay it (resumed !== true — a malformed id was refused,
		// or no transcript existed so it seeded fresh). The pane is up but the
		// conversation is gone — name it, do not let it pass as restored.
		const expectedResume = c.sessionId != null && c.sessionId !== "";
		if (expectedResume && outcome?.resumed !== true) {
			degraded.push({
				kind: "degraded",
				windowName: c.windowName,
				slug: c.optionSlug,
				sessionId: c.sessionId,
				reason: "reopened fresh — conversation not recovered",
			});
			continue;
		}
		restored.push({
			windowName: c.windowName,
			slug: c.optionSlug,
			resumeId: c.sessionId,
		});
	}
	return {
		ok: failed.length === 0 && degraded.length === 0,
		restored,
		degraded,
		failed,
	};
}

export function absentNamedRestoreOutcome(
	requestedWindowName: string | undefined,
	candidates: RestoreCandidate[],
	liveWindows: LiveWindowRef[],
	session: string,
): RestoreOutcome | null {
	if (!requestedWindowName) return null;
	if (candidates.some((c) => c.windowName === requestedWindowName)) return null;
	// The tab is already live, so selectRestoreCandidates produced no candidate
	// for it — that is success (nothing to reopen), not a failure. Let the
	// normal empty reconcile run.
	if (liveWindows.some((w) => w.name === requestedWindowName)) return null;
	return {
		ok: false,
		restored: [],
		degraded: [],
		failed: [
			{
				kind: "failed",
				windowName: requestedWindowName,
				slug: "",
				sessionId: null,
				reason: `no recorded tab named "${requestedWindowName}" in session "${session}" — it is neither live, nor in the open-tab record (tabs[]), nor in the closed-tab archive (closedTabs[]). No session id was durably captured for this window, so there is nothing to restore.`,
			},
		],
	};
}
