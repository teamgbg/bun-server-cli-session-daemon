// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { assertFleetSpawnable } from "./spawn-runtime-policy.ts";

const OPTIONS = [
	{ slug: "codex-luna", config: { fleet_enabled: true } },
	{ slug: "cc-opus", config: { fleet_enabled: true } },
	{
		slug: "cc-glm52",
		config: {
			fleet_enabled: false,
			unavailable_reason: "Reserved for operator launches.",
		},
	},
];

describe("assertFleetSpawnable — the launch row bounds fleet spawn", () => {
	test("allows an explicitly fleet-enabled option", () => {
		expect(assertFleetSpawnable(OPTIONS[0]!, OPTIONS).ok).toBe(true);
	});

	test("refuses a disabled option by name, with reason and usable alternatives", () => {
		const verdict = assertFleetSpawnable(OPTIONS[2]!, OPTIONS);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.error).toContain("cc-glm52");
		expect(verdict.error).toContain("Reserved for operator launches.");
		expect(verdict.error).toContain("codex-luna");
		expect(verdict.error).toContain("cc-opus");
		expect(verdict.error).toContain("operator may still open any CLI by hand");
	});

	test("a missing eligibility declaration fails closed", () => {
		const verdict = assertFleetSpawnable(
			{ slug: "bash", config: {} },
			OPTIONS,
		);
		expect(verdict.ok).toBe(false);
	});
});
