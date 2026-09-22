// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { validateCanonicalWorkItem } from "./spawn-route-handler.ts";

describe("fleet spawn assignment boundary", () => {
	test("operator spawn has no assignment and does not require the task service", () => {
		expect(validateCanonicalWorkItem(undefined)).toEqual({ ok: false, error: "spawn requires a canonical workItemId" });
	});

	test("fresh fleet spawn without a canonical task refuses before emission", () => {
		expect(validateCanonicalWorkItem(undefined)).toEqual({ ok: false, error: "spawn requires a canonical workItemId" });
	});

	test("fleet spawn with a canonical task preserves exactly that id for one emission", () => {
		expect(validateCanonicalWorkItem("task-123")).toEqual({ ok: true, workItemId: "task-123" });
	});
});
