// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	buildClosedTabEntry,
	findLiveIdempotentTab,
	matchTabsToLive,
	type SessionTab,
} from "./state-tabs.ts";

function tab(p: Partial<SessionTab> & { windowName: string }): SessionTab {
	return { optionSlug: "claude", ...p };
}

describe("matchTabsToLive", () => {
	test("rename-in-place: same window id, new name → same tab, label refreshed", () => {
		const existing = [tab({ tabId: "t1", windowId: "@1", windowName: "old" })];
		const r = matchTabsToLive(existing, [{ id: "@1", name: "new" }]);
		expect(r.kept).toHaveLength(1);
		expect(r.kept[0]?.tabId).toBe("t1"); // tabId preserved
		expect(r.kept[0]?.windowName).toBe("new"); // label refreshed
		expect(r.kept[0]?.windowId).toBe("@1");
		expect(r.closedNow).toHaveLength(0);
		expect(r.missing).toHaveLength(0);
		expect(r.mutatedKept).toBe(true);
	});

	test("unchanged: same id and name → kept, no mutation", () => {
		const existing = [tab({ tabId: "t1", windowId: "@1", windowName: "a" })];
		const r = matchTabsToLive(existing, [{ id: "@1", name: "a" }]);
		expect(r.kept).toHaveLength(1);
		expect(r.mutatedKept).toBe(false);
	});

	test("tab without windowId → NOT matched (id-only); live window adopted fresh", () => {
		// No windowId → no id to match. The tab is closedNow; the live window is
		// missing (re-adopted fresh). Name is never consulted to resolve a tab.
		const existing = [tab({ tabId: "t1", windowName: "a" })];
		const r = matchTabsToLive(existing, [{ id: "@1", name: "a" }]);
		expect(r.kept).toHaveLength(0);
		expect(r.closedNow).toHaveLength(1);
		expect(r.missing).toHaveLength(1);
		expect(r.missing[0]?.id).toBe("@1");
	});

	test("tmux-server restart: stale windowId → tab closed, live window adopted fresh", () => {
		// On tmux-server restart every @n id is reminted. id-only resolution
		// treats the stale-id tab as closed and the new-id window as missing
		// (re-adopted fresh; sessionId recovered via the capture adapter).
		const existing = [tab({ tabId: "t1", windowId: "@OLD", windowName: "a" })];
		const r = matchTabsToLive(existing, [{ id: "@NEW", name: "a" }]);
		expect(r.kept).toHaveLength(0);
		expect(r.closedNow).toHaveLength(1);
		expect(r.missing).toHaveLength(1);
		expect(r.missing[0]?.id).toBe("@NEW");
	});

	test("closed: window gone (no id nor name match) → closedNow", () => {
		const existing = [tab({ tabId: "t1", windowId: "@1", windowName: "a" })];
		const r = matchTabsToLive(existing, [{ id: "@2", name: "b" }]);
		expect(r.closedNow).toHaveLength(1);
		expect(r.kept).toHaveLength(0);
		expect(r.missing).toHaveLength(1);
		expect(r.missing[0]?.name).toBe("b");
	});

	test("adopt: live window no tab claims → missing", () => {
		const r = matchTabsToLive([], [{ id: "@1", name: "a" }]);
		expect(r.missing).toHaveLength(1);
		expect(r.kept).toHaveLength(0);
	});

	test("rename does NOT archive the window as closed (regression guard)", () => {
		// The whole point: a rename must not show up as a close.
		const existing = [tab({ tabId: "t1", windowId: "@1", windowName: "claude-2" })];
		const r = matchTabsToLive(existing, [{ id: "@1", name: "Projects UI" }]);
		expect(r.closedNow).toHaveLength(0);
		expect(r.kept[0]?.tabId).toBe("t1");
	});
});

/*
 * Idempotent spawn: a retried spawn_agent_tab must return the lane the first
 * attempt opened, not open a second window. findLiveIdempotentTab is the pure
 * core of that dedup — given the persisted tabs + a liveness predicate, it
 * finds the prior LIVE lane by key (or null, letting a fresh spawn proceed).
 *
 * A DEAD tab carrying the key is deliberately NOT returned: a retry whose first
 * attempt's lane has already exited should open fresh, not hand back a stale
 * handle to a gone window.
 */
describe("findLiveIdempotentTab", () => {
	const live = tab({ tabId: "t1", windowId: "@1", windowName: "lane-a", idempotencyKey: "K1" });
	const dead = tab({ tabId: "t2", windowId: "@2", windowName: "lane-b", idempotencyKey: "K2" });
	const noKey = tab({ tabId: "t3", windowId: "@3", windowName: "lane-c" });

	test("returns the LIVE tab whose idempotency key matches", () => {
		const r = findLiveIdempotentTab([live, noKey], "K1", () => true);
		expect(r).toBe(live);
	});

	test("returns null when the only matching tab is DEAD (fall through to fresh)", () => {
		// isLive reports the matching tab dead → no dedup; a fresh spawn proceeds.
		const r = findLiveIdempotentTab([dead], "K2", (t) => t.windowId === "@NOT-2");
		expect(r).toBeNull();
	});

	test("returns null when no tab carries the key", () => {
		const r = findLiveIdempotentTab([live, noKey], "ABSENT", () => true);
		expect(r).toBeNull();
	});

	test("returns null when the key matches but the tab is not live", () => {
		// Live tab is a DIFFERENT key; the queried key's tab is dead.
		const r = findLiveIdempotentTab([live, dead], "K2", (t) => t.windowId === "@1");
		expect(r).toBeNull();
	});

	test("first LIVE match wins when several tabs share the key", () => {
		const other = tab({ tabId: "t9", windowId: "@9", windowName: "lane-d", idempotencyKey: "K1" });
		const r = findLiveIdempotentTab([live, dead, other], "K1", () => true);
		expect(r).toBe(live);
	});

	test("isLive distinguishes live from dead across the set", () => {
		// dead (@2) carries K2 and is dead; live (@1) carries K1 and is live.
		// Querying K2 with @1-live and @2-dead → null (the K2 tab is dead).
		expect(findLiveIdempotentTab([live, dead], "K2", (t) => t.windowId === "@1")).toBeNull();
		// Querying K1 → live.
		expect(findLiveIdempotentTab([live, dead], "K1", (t) => t.windowId === "@1")).toBe(live);
	});
});

describe("buildClosedTabEntry — the disposition a closed tab is born with", () => {
	test("a stamped disposition flows through verbatim (deliberate close)", () => {
		const entry = buildClosedTabEntry(
			tab({ windowName: "Migration audit", disposition: "completed", sessionId: "ses-1" }),
			"2026-08-02T00:00:00.000Z",
		);
		expect(entry.disposition).toBe("completed");
		expect(entry.windowName).toBe("Migration audit");
		expect(entry.sessionId).toBe("ses-1");
		expect(entry.closedAt).toBe("2026-08-02T00:00:00.000Z");
	});

	test("a tab with NO disposition defaults to 'orphaned' (a vanished lane)", () => {
		// The load-bearing rule: a window that disappeared with no deliberate
		// close is self-describing as 'orphaned', never byte-identical to a
		// clean close. This default is the whole fix.
		const entry = buildClosedTabEntry(
			tab({ windowName: "Infra Orchestration" }),
			"2026-08-02T00:00:00.000Z",
		);
		expect(entry.disposition).toBe("orphaned");
	});

	test("every other disposition value passes through unchanged", () => {
		for (const d of ["needs_retry", "failed", "orchestrator_closed"] as const) {
			expect(
				buildClosedTabEntry(tab({ windowName: "x", disposition: d }), "now").disposition,
			).toBe(d);
		}
	});
});
