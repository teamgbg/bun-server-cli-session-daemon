// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { resolvePaneWindow, windowExists } from "@teamscala/tmux-session/windows";

// Stub ONLY the DB layer so loadSessionState degrades to {tabs:[]} (no
// sessionId) without a live database. tmux-session + scope-kill stay REAL — the
// close must hit real systemctl and real tmux.
const findFirstMock = mock(async () => null);
mock.module("@teamscala/db/prisma-registry", () => ({
	getPrisma: () => ({
		registry_entries: {
			findFirst: findFirstMock,
			findMany: async () => [],
			upsert: async () => ({}),
			deleteMany: async () => ({ count: 0 }),
		},
	}),
}));
mock.module("@teamscala/db/registry/load-config", () => ({ loadRegistryConfig: async () => null }));

const { closeWindowForPane } = await import("./rename-close.ts");

/** Throwaway session name, unique per test run so parallel runs never collide. */
const SESSION = `cs-close-it-${process.pid}-${Date.now().toString(36)}`;

function tmux(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const r = Bun.spawnSync({ cmd: ["tmux", ...args], stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: r.exitCode ?? 1,
		stdout: r.stdout?.toString() ?? "",
		stderr: r.stderr?.toString() ?? "",
	};
}

/** A process's pid is dead when `kill -0` fails (no such process). */
function pidDead(pid: number): boolean {
	return Bun.spawnSync({ cmd: ["kill", "-0", String(pid)], stdout: "ignore", stderr: "ignore" }).exitCode !== 0;
}

/** Whether a window id is still a member of the session — the reliable
 *  liveness signal (independent of display-message's exit-code quirk). */
function windowInSession(windowId: string): boolean {
	return tmux(["list-windows", "-t", SESSION, "-F", "#{window_id}"]).stdout
		.split("\n")
		.map((s) => s.trim())
		.includes(windowId);
}

beforeAll(() => {
	// Fresh throwaway session so a close never targets an operator pane. Killed
	// in afterAll regardless of outcome.
	tmux(["new-session", "-d", "-s", SESSION]);
});

afterAll(() => {
	tmux(["kill-session", "-t", SESSION]);
});

/**
 * Canary: this suite needs the REAL @teamscala/tmux-session/windows. bun's
 * mock.module is process-GLOBAL, so a sibling test file that stubs this module
 * (even one that spreads the real module overrides resolvePaneWindow) makes the
 * real close path untestable in a shared run. Detect that and skip cleanly —
 * invoke this file in its own `bun test` process for real-tmux coverage. The
 * canary resolves a REAL throwaway pane and checks the resolved session matches;
 * a mock that returns staged data for any target fails it.
 */
let realModulesAvailable = true;
try {
	const canary = `cs-canary-${process.pid}`;
	tmux(["new-session", "-d", "-s", canary]);
	tmux(["new-window", "-d", "-t", canary, "-n", "c", "sleep 5"]);
	Bun.sleepSync(150);
	const cwin = tmux(["list-windows", "-t", canary, "-F", "#{window_id}|#{window_name}"]).stdout
		.split("\n")
		.find((l) => l.endsWith("|c"))!
		.split("|")[0];
	const cpane = tmux(["list-panes", "-t", cwin, "-F", "#{pane_id}"]).stdout.trim().split("\n")[0];
	const resolved = resolvePaneWindow(cpane);
	realModulesAvailable = !!resolved && resolved.sessionName === canary && windowExists(cwin);
	tmux(["kill-session", "-t", canary]);
} catch {
	realModulesAvailable = false;
}

/** Spawn a lane-like window: a long-lived process inside a systemd-run scope. */
function spawnScopedWindow(name: string): { windowId: string; paneId: string; pid: number } {
	tmux([
		"new-window",
		"-d",
		"-t",
		SESSION,
		"-n",
		name,
		// Mirrors a real lane spawn: systemd-run --user --scope wraps the command,
		// so the pane process lives in a transient scope that survives a bare
		// window kill and must be terminated explicitly. sleep stands in for the CLI.
		"systemd-run --user --quiet --slice=ai-cli.slice --scope -- sleep 300",
	]);
	// Let the scope + process settle so /proc/<pid>/cgroup is readable.
	for (let i = 0; i < 30; i++) {
		const w = tmux(["list-windows", "-t", SESSION, "-F", "#{window_id}|#{window_name}"]);
		const line = w.stdout.split("\n").find((l) => l.endsWith(`|${name}`));
		if (!line) {
			Bun.sleepSync(50);
			continue;
		}
		const windowId = line.split("|")[0];
		const paneId = tmux(["list-panes", "-t", windowId, "-F", "#{pane_id}"]).stdout.trim().split("\n")[0];
		const pidStr = tmux(["display-message", "-p", "-t", paneId, "-F", "#{pane_pid}"]).stdout.trim();
		const pid = Number(pidStr);
		if (paneId && Number.isFinite(pid) && pid > 0) {
			return { windowId, paneId, pid };
		}
		Bun.sleepSync(50);
	}
	throw new Error(`scoped window ${name} did not come up with a resolvable pane+pid`);
}

describe.skipIf(!realModulesAvailable)("closeWindowForPane — real tmux + real systemd", () => {
	test("THE FIX: scope kill takes the window with it → close reports ok:true and kill-window finds nothing", async () => {
		const { windowId, paneId, pid } = spawnScopedWindow("ReproScopeTookWindow");

		// Sanity: the window + process are live before the close.
		expect(windowInSession(windowId)).toBe(true);
		expect(windowExists(windowId)).toBe(true);
		expect(pidDead(pid)).toBe(false);

		// The real close: real systemctl SIGTERM/SIGKILL on the scope, then the
		// verify-the-end-state path. Before the fix this returned ok:false
		// ("kill-window failed (window already gone or id stale)").
		const res = await closeWindowForPane(paneId);

		// The returned ok MUST match the verified end state. The scope took the
		// window AND the process, so the close fully succeeded.
		expect(res.ok).toBe(true);
		expect(res.windowId).toBe(windowId);

		// Independently verify the real outcome the result claims — via two
		// independent signals (session membership + the primitive + pid probe).
		expect(windowInSession(windowId)).toBe(false);
		expect(windowExists(windowId)).toBe(false);
		expect(pidDead(pid)).toBe(true);
	});

	test("a window with no scope (plain process) is killed explicitly and reports ok:true", async () => {
		// A pane whose process is NOT in a systemd scope — panePid resolves but
		// killScopeForPid finds no scope unit, so the window must be taken down by
		// the explicit kill-window + verify path. Guards the OTHER direction: when
		// the scope does NOT take the window, the explicit kill is what makes
		// ok:true true.
		tmux(["new-window", "-d", "-t", SESSION, "-n", "PlainProc", "sleep 300"]);
		let windowId = "";
		let paneId = "";
		let pid = 0;
		for (let i = 0; i < 30; i++) {
			const w = tmux(["list-windows", "-t", SESSION, "-F", "#{window_id}|#{window_name}"]);
			const line = w.stdout.split("\n").find((l) => l.endsWith("|PlainProc"));
			if (line) {
				windowId = line.split("|")[0];
				paneId = tmux(["list-panes", "-t", windowId, "-F", "#{pane_id}"]).stdout.trim().split("\n")[0];
				pid = Number(tmux(["display-message", "-p", "-t", paneId, "-F", "#{pane_pid}"]).stdout.trim());
				if (paneId && pid > 0) break;
			}
			Bun.sleepSync(50);
		}
		expect(pid).toBeGreaterThan(0);
		expect(windowInSession(windowId)).toBe(true);

		const res = await closeWindowForPane(paneId);

		// ok:true must coincide with the window actually being gone.
		expect(res.ok).toBe(true);
		expect(windowInSession(windowId)).toBe(false);
		expect(windowExists(windowId)).toBe(false);
	});
});
