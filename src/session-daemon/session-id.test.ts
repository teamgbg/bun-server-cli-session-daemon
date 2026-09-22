// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { isValidSessionId } from "./session-id-guard.ts";

describe("isValidSessionId", () => {
	test("accepts a full UUID v7 (the seeded shape)", () => {
		expect(isValidSessionId("019f25ae-1454-7000-aa31-0a14bf7725f9")).toBe(true);
	});

	test("accepts a full UUID v4", () => {
		expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});

	test("rejects the truncated form that bit Scala-Chrome-Ext (20 chars)", () => {
		// The live incident: stored id was cut mid-UUID. Replay would resolve
		// to nothing; the guard refuses it and falls back to a fresh seed.
		expect(isValidSessionId("019f27b6-db43-7000-b")).toBe(false);
	});

	test("rejects a prefix-only fragment", () => {
		expect(isValidSessionId("019f25ae")).toBe(false);
	});

	test("rejects a UUID missing the final block", () => {
		expect(isValidSessionId("019f25ae-1454-7000-aa31")).toBe(false);
	});

	test("rejects empty / null / undefined / wrong type", () => {
		expect(isValidSessionId("")).toBe(false);
		expect(isValidSessionId(null)).toBe(false);
		expect(isValidSessionId(undefined)).toBe(false);
	});

	test("rejects a full-shaped value with non-hex chars", () => {
		expect(isValidSessionId("019f25ae-1454-7000-aa31-0a14bf7725g9")).toBe(false); // trailing 'g'
	});
});
