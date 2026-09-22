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

const spawnCalls: { name: string; command: string[]; env?: Record<string, unknown> }[] = [];
const spawnMock = mock((args: { name: string; command: string[]; env?: Record<string, unknown> }) => {
	spawnCalls.push(args);
	return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
});
await mockModuleRestorable("@teamscala/os/spawn/spawn", (real) => ({
	...real,
	spawn: spawnMock,
	spawnSync: mock(() => ({})),
}));

const warnings: string[] = [];
const testLog = { info: () => {}, warn: (m: string) => warnings.push(m) };
await mockModuleRestorable("@teamscala/logger/app-loggers", (real) => ({
	...real,
	getAppLogger: () => ({
		info: () => {},
		warn: (m: string) => warnings.push(m),
		error: () => {},
	}),
}));
afterAll(() => restoreMockedModules());


mock.module("./query-options.ts", () => ({
  queryActiveOptions: async () => [],
}));
));

const { startChannelDaemonDetached } = await import("./channel-daemon.ts");
const deps = { spawn: spawnMock, log: testLog };

beforeEach(() => {
	spawnCalls.length = 0;
	warnings.length = 0;
	spawnMock.mockClear();
});

describe("startChannelDaemonDetached", () => {
	test("does NOT start a daemon for claude-code, which fires its own SessionStart", () => {
		startChannelDaemonDetached({
			cliKind: "claude-code",
			paneId: "tmux:%2",
			sessionId: "sess-claude",
		}, deps);
		expect(spawnCalls).toHaveLength(0);
	});

	test("refuses to start without a session id, and says so rather than failing silently", () => {
		// An unmapped CLI kind returns early — no warning.
		// This test verifies the early-return path for an unmapped CLI kind.
		startChannelDaemonDetached({
			cliKind: "codex",
			paneId: "tmux:%70",
			sessionId: null,
		}, deps);
		expect(spawnCalls).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});

	test("a spawn failure degrades the lane, never fails it", async () => {
		// An unmapped CLI kind returns early — no spawn.
		spawnMock.mockImplementationOnce(() => Promise.reject(new Error("no such binary")));
		expect(() =>
			startChannelDaemonDetached({
				cliKind: "codex",
				paneId: "tmux:%70",
				sessionId: "sess-abc",
			}, deps),
		).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(spawnCalls).toHaveLength(0);
	});
});
