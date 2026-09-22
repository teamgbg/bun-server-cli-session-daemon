// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockModuleRestorable, restoreMockedModules } from "./mock-module-restore.ts";

/** Controllable tmux boundary — the surface where mis-targeting is observable. */
let findWindowReturn: { id: string; name: string; index: number; active: boolean; panes: number } | null = {
	id: "@42",
	name: "CloseMe",
	index: 9,
	active: false,
	panes: 1,
};
let firstPaneReturn: string | null = "%42";
/** Caller window id resolved from the forwarded tmux target (for self-refusal). */
let callerWindowId: string | null = "@999";
/** Busy verdict staged per test. */
let busyReturn: { busy: boolean; status: string; activity?: string } | null = {
	busy: false,
	status: "idle",
};
let closeWindowReturn: {
	ok: boolean;
	windowId?: string;
	sessionName?: string;
	sessionId?: string;
	error?: string;
} = { ok: true, windowId: "@42", sessionName: "joe", sessionId: "ses_tail" };

const killSpy = mock(() => ({ ...closeWindowReturn }));
const reconcileSpy = mock(async () => {});
const patchTabSpy = mock(async (_session: string, _windowName: string, _patch: unknown) => ({
	created: false,
	updated: true,
}));
await mockModuleRestorable("@teamscala/tmux-session/windows", (real) => ({
	...real,
	findWindow: (_session: string, _name: string) => findWindowReturn,
	firstPaneIdForWindow: (_t: string) => firstPaneReturn,
	listWindows: (_s: string) => [],
	resolvePaneWindow: (_t: string) =>
		callerWindowId ? { sessionName: "joe", windowId: callerWindowId, windowName: "Caller" } : null,
}));
await mockModuleRestorable("@teamscala/pane-inventory/busy-detect", (real) => ({
	...real,
	detectTabBusy: async () => busyReturn,
}));
await mockModuleRestorable("@teamscala/pane-inventory/agent-pane-detect", (real) => ({
	...real,
	CliKind: {},
}));
await mockModuleRestorable("@teamscala/event-log/record-event", (real) => ({
	...real,
	recordEvent: () => {},
}));
await mockModuleRestorable("@teamscala/db/prisma-registry", (real) => ({
	...real,
	getPrisma: () => ({ registry_entries: { findFirst: async () => null, findMany: async () => [], upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) } }),
}));
await mockModuleRestorable("@teamscala/db/registry/load-config", (real) => ({
	...real,
	loadRegistryConfig: async () => null,
}));
mock.module("./rename-close.ts", () => ({
	closeWindowForPane: async () => killSpy(),
}));
mock.module("./reconcile.ts", () => ({
	reconcileSessionState: async () => reconcileSpy(),
}));
mock.module("./tab-mutation.ts", () => ({
	patchTab: async (session: string, windowName: string, patch: unknown) =>
		patchTabSpy(session, windowName, patch),
}));
mock.module("./load-save.ts", () => ({
	loadSessionState: async () => ({ tabs: [], closedTabs: [] }),
}));
mock.module("./query-options.ts", () => ({
	queryActiveOptions: async () => [],
}));
await mockModuleRestorable("./state-tabs.ts", (real) => ({
	...real,
	normaliseTabs: (t: unknown) => t,
}));
afterAll(() => restoreMockedModules());


const { closeTabByName } = await import("./close-tab.ts");

beforeEach(() => {
	findWindowReturn = { id: "@42", name: "CloseMe", index: 9, active: false, panes: 1 };
	firstPaneReturn = "%42";
	callerWindowId = "@999"; // a DIFFERENT window by default (not self)
	busyReturn = { busy: false, status: "idle" };
	closeWindowReturn = { ok: true, windowId: "@42", sessionName: "joe", sessionId: "ses_tail" };
	killSpy.mockReset();
	killSpy.mockImplementation(() => ({ ...closeWindowReturn }));
	reconcileSpy.mockReset();
	reconcileSpy.mockImplementation(async () => {});
	patchTabSpy.mockReset();
	patchTabSpy.mockImplementation(async () => ({ created: false, updated: true }));

});

describe("cli-session closeTabByName", () => {
	test("NOT FOUND: an unknown window name returns ok:false and kills nothing", async () => {
		findWindowReturn = null;

		const res = await closeTabByName({ tmuxSession: "joe", windowName: "Ghost" });

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no live window named "Ghost"/);
		expect(killSpy).toHaveBeenCalledTimes(0);
	});

	test("happy path: a found idle non-self lane is killed, tail-stopped + archived", async () => {
		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
			requestedBy: "orch-1",
		});

		expect(res.ok).toBe(true);
		expect(res.windowId).toBe("@42");
		expect(res.windowName).toBe("CloseMe");
		expect(res.archived).toBe(true);
		// The lane's CLI session id is surfaced so close_agent_tab can reconcile
		// the work_items task bound to this lane in the same teardown.
		expect(res.sessionId).toBe("ses_tail");
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(reconcileSpy).toHaveBeenCalledTimes(1); // eager archive
	});

	test("SELF: targeting the caller's own window is refused and kills nothing", async () => {
		callerWindowId = "@42"; // caller is IN the target window

		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:CloseMe.1",
		});

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/refusing to close the calling pane/);
		expect(killSpy).toHaveBeenCalledTimes(0);
	});

	test("BUSY: a mid-turn lane is refused without force", async () => {
		busyReturn = { busy: true, status: "busy", activity: "thinking" };

		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
		});

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/mid-turn/);
		expect(res.error).toMatch(/force:true/);
		expect(killSpy).toHaveBeenCalledTimes(0);
	});

	test("force:true overrides the busy refusal and closes the lane", async () => {
		busyReturn = { busy: true, status: "busy", activity: "thinking" };

		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
			force: true,
		});

		expect(res.ok).toBe(true);
		expect(killSpy).toHaveBeenCalledTimes(1);
	});

	test("no callerTmuxTarget: the self-check is skipped (dashboard caller, no self-risk)", async () => {
		// A non-tmux caller (operator dashboard) passes no target — close must
		// still work, the self-check simply does not apply.
		const res = await closeTabByName({ tmuxSession: "joe", windowName: "CloseMe" });

		expect(res.ok).toBe(true);
		expect(killSpy).toHaveBeenCalledTimes(1);
	});

	test("kill failure: closeWindowForPane returning ok:false propagates without archive", async () => {
		closeWindowReturn = { ok: false, error: "tmux kill-window failed" };
		killSpy.mockImplementation(() => ({ ...closeWindowReturn }));

		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
		});

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/kill-window failed/);
		expect(reconcileSpy).toHaveBeenCalledTimes(0); // nothing to archive
	});

	test("disposition: a deliberate close stamps it onto the tab BEFORE the archive reconcile", async () => {
		// The archive entry is BORN with how the lane ended — patchTab stamps the
		// disposition onto the tab after a successful kill and before reconcile, so
		// the closedTabs entry carries it instead of the 'orphaned' default a
		// vanished lane gets. Stamped AFTER kill so a refused close leaves nothing.
		const res = await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
			disposition: "completed",
		});

		expect(res.ok).toBe(true);
		expect(patchTabSpy).toHaveBeenCalledTimes(1);
		// [session, windowName, patch] — the disposition is on the patch.
		const patchCall = patchTabSpy.mock.calls[0];
		expect(patchCall?.[0]).toBe("joe");
		expect(patchCall?.[1]).toBe("CloseMe");
		expect((patchCall?.[2] as { disposition?: string }).disposition).toBe("completed");
	});

	test("no disposition: patchTab is not called (the archive 'orphaned' default applies)", async () => {
		await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
		});

		expect(patchTabSpy).toHaveBeenCalledTimes(0);
	});

	test("disposition NOT stamped when the kill fails (no stray stamp on an open tab)", async () => {
		closeWindowReturn = { ok: false, error: "tmux kill-window failed" };
		killSpy.mockImplementation(() => ({ ...closeWindowReturn }));

		await closeTabByName({
			tmuxSession: "joe",
			windowName: "CloseMe",
			callerTmuxTarget: "joe:Caller.1",
			disposition: "completed",
		});

		expect(patchTabSpy).toHaveBeenCalledTimes(0);
	});
});
