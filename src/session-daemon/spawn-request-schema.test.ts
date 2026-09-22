// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, it } from "bun:test";
import { parseSpawnRequest } from "./spawn-request-schema.ts";

describe("spawn request schemas", () => {
	it("accepts an operator picker selection without fleet fields", () => {
		expect(parseSpawnRequest("operator", { slug: "codex", focus: true }).ok).toBe(true);
	});

	it("rejects the former fleetDispatch switch on the operator schema", () => {
		expect(
			parseSpawnRequest("operator", { slug: "codex", fleetDispatch: true }).ok,
		).toBe(false);
	});

	it("rejects a fleet assignment field on the operator schema", () => {
		expect(
			parseSpawnRequest("operator", { slug: "codex", workItemId: "work-1" }).ok,
		).toBe(false);
	});

	it("requires fleet intent to be fresh or resume", () => {
		expect(parseSpawnRequest("fleet", { slug: "codex" }).ok).toBe(false);
	});

	it("accepts a fresh fleet lane without a resume id", () => {
		expect(
			parseSpawnRequest("fleet", {
				slug: "codex",
				mode: "fresh",
				workItemId: "work-1",
			}).ok,
		).toBe(true);
	});

	it("rejects resume fields from the fresh fleet schema", () => {
		expect(
			parseSpawnRequest("fleet", {
				slug: "codex",
				mode: "fresh",
				resumeId: "session-1",
			}).ok,
		).toBe(false);
	});

	it("requires a resume id for fleet resume", () => {
		expect(parseSpawnRequest("fleet", { slug: "codex", mode: "resume" }).ok).toBe(false);
		expect(
			parseSpawnRequest("fleet", {
				slug: "codex",
				mode: "resume",
				resumeId: "session-1",
			}).ok,
		).toBe(true);
	});
});
