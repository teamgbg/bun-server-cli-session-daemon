// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { displayNameForSuffix, isProjectKeyedSuffix } from "./developer-seat-map.ts";
import { planRekey } from "./rekey-session-state.ts";

const JOE_PROJECT = "019fcc05-762e-7407-ba05-a07d6bce8e56";
const ANNA_PROJECT = "019ff92a-e73e-7d81-b10e-a6ca428bd560";

const seats = [
	{ projectId: JOE_PROJECT, title: "Joe's Developer", liveSession: "Joe's Developer" },
	{ projectId: ANNA_PROJECT, title: "Anna's Developer", liveSession: "Anna's Developer" },
];

describe("isProjectKeyedSuffix", () => {
	test("a UUID suffix is project-keyed", () => {
		expect(isProjectKeyedSuffix(JOE_PROJECT)).toBe(true);
	});
	test("a name suffix is not", () => {
		expect(isProjectKeyedSuffix("joe-s-developer")).toBe(false);
	});
});

describe("displayNameForSuffix renders the live tmux session", () => {
	test("project-keyed suffix resolves through the seat map", () => {
		expect(displayNameForSuffix(JOE_PROJECT, seats)).toBe("Joe's Developer");
	});
	test("an unseated project suffix falls back to the raw suffix", () => {
		expect(displayNameForSuffix(JOE_PROJECT, [])).toBe(JOE_PROJECT);
	});
	test("legacy name suffix is returned unchanged", () => {
		expect(displayNameForSuffix("echo", seats)).toBe("echo");
	});
});

describe("planRekey pairs legacy rows ONLY with an exact live seat name", () => {
	test("rekeys the matching owner and nothing else", () => {
		const rows = [
			{ slug: `session-state-${JOE_PROJECT}`, config: { tabs: [] } },
			// Suffix EQUALS the live seat name exactly (stale-name rekey case).
			{ slug: "session-state-Joe's Developer", config: { tabs: [] } },
			// Stale name that no live seat holds (tmux already renamed): MUST NOT
			// be paired by resemblance — waiting for a boot where the seat IS
			// live is the convergent answer.
			{ slug: "session-state-valencia-s-session", config: { tabs: [] } },
			// Ownerless operator session: stays name-keyed forever.
			{ slug: "session-state-echo", config: { tabs: [] } },
		];
		const plan = planRekey(rows, seats);
		expect(plan.map((p) => p.legacySlug)).toEqual([
			"session-state-Joe's Developer",
		]);
		const joe = plan[0];
		expect(joe.newSlug).toBe(`session-state-${JOE_PROJECT}`);
		expect(joe.projectTitle).toBe("Joe's Developer");
	});
	test("an already-project-keyed row is never re-planned", () => {
		const rows = [{ slug: `session-state-${ANNA_PROJECT}`, config: { tabs: [] } }];
		expect(planRekey(rows, seats)).toEqual([]);
	});
});
