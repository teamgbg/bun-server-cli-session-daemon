// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { absentNamedRestoreOutcome } from "./state-tabs.ts";
import type { LiveWindowRef, RestoreCandidate } from "./state-tabs.ts";

const cand = (over: Partial<RestoreCandidate>): RestoreCandidate =>
	({
		optionSlug: "claude",
		windowName: "x",
		sessionId: null,
		source: "open",
		...over,
	}) as RestoreCandidate;
const win = (name: string, id = "@1"): LiveWindowRef => ({ name, id });

test("THE FIX: a genuinely-absent named tab -> ok:false with a populated failed[] carrying a reason", () => {
	// windowName requested, no candidate, not live — the exact shape that used to
	// return a silent ok. Now it must name the missing tab and say why.
	const out = absentNamedRestoreOutcome("Gone Lane", [], [win("bash")], "joe");
	expect(out).not.toBeNull();
	expect(out!.ok).toBe(false);
	expect(out!.restored).toEqual([]);
	expect(out!.degraded).toEqual([]);
	expect(out!.failed).toHaveLength(1);
	expect(out!.failed[0]).toMatchObject({
		kind: "failed",
		windowName: "Gone Lane",
		slug: "",
		sessionId: null,
	});
	// The reason names the tab + the session + the three places it was sought, so
	// a caller reading it can act rather than guess.
	const reason = out!.failed[0]!.reason;
	expect(reason).toContain("Gone Lane");
	expect(reason).toContain("joe");
	expect(reason).toMatch(/live|tabs\[\]|closedTabs\[\]/);
});

test("a named tab that IS a candidate proceeds normally (null) — restore runs", () => {
	const out = absentNamedRestoreOutcome(
		"SCM",
		[cand({ windowName: "SCM", sessionId: "s1" })],
		[win("bash")],
		"joe",
	);
	expect(out).toBeNull();
});

test("a named tab that is already LIVE proceeds normally (null) — not an error", () => {
	// selectRestoreCandidates skips live tabs, so there is no candidate; but the
	// tab IS present, so "nothing to restore" is success here, not a failure. The
	// normal empty reconcile must run rather than reporting failed[].
	const out = absentNamedRestoreOutcome("Live", [], [win("Live", "@7")], "joe");
	expect(out).toBeNull();
});

test("no windowName requested (full-session restore) -> null", () => {
	// A full-session restore with nothing to reopen is a legitimate empty state,
	// not a failure — only a NAMED miss is. So an undefined name never synthesises
	// a failed entry.
	expect(absentNamedRestoreOutcome(undefined, [], [win("bash")], "joe")).toBeNull();
});

test("the absent outcome is durable-across-shapes: closedTabs-only archive is also 'nowhere' when the name misses", () => {
	// Reinforces the boundary: this helper only ever sees the SELECTED candidates
	// (open + closed already deduped by selectRestoreCandidates). A name that
	// selected nothing is absent from every store, whatever it would have been in.
	const out = absentNamedRestoreOutcome("Never Existed", [], [], "anna");
	expect(out!.ok).toBe(false);
	expect(out!.failed[0]!.windowName).toBe("Never Existed");
});
