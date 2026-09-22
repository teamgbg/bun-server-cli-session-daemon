// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { selectRestoreCandidates } from "./state-tabs.ts";
import type { ClosedTabRef, LiveWindowRef, SessionTab } from "./state-tabs.ts";

const openTab = (over: Partial<SessionTab>): SessionTab =>
	({ optionSlug: "claude", windowName: "x", ...over }) as SessionTab;
const closedTab = (over: Partial<ClosedTabRef>): ClosedTabRef => ({
	optionSlug: "claude",
	windowName: "x",
	...over,
});
const win = (name: string, id?: string): LiveWindowRef => ({ name, id: id ?? "" });

test("hard reboot: every open tab is dead (no live window) -> all restored, named", () => {
	const open = [
		openTab({ tabId: "t1", windowName: "SCM", windowId: "@1", sessionId: "s1" }),
		openTab({ tabId: "t2", windowName: "DB Theming", windowId: "@2", sessionId: "s2", optionSlug: "cc-glm52" }),
	];
	// after reboot only the fresh empty shell is live
	const out = selectRestoreCandidates(open, [], [win("bash")]);
	expect(out.map((c) => c.windowName).sort()).toEqual(["DB Theming", "SCM"]);
	const scm = out.find((c) => c.windowName === "SCM");
	expect(scm).toMatchObject({ optionSlug: "claude", sessionId: "s1", source: "open", tabId: "t1" });
});

test("a live tab is NOT a restore candidate (matched by windowId)", () => {
	const open = [
		openTab({ tabId: "t1", windowName: "running", windowId: "@9", sessionId: "s1" }),
		openTab({ tabId: "t2", windowName: "dead", windowId: "@8", sessionId: "s2" }),
	];
	// @9 is still alive (id match), 'dead' window is gone
	const out = selectRestoreCandidates(open, [], [win("running", "@9")]);
	expect(out.map((c) => c.windowName)).toEqual(["dead"]);
});

test("bulk/boot restore NEVER reopens the closed archive (over-restore guard)", () => {
	const open = [openTab({ tabId: "t1", windowName: "open-dead", sessionId: "s1" })];
	const closed = [
		closedTab({ windowName: "Projects", sessionId: "s3" }),
		closedTab({ windowName: "Cleanup", sessionId: "s4" }),
	];
	// no includeClosed -> only the dead-open tab, the closed history is left alone
	const out = selectRestoreCandidates(open, closed, [win("bash")]);
	expect(out.map((c) => c.windowName)).toEqual(["open-dead"]);
});

test("includeClosed reopens closed tabs not covered by a dead-open tab or live window", () => {
	const open = [openTab({ tabId: "t1", windowName: "open-dead", sessionId: "s1" })];
	const closed = [
		closedTab({ windowName: "open-dead", sessionId: "STALE" }), // shadowed by the open tab
		closedTab({ windowName: "Projects", sessionId: "s3" }),
		closedTab({ windowName: "btop", optionSlug: "btop" }), // name is live -> skip
	];
	const out = selectRestoreCandidates(open, closed, [win("btop")], { includeClosed: true });
	const byName = new Map(out.map((c) => [c.windowName, c]));
	expect([...byName.keys()].sort()).toEqual(["Projects", "open-dead"]);
	// the open entry wins for the shared name (its sessionId, not the closed STALE one)
	expect(byName.get("open-dead")).toMatchObject({ sessionId: "s1", source: "open" });
	expect(byName.get("Projects")).toMatchObject({ sessionId: "s3", source: "closed" });
});

test("filterWindowName narrows to a single tab", () => {
	const open = [
		openTab({ tabId: "t1", windowName: "SCM", sessionId: "s1" }),
		openTab({ tabId: "t2", windowName: "Overlay", sessionId: "s2" }),
	];
	const out = selectRestoreCandidates(open, [], [win("bash")], { filterWindowName: "Overlay" });
	expect(out).toHaveLength(1);
	expect(out[0]).toMatchObject({ windowName: "Overlay", sessionId: "s2" });
});

test("a null sessionId survives as null (fresh open, resume falls through)", () => {
	const open = [openTab({ tabId: "t1", windowName: "claude", sessionId: null })];
	const out = selectRestoreCandidates(open, [], [win("bash")]);
	expect(out[0]).toMatchObject({ windowName: "claude", sessionId: null });
});

test("reboot window: tabs archived by the shutdown ARE full-restore candidates", () => {
	// A graceful reboot closes windows one at a time, so reconcile archives the
	// open tabs into closedTabs (2026-07-14 incident: tabs[] empty after reboot,
	// plain restore reopened nothing). Closed tabs whose closedAt falls in the
	// reboot window count as crash-lost; older closes stay history.
	const bootMs = Date.parse("2026-07-14T10:03:00Z");
	const windowOpts = { rebootClosedWindow: { fromMs: bootMs - 600_000, toMs: bootMs } };
	const closed = [
		closedTab({
			windowName: "Orchestrator",
			sessionId: "s-orch",
			cwd: "/home/op",
			closedAt: "2026-07-14T10:00:59Z", // during shutdown
		}),
		closedTab({ windowName: "Old Lane", sessionId: "s-old", closedAt: "2026-07-13T12:00:00Z" }),
		closedTab({ windowName: "No Stamp", sessionId: "s-ns" }), // no closedAt -> never a victim
	];
	const out = selectRestoreCandidates([], closed, [win("bash")], windowOpts);
	expect(out.map((c) => c.windowName)).toEqual(["Orchestrator"]);
	// cwd carried so --resume finds the CLI's session file in the original dir
	expect(out[0]).toMatchObject({ sessionId: "s-orch", source: "closed", cwd: "/home/op" });
});

test("reboot window: a live or dead-open name still wins over the closed twin", () => {
	const bootMs = Date.parse("2026-07-14T10:03:00Z");
	const windowOpts = { rebootClosedWindow: { fromMs: bootMs - 600_000, toMs: bootMs } };
	const open = [openTab({ tabId: "t1", windowName: "Orchestrator", sessionId: "s-open" })];
	const closed = [
		closedTab({ windowName: "Orchestrator", sessionId: "s-stale", closedAt: "2026-07-14T10:00:59Z" }),
	];
	const out = selectRestoreCandidates(open, closed, [win("bash")], windowOpts);
	expect(out).toHaveLength(1);
	expect(out[0]).toMatchObject({ sessionId: "s-open", source: "open" });
});
