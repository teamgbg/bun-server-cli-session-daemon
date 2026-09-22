// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterAll, expect, mock, test, beforeEach } from "bun:test";
import { mockModuleRestorable, restoreMockedModules } from "./mock-module-restore.ts";

const ensured: string[] = [];
const reconciled: string[] = [];
let pickerFailsFor: string | null = null;

await mockModuleRestorable("./picker-home-window.ts", (real) => ({
	...real,
	ensurePickerHomeWindow: (session: string) => {
		if (session === pickerFailsFor) throw new Error("tmux picker window failed");
		ensured.push(session);
	},
}));


mock.module("./reconcile.ts", () => ({
  reconcileSessionState: async (session: string) => {
		reconciled.push(session);
	},
}));

await mockModuleRestorable("@teamscala/tmux-session/session/list-sessions", (real) => ({
	...real,
	listSessions: () => ["joe", "anna"],
}));

await mockModuleRestorable("@teamscala/tmux-session/windows", (real) => ({
	...real,
	listWindows: () => [{ name: "picker" }, { name: "btop" }],
}));

await mockModuleRestorable("@teamscala/logger/app-loggers", (real) => ({
	...real,
	getAppLogger: () => ({ error: () => {}, warn: () => {}, info: () => {} }),
}));
afterAll(() => restoreMockedModules());

const { reconcileAll } = await import("./reconcile-all.ts");

beforeEach(() => {
	ensured.length = 0;
	reconciled.length = 0;
	pickerFailsFor = null;
});

test("every live session gets its picker home window re-ensured on each sweep", async () => {
	const code = await reconcileAll();

	// The invariant: the sweep holds the picker true, it does not assume a
	// prior restore created it.
	expect(ensured).toEqual(["joe", "anna"]);
	expect(code).toBe(0);
});

test("a session whose picker cannot be ensured does not strand later sessions", async () => {
	pickerFailsFor = "joe";

	const code = await reconcileAll();

	// joe's picker failed, but anna's still got ensured and BOTH sessions still
	// had their tabs[] reconciled — a throw here used to abandon the rest.
	expect(ensured).toEqual(["anna"]);
	expect(reconciled).toEqual(["joe", "anna"]);
	// non-zero so the daemon's watchdog probe sees the degraded pass
	expect(code).toBe(1);
});
