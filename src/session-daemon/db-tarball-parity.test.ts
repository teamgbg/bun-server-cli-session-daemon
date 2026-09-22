// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, test, expect } from "bun:test";
import { join, dirname } from "node:path";

/** Resolve the installed @teamscala/db package root from its client entry. */
function resolveDbPackageDir(): string {
	const clientPath = require.resolve("@teamscala/db/client");
	// client.ts lives at <pkg>/src/client.ts — go up one to the package root
	return dirname(dirname(clientPath));
}

describe("installed @teamscala/db tarball contains generated models", () => {
	const pkgDir = resolveDbPackageDir();
	const generatedClient = join(pkgDir, "generated", "client", "client.ts");

	test("generated client file exists in the installed package", async () => {
		expect((await Bun.file(generatedClient).exists())).toBe(true);
	});

	test("host_commands model is present (the picker's dependency)", async () => {
		const src = await Bun.file(generatedClient).text();
		expect(src).toContain("host_commands");
	});

	test("PrismaClient is exported (the typed client the producer uses)", async () => {
		const src = await Bun.file(generatedClient).text();
		expect(src).toMatch(/export.*PrismaClient/);
	});
});
