// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { assertSafeOpsCommand } from "./spawn-ops.ts";

describe("ops tmux target safety", () => {
	test("refuses the picker-reload incident shape", () => {
		expect(() =>
			assertSafeOpsCommand("tmux respawn-window -k 'bun picker.ts'"),
		).toThrow("requires an explicit -t target");
	});

	test("accepts an exact targeted picker reload", () => {
		expect(() =>
			assertSafeOpsCommand("tmux respawn-window -k -t '=picker' 'bun picker.ts'"),
		).not.toThrow();
	});

	test("does not constrain non-mutating ops commands", () => {
		expect(() => assertSafeOpsCommand("pm2 status")).not.toThrow();
	});
});
