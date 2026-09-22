// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { configureStandaloneOrpc } from "./standalone-orpc";

test("registers Prisma before registry and ORPC consumers", async () => {
	const calls: string[] = [];
	const prisma = {};
	const db = {
		prisma,
		disconnect: async () => undefined,
	};

	const result = await configureStandaloneOrpc("postgres://fixture", {
		createDbClient: async () => {
			calls.push("create");
			return db as never;
		},
		registerPrismaClient: (registered) => {
			calls.push("register");
			expect(registered).toBe(prisma);
		},
		loadRegistryEntries: async (registered) => {
			calls.push("registry");
			expect(registered).toBe(prisma);
		},
		configureOrpc: (config) => {
			calls.push("orpc");
			expect(config.getPrisma?.()).toBe(prisma);
		},
	}, () => calls.push("ready"));

	expect(result).toBe(db);
	expect(calls).toEqual(["create", "register", "ready", "registry", "orpc"]);
});
