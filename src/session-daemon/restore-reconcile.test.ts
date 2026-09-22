// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { reconcileRestore } from "./state-tabs.ts";
import type { LiveWindowRef, RestoreCandidate, RestoreSpawnOutcome } from "./state-tabs.ts";

const cand = (over: Partial<RestoreCandidate>): RestoreCandidate =>
	({
		optionSlug: "claude",
		windowName: "x",
		sessionId: null,
		source: "open",
		...over,
	}) as RestoreCandidate;

const win = (name: string, id = "@1"): LiveWindowRef => ({ name, id });

const outcomes = (entries: Array<[string, RestoreSpawnOutcome]>): Map<string, RestoreSpawnOutcome> =>
	new Map(entries);

test("full success: every candidate's window live + resumed where expected -> ok:true", () => {
	const candidates = [
		cand({ windowName: "SCM", sessionId: "11111111-1111-1111-1111-111111111111", tabId: "t1" }),
		cand({ windowName: "Fresh", sessionId: null, tabId: "t2" }),
	];
	const live = [win("SCM", "@1"), win("Fresh", "@2")];
	const out = reconcileRestore(
		candidates,
		live,
		outcomes([
			["SCM", { resumed: true }],
			["Fresh", { resumed: false }],
		]),
	);
	expect(out.ok).toBe(true);
	expect(out.failed).toEqual([]);
	expect(out.degraded).toEqual([]);
	expect(out.restored.map((r) => r.windowName).sort()).toEqual(["Fresh", "SCM"]);
});

test("failed: a candidate whose window did NOT come up is named, not omitted", () => {
	// SCM spawned without throwing (no error) but its window is absent from the
	// re-read live set — the spawned-then-died case the live re-read catches.
	const candidates = [
		cand({ windowName: "SCM", sessionId: "s1", tabId: "t1" }),
		cand({ windowName: "OK", sessionId: "s2", tabId: "t2" }),
	];
	const live = [win("OK", "@2")]; // SCM's window is gone
	const out = reconcileRestore(
		candidates,
		live,
		outcomes([
			["SCM", { resumed: true }],
			["OK", { resumed: true }],
		]),
	);
	expect(out.ok).toBe(false);
	expect(out.restored.map((r) => r.windowName)).toEqual(["OK"]);
	expect(out.failed).toHaveLength(1);
	expect(out.failed[0]).toMatchObject({
		kind: "failed",
		windowName: "SCM",
		reason: "window did not come up",
	});
});

test("failed: a candidate whose spawn THREW carries the error reason", () => {
	const candidates = [cand({ windowName: "SCM", sessionId: "s1", tabId: "t1" })];
	// Window is live but the spawn threw — the error outcome wins (a window that
	// exists for another reason must not mask a failed spawn of THIS candidate).
	const out = reconcileRestore(
		candidates,
		[win("SCM", "@1")],
		outcomes([["SCM", { error: "no session_picker_option with slug 'claude'" }]]),
	);
	expect(out.ok).toBe(false);
	expect(out.failed[0]).toMatchObject({
		kind: "failed",
		windowName: "SCM",
		reason: "no session_picker_option with slug 'claude'",
	});
});

test("degraded: a resumable tab reopened FRESH (resumed !== true) is named", () => {
	// The tab carried a session id we expected to resume; the spawn opened it
	// fresh instead (malformed id refused, or no transcript). The pane is up
	// under the old name with an EMPTY conversation — the silent-partial.
	const candidates = [cand({ windowName: "SCM", sessionId: "s1", tabId: "t1" })];
	const out = reconcileRestore(
		candidates,
		[win("SCM", "@1")],
		outcomes([["SCM", { resumed: false }]]),
	);
	expect(out.ok).toBe(false);
	expect(out.restored).toEqual([]);
	expect(out.degraded).toHaveLength(1);
	expect(out.degraded[0]).toMatchObject({
		kind: "degraded",
		windowName: "SCM",
		reason: "reopened fresh — conversation not recovered",
	});
});

test("a tab with NO session id opening fresh is restored, not degraded", () => {
	// A capture-only CLI / a tab that never captured: sessionId null, opening
	// fresh is CORRECT (there was never a conversation to recover).
	const out = reconcileRestore(
		[cand({ windowName: "Fresh", sessionId: null })],
		[win("Fresh", "@1")],
		outcomes([["Fresh", { resumed: false }]]),
	);
	expect(out.ok).toBe(true);
	expect(out.degraded).toEqual([]);
	expect(out.restored.map((r) => r.windowName)).toEqual(["Fresh"]);
});

test("ok is false when ANY tab is degraded even with zero failed", () => {
	const out = reconcileRestore(
		[cand({ windowName: "SCM", sessionId: "s1" })],
		[win("SCM", "@1")],
		outcomes([["SCM", { resumed: false }]]),
	);
	expect(out.failed).toEqual([]);
	expect(out.degraded).toHaveLength(1);
	expect(out.ok).toBe(false);
});

test("mixed: every candidate lands in the right bucket and every name is carried", () => {
	const candidates = [
		cand({ windowName: "Good", sessionId: "s1", optionSlug: "claude", tabId: "t1" }),
		cand({ windowName: "Dead", sessionId: "s2", optionSlug: "claude", tabId: "t2" }),
		cand({ windowName: "Deg", sessionId: "s3", optionSlug: "cc-glm52", tabId: "t3" }),
		cand({ windowName: "FreshOk", sessionId: null, optionSlug: "claude", tabId: "t4" }),
	];
	const live = [win("Good", "@1"), win("Deg", "@3"), win("FreshOk", "@4")]; // Dead absent
	const out = reconcileRestore(
		candidates,
		live,
		outcomes([
			["Good", { resumed: true }],
			["Dead", { resumed: true }], // spawned ok but window gone -> failed
			["Deg", { resumed: false }], // live but not resumed -> degraded
			["FreshOk", { resumed: false }], // no session id -> restored
		]),
	);
	expect(out.ok).toBe(false);
	expect(out.restored.map((r) => r.windowName).sort()).toEqual(["FreshOk", "Good"]);
	expect(out.failed.map((p) => p.windowName)).toEqual(["Dead"]);
	expect(out.degraded.map((p) => p.windowName)).toEqual(["Deg"]);
	// The omission guard: every non-restored name is present in the output.
	const named = new Set([...out.failed, ...out.degraded].map((p) => p.windowName));
	expect(named).toEqual(new Set(["Dead", "Deg"]));
});

test("a candidate missing from outcomes (defensive) with a live window is classified by sessionId", () => {
	// restoreSession always records an outcome per candidate, but reconcile must
	// not crash or guess wrong if one is absent. Live + no outcome + sessionId:
	// we cannot confirm resume -> degraded (named, never a silent restored).
	const out = reconcileRestore(
		[cand({ windowName: "SCM", sessionId: "s1" })],
		[win("SCM", "@1")],
		outcomes([]),
	);
	expect(out.ok).toBe(false);
	expect(out.degraded[0]).toMatchObject({ windowName: "SCM" });
});
