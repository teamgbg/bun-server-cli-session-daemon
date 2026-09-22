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

/** Captured killWindow target — the tmux boundary where mis-targeting is observable. */
let lastKillTarget: string | null = null;
/** The pane id EXACTLY as handed to tmux (so the tmux:%N → %N normalisation is observable). */
let seenPane: string | null = null;
let resolvePaneReturn: { sessionName: string; windowId: string; windowName: string } | null = {
	sessionName: "moss",
	windowId: "@9",
	windowName: "CloseKillsTab",
};
/** Staged pane PID. null = panePid returns null (no scope to kill). */
let stagedPid: number | null = 12345;
/** Staged return from killScopeForPid. */
let stagedScopeKillResult: boolean = true;
/** What windowExists reports. Default false = window already gone (scope took it). */
let windowExistsReturn: boolean = false;
/** killWindow return value. */
let killWindowReturn: boolean = true;
/** Side effect of killWindow on the window's liveness — default: a kill takes the window. */
let killEffect: () => void = () => {
	windowExistsReturn = false;
};

const findFirstMock = mock(async (): Promise<Record<string, unknown> | null> => null);
await mockModuleRestorable("@teamscala/tmux-session/windows", (real) => ({
	...real,
	resolvePaneWindow: (paneId: string) => {
		seenPane = paneId;
		return resolvePaneReturn;
	},
	killWindow: (target: string) => {
		lastKillTarget = target;
		killEffect();
		return killWindowReturn;
	},
	windowExists: () => windowExistsReturn,
	listWindows: () => [],
	firstPaneIdForWindow: () => null,
	inspectLiveWindow: () => null,
	setAutomaticRename: () => true,
	setOptionSlugMarker: () => {},
	panePid: () => stagedPid,
}));
await mockModuleRestorable("@teamscala/tmux-session/pane", (real) => ({
	...real,
	renameWindow: () => {},
}));
await mockModuleRestorable("@teamscala/tmux-session/command-runner", (real) => ({
	...real,
	run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));
await mockModuleRestorable("./scope-kill.ts", (real) => ({
	...real,
	killScopeForPid: async (_pid: number) => stagedScopeKillResult,
	scopeUnitForPid: async () => "run-p-stub.scope",
}));
await mockModuleRestorable("@teamscala/db/prisma-registry", (real) => ({
	...real,
	getPrisma: () => ({ registry_entries: { findFirst: findFirstMock, findMany: async () => [], upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) } }),
}));
await mockModuleRestorable("@teamscala/db/registry/load-config", (real) => ({
	...real,
	loadRegistryConfig: async () => null,
}));
afterAll(() => restoreMockedModules());

const { closeWindowForPane } = await import("./rename-close.ts?subject=closeWindowForPane");

beforeEach(() => {
	lastKillTarget = null;
	seenPane = null;
	resolvePaneReturn = { sessionName: "moss", windowId: "@9", windowName: "CloseKillsTab" };
	stagedPid = 12345;
	stagedScopeKillResult = true;
	windowExistsReturn = false;
	killWindowReturn = true;
	killEffect = () => {
		windowExistsReturn = false;
	};
	findFirstMock.mockReset();
	findFirstMock.mockResolvedValue(null);
});

describe("cli-session closeWindowForPane", () => {
	test("THE FIX: a scope kill that takes the window with it reports ok:true WITHOUT calling kill-window", async () => {
		// The scope kill succeeded and the window is already gone — exactly the
		// 2026-07-31 defect condition. kill-window must NOT run (nothing to kill),
		// and the close must report success because the END STATE is verified.
		stagedScopeKillResult = true;
		windowExistsReturn = false; // scope took the window

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(true);
		expect(res.windowId).toBe("@9");
		// kill-window was never invoked — there was nothing left to kill.
		expect(lastKillTarget).toBeNull();
	});

	test("a window still present after the scope kill is killed BY WINDOW ID, then its absence verified", async () => {
		// The scope did not take the window (e.g. remain-on-exit kept a dead
		// pane), so an explicit kill-window by id is the fallback — never by name
		// or index (names repeat, indices renumber on close → wrong lane).
		stagedScopeKillResult = true;
		windowExistsReturn = true; // window survived the scope
		// A successful kill-window takes the window (default killEffect).

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(true);
		expect(res.windowId).toBe("@9");
		// Killed by the durable window id, not a name/index.
		expect(lastKillTarget).toBe("@9");
	});

	test("a window that survives an explicit kill-window reports ok:false (half-failure, honestly)", async () => {
		// The scope terminated but the window refused to die — a genuine
		// half-failure. Reporting ok:true here would be the inverse defect:
		// advertising a state the function never verified.
		stagedScopeKillResult = true;
		windowExistsReturn = true; // present before AND after the kill
		killEffect = () => {}; // kill-window has no effect

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(false);
		expect(res.windowId).toBe("@9");
		expect(res.error).toMatch(/still live/);
		expect(lastKillTarget).toBe("@9"); // the kill was attempted
	});

	test("normalises the fleet identity form tmux:%N to the raw %N at the boundary", async () => {
		// Window present so the kill-by-id path runs and the resolved id is the
		// observable target.
		windowExistsReturn = true;

		await closeWindowForPane("tmux:%9");

		expect(seenPane).toBe("%9");
		expect(lastKillTarget).toBe("@9");
	});

	test("returns ok:false (no throw) when the pane is unknown", async () => {
		resolvePaneReturn = null;

		const res = await closeWindowForPane("tmux:%404");

		expect(res.ok).toBe(false);
		expect(lastKillTarget).toBeNull();
		expect(res.error).toMatch(/not found/);
	});

	test("surfaces the tab's captured sessionId so the route can stop the tail", async () => {
		findFirstMock.mockResolvedValueOnce({
			config: {
				tabs: [
					{
						windowName: "CloseKillsTab",
						windowId: "@9",
						optionSlug: "cc-glm52",
						sessionId: "ses_tailkey",
					},
				],
				closedTabs: [],
			},
		});

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(true);
		expect(res.sessionId).toBe("ses_tailkey");
	});

	test("no pane PID (panePid returns null) — scope kill skipped, window killed by id when still present", async () => {
		// No scope to kill (panePid null), but the window is still present, so the
		// explicit kill-window by id is the sole teardown.
		stagedPid = null;
		windowExistsReturn = true;

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(true);
		expect(lastKillTarget).toBe("@9");
	});

	test("scope kill failure returns ok:false with the error and kills no window", async () => {
		stagedScopeKillResult = false;

		const res = await closeWindowForPane("%9");

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/refused SIGTERM and SIGKILL/);
		// Window was NOT killed — the scope kill failed first
		expect(lastKillTarget).toBeNull();
	});
});
