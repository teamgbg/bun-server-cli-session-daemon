// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { registerCliSession } from "./register-cli-session";

function fakePrisma(existing: Record<string, unknown> | null = null) {
	const updates: Record<string, unknown>[] = [];
	const creates: Record<string, unknown>[] = [];
	return {
		prisma: {
			cli_sessions: {
				findFirst: async () => existing,
				update: async ({ data }: { data: Record<string, unknown> }) => {
					updates.push(data);
					return existing;
				},
				create: async ({ data }: { data: Record<string, unknown> }) => {
					creates.push(data);
					return { id: "session-created" };
				},
			},
			work_items: {
				findUnique: async () => ({ kind_data: { role: "worker" } }),
			},
		} as never,
		updates,
		creates,
	};
}

const input = {
	workItemId: "work-1",
	windowName: "Lane",
	optionSlug: "codex",
	provider: "codex",
};

describe("registerCliSession terminal lifecycle contract", () => {
	test("verified provider identity creates a ready session", async () => {
		const { prisma, creates } = fakePrisma();
		await registerCliSession({ ...input, prisma, nativeSessionId: "native-1" });
		expect(creates[0]).toMatchObject({ lifecycle_state: "ready" });
	});

	test("unverified provider identity remains registering", async () => {
		const { prisma, creates } = fakePrisma();
		await registerCliSession({ ...input, prisma });
		expect(creates[0]).toMatchObject({ lifecycle_state: "registering" });
	});

	test("late identity binding advances an open row to ready", async () => {
		const { prisma, updates } = fakePrisma({
			id: "session-existing",
			provider_native_session_id: null,
		});
		await registerCliSession({ ...input, prisma, nativeSessionId: "native-1" });
		expect(updates[0]).toMatchObject({
			provider_native_session_id: "native-1",
			lifecycle_state: "ready",
		});
	});
});
