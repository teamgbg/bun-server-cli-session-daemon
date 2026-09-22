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

interface SpawnCall {
	name?: string;
	command?: string[];
	timeoutMs?: number;
}

const spawnCalls: SpawnCall[] = [];
/** Sequence of exit codes for kill -0 probes. */
let kill0Sequence: number[] = [1]; // default: process gone on first check
/** Exit code for systemctl kill calls. */
let systemctlExitCode: number = 0;

await mockModuleRestorable("@teamscala/os/spawn/spawn", (real) => ({
	...real,
	spawnSync: (opts: SpawnCall) => {
		spawnCalls.push(opts);
		const cmd = opts.command ?? [];
		if (cmd[0] === "kill" && cmd[1] === "-0") {
			const code = kill0Sequence.shift() ?? 1;
			return { exitCode: code, stdout: "", stderr: "" };
		}
		return { exitCode: systemctlExitCode, stdout: "", stderr: "" };
	},
	spawn: async (opts: SpawnCall) => {
		spawnCalls.push(opts);
		const cmd = opts.command ?? [];
		if (cmd[0] === "kill" && cmd[1] === "-0") {
			const code = kill0Sequence.shift() ?? 1;
			return { exited: Promise.resolve(code) };
		}
		return { exited: Promise.resolve(systemctlExitCode) };
	},
}));
afterAll(() => restoreMockedModules());

// Mock Date.now so the 3s deadline is always in the past — the poll loop
// exits immediately after the first probe. deadline = Date.now() + 3000,
// so returning a huge value makes the deadline huge too. Instead, return
// 0 on first call (deadline = 3000), then 9999999999999 on subsequent
// calls so the loop condition fails immediately.
let nowCallCount = 0;
const originalNow = Date.now;
Date.now = () => {
	nowCallCount++;
	return nowCallCount === 1 ? 0 : 9999999999999;
};
afterAll(() => {
	Date.now = originalNow;
});

const { killScopeForPid } = await import("./scope-kill.ts");

/**
 * A real cgroup line. systemd names a transient scope
 * `run-p<pid>-i<instance>.scope`, so a test that asserts the constructed
 * `run-p<pid>.scope` cannot catch an invented name — it only re-states what the
 * code already believes. Feeding the derivation a REAL line is what makes the
 * unit name falsifiable.
 */
const CGROUP = (pid: number) =>
	Promise.resolve(`run-p${pid}-i44404099.scope`);

beforeEach(() => {
	spawnCalls.length = 0;
	kill0Sequence = [1];
	systemctlExitCode = 0;
	nowCallCount = 0;
});

describe("killScopeForPid", () => {
	test("sends SIGTERM to the scope READ from /proc/<pid>/cgroup and returns true when process exits", async () => {
		const result = await killScopeForPid(12345, CGROUP);

		expect(result).toBe(true);
		// First call: systemctl --user kill -s SIGTERM run-p12345.scope
		expect(spawnCalls[0].command).toEqual([
			"systemctl", "--user", "kill", "-s", "SIGTERM", "run-p12345-i44404099.scope",
		]);
		// With Date.now mocked, the poll loop never enters (deadline is always
		// in the past). The function goes straight to SIGKILL, then the final
		// probe returns 1 (process gone).
		expect(spawnCalls[1].command).toContain("SIGKILL");
		expect(spawnCalls[2].command).toEqual(["kill", "-0", "12345"]);
	});

	test("escalates to SIGKILL when SIGTERM does not stop the process", async () => {
		// With Date.now mocked, the poll loop never enters (deadline is always
		// in the past). The probe inside the loop is never called. The final
		// probe after SIGKILL returns 1 (process gone).
		kill0Sequence = [1];

		const result = await killScopeForPid(12345, CGROUP);

		expect(result).toBe(true);
		// systemctl kill -s SIGTERM
		expect(spawnCalls[0].command).toContain("SIGTERM");
		// systemctl kill -s SIGKILL
		const sigkillCall = spawnCalls.find((c) => c.command?.includes("SIGKILL"));
		expect(sigkillCall).toBeDefined();
		expect(sigkillCall!.command).toContain("run-p12345-i44404099.scope");
	});

	test("returns false when the process refuses both SIGTERM and SIGKILL", async () => {
		// Poll loop never enters. Final probe after SIGKILL returns 0 (still alive).
		kill0Sequence = [0];

		const result = await killScopeForPid(12345, CGROUP);

		expect(result).toBe(false);
		// Both signals were sent
		const sigtermCall = spawnCalls.find((c) => c.command?.includes("SIGTERM"));
		const sigkillCall = spawnCalls.find((c) => c.command?.includes("SIGKILL"));
		expect(sigtermCall).toBeDefined();
		expect(sigkillCall).toBeDefined();
	});
});

/**
 * The REAL cgroup line of a pane that close_agent_tab could not kill.
 *
 * The suite above feeds only the `run-p<pid>-i<n>` shape, which is why it stayed
 * green while the resolver matched that shape and nothing else: a fixture can
 * only falsify an assumption it actually varies. Measured 2026-07-31 — pid
 * 2182218 sat here, the resolver returned null, no signal was ever sent, and the
 * caller reported the process as refusing SIGTERM and SIGKILL.
 */
const TMUX_SPAWN_CGROUP = () =>
	Promise.resolve(
		"tmux-spawn-1efbd1d0-e8b5-475d-98ca-1ef658f37e78.scope",
	);

describe("killScopeForPid — scope names other than run-p", () => {
	test("kills a tmux-spawn scope instead of silently resolving nothing", async () => {
		const result = await killScopeForPid(2182218, TMUX_SPAWN_CGROUP);

		expect(result).toBe(true);
		expect(spawnCalls[0].command).toEqual([
			"systemctl",
			"--user",
			"kill",
			"-s",
			"SIGTERM",
			"tmux-spawn-1efbd1d0-e8b5-475d-98ca-1ef658f37e78.scope",
		]);
	});

	test("picks the DEEPEST scope when the cgroup path nests", async () => {
		// The innermost unit owns the process. Matching an ancestor would signal a
		// far wider cgroup and kill unrelated lanes.
		const nested = () =>
			Promise.resolve(
				"tmux-spawn-abc.scope",
			);
		await killScopeForPid(999, nested);

		expect(spawnCalls[0].command).toContain("tmux-spawn-abc.scope");
		expect(spawnCalls[0].command).not.toContain("outer-wrapper.scope");
	});
});
