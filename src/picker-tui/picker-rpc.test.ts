// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OPERATOR_TOKEN_HEADER, readOperatorToken } from "@teamscala/session-contracts/operator-spawn-token";

let lastInit: RequestInit | undefined;
const realFetch = globalThis.fetch;
const realPane = process.env.TMUX_PANE;
const realRuntimeDir = process.env.XDG_RUNTIME_DIR;

beforeEach(() => {
	lastInit = undefined;
	globalThis.fetch = ((_url: string, init: RequestInit) => {
		lastInit = init;
		return Promise.resolve(new Response(JSON.stringify({ ok: true })));
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = realPane;
	if (realRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = realRuntimeDir;
});

function headerOf(name: string): string | undefined {
	return (lastInit?.headers as Record<string, string> | undefined)?.[name];
}

describe("spawnOption — caller identity", () => {
	test("inside a tmux pane, attributes the spawn to that pane", async () => {
		process.env.TMUX_PANE = "%42";
		const { spawnOption } = await import("./picker-rpc.ts");
		await spawnOption("pi", "joe");
		expect(headerOf("x-requested-by")).toBe("tmux:%42");
		expect(headerOf("x-lane-pane")).toBe("tmux:%42");
	});

	test("with NO TMUX_PANE, still sends an identity — the operator", async () => {
		// The exact outage shape. Before the fix this sent no x-requested-by at
		// all and the daemon answered 400, so the operator's primary way of
		// opening a CLI silently stopped working.
		delete process.env.TMUX_PANE;
		const { spawnOption } = await import("./picker-rpc.ts");
		const r = await spawnOption("pi", "joe");
		expect(headerOf("x-requested-by")).toBe("operator:picker-tui");
		expect(r.ok).toBe(true);
	});

	test("the identity header is never absent", async () => {
		// Stated separately and without a value assertion: the failure mode is an
		// ABSENT header, and this is the assertion that catches it however the
		// attribution is spelled later.
		for (const pane of ["%7", undefined]) {
			if (pane) process.env.TMUX_PANE = pane;
			else delete process.env.TMUX_PANE;
			const { spawnOption } = await import("./picker-rpc.ts");
			await spawnOption("pi", "joe");
			expect(headerOf("x-requested-by")).toBeTruthy();
		}
	});

	test("every operator spawn presents the daemon-minted token", async () => {
		const token = readOperatorToken();
		expect(token).toBeTruthy();
		const { spawnOption } = await import("./picker-rpc.ts");
		await spawnOption("pi", "joe");
		expect(headerOf(OPERATOR_TOKEN_HEADER)).toBe(token ?? undefined);
	});

	test("a missing operator token fails loudly without sending a request", async () => {
		process.env.XDG_RUNTIME_DIR = `/tmp/picker-token-missing-${crypto.randomUUID()}`;
		const { spawnOption } = await import("./picker-rpc.ts");
		const r = await spawnOption("pi", "joe");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("operator spawn token is unavailable");
		expect(lastInit).toBeUndefined();
	});
});
