// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, it } from "bun:test";
import { resolveSpawnRoutePolicy } from "./spawn-route-policy.ts";

describe("resolveSpawnRoutePolicy", () => {
	it("always gives an authenticated operator spawn operator policy", () => {
		expect(
			resolveSpawnRoutePolicy(
				"operator",
				{ operatorToken: "current", requestedBy: "operator:picker" },
				"current",
			),
		).toEqual({
			ok: true,
			requestedBy: "operator:picker",
			enforceRuntimePolicy: false,
		});
	});

	it("never converts a stale operator token into fleet policy", () => {
		const verdict = resolveSpawnRoutePolicy(
			"operator",
			{ operatorToken: "stale", requestedBy: "operator:picker" },
			"current",
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.status).toBe(403);
	});

	it("always gives an attributed fleet spawn fleet policy", () => {
		expect(
			resolveSpawnRoutePolicy(
				"fleet",
				{ operatorToken: "current", requestedBy: "gateway:orchestrator" },
				"current",
			),
		).toEqual({
			ok: true,
			requestedBy: "gateway:orchestrator",
			enforceRuntimePolicy: true,
		});
	});

	it("refuses an unattributed fleet spawn", () => {
		const verdict = resolveSpawnRoutePolicy("fleet", { lanePane: "self-asserted" }, "current");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.status).toBe(400);
	});
});
