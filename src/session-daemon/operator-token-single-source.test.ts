// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const sharedImport = "@teamscala/session-contracts/operator-spawn-token";

describe("operator spawn token has one source", () => {
	test("daemon and picker consumers import the session contract", async () => {
		for (const relativePath of [
			"routes.ts",
			"show-menu.ts",
			"../picker-tui/picker-rpc.ts",
		]) {
			const source = await Bun.file(join(import.meta.dir, relativePath)).text();
			expect(source).toContain(sharedImport);
		}
	});

	test("the retired executable-local token module stays deleted", async () => {
		expect((await Bun.file(join(import.meta.dir, "operator-spawn-token.ts")).exists())).toBe(false);
	});
});
