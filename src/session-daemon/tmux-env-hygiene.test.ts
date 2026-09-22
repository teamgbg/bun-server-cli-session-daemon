// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	ORCHESTRATOR_IDENTITY_VARS,
	SERVICE_IDENTITY_VARS,
	leakedIdentityVars,
} from "./tmux-env-hygiene.ts";

/**
 * The parsing half is tested directly against `show-environment -g` output;
 * the removal half is a pair of tmux calls with no logic worth mocking.
 *
 * The fixture is the REAL leak as captured on 2026-07-31 — session-picker's
 * identity sitting in the tmux server environment, which is what put
 * scala-quiz on port 3021, PLUS the SCALA_ORCH_SESSION_ID leak (the third
 * instance of the class) which shared one stale orchestrator identity across
 * every pane.
 */
const LEAKED_SERVER_ENV = [
	"PATH=/home/joe-bellissimo/.bun/bin:/usr/bin",
	"PORT=3021",
	"SERVICE_SLUG=session-picker",
	"SCALA_ORCH_SESSION_ID=tmux:%234",
	"SESSION_PICKER_URL=http://127.0.0.1:3021",
	"TMUX_TMPDIR=/run/user/1000",
];

	describe("leakedIdentityVars", () => {
	test("the live bug: finds session-picker's identity in the tmux server env", () => {
		expect(leakedIdentityVars(LEAKED_SERVER_ENV).sort()).toEqual([
			"PORT",
			"SCALA_ORCH_SESSION_ID",
			"SERVICE_SLUG",
		]);
	});

	test("SESSION_PICKER_URL is left alone — panes are meant to inherit it", () => {
		expect(leakedIdentityVars(LEAKED_SERVER_ENV)).not.toContain("SESSION_PICKER_URL");
	});

	test("a clean server environment reports nothing to remove", () => {
		const clean = LEAKED_SERVER_ENV.filter(
			(l) =>
				!l.startsWith("PORT=") &&
				!l.startsWith("SERVICE_SLUG=") &&
				!l.startsWith("SCALA_ORCH_SESSION_ID="),
		);
		expect(leakedIdentityVars(clean)).toEqual([]);
	});

	test("matches on the full name, never a prefix", () => {
		// PORTAL_BASE_DOMAIN and SERVICE_SLUGGISH must not read as PORT/SERVICE_SLUG.
		const nearMisses = ["PORTAL_BASE_DOMAIN=scala.business", "SERVICE_SLUGGISH=no"];
		expect(leakedIdentityVars(nearMisses)).toEqual([]);
	});

	test("an unreadable environment reports nothing rather than guessing", () => {
		expect(leakedIdentityVars([])).toEqual([]);
	});

	test("the service-identity set is exactly what service-runtime reads to boot a service", () => {
		// A third identity input added to service-runtime without being added
		// here silently reopens the leak class — this pins the contract.
		expect([...SERVICE_IDENTITY_VARS].sort()).toEqual(["PORT", "SERVICE_SLUG"]);
	});

	test("the orchestrator-identity set is exactly the fleet pane-identity env (the third leak instance)", () => {
		// SCALA_ORCH_SESSION_ID is the env the gateway/relay reads as a pane's
		// identity. A second orchestrator-identity env added without being added
		// here silently reopens the leak class — this pins the contract.
		expect([...ORCHESTRATOR_IDENTITY_VARS]).toEqual(["SCALA_ORCH_SESSION_ID"]);
	});

	test("SCALA_ORCH_SESSION_ID is reported as leaked even with no service identity present", () => {
		// The third instance can leak on its own (a host where SERVICE_SLUG/PORT
		// were already scrubbed but the orchestrator id was not). The scrub must
		// still catch it.
		expect(leakedIdentityVars(["SCALA_ORCH_SESSION_ID=tmux:%234"])).toEqual([
			"SCALA_ORCH_SESSION_ID",
		]);
	});
});
