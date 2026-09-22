// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, it } from "bun:test";

/**
 * Which conversation (if any) this spawn replays.
 *
 * Mirrors the resolution in `spawn-core.ts`. A caller that STATES its intent is
 * believed; only a silent caller is guessed at.
 */
export function resolveResumeCandidate(input: {
	resumeId?: string;
	seedId?: string;
	transcriptExists: (id: string) => boolean;
	freshSession?: boolean;
}): string | undefined {
	const { resumeId, seedId, transcriptExists, freshSession } = input;
	if (freshSession) return resumeId;
	return resumeId ?? (seedId && transcriptExists(seedId) ? seedId : undefined);
}

const exists = () => true;
const missing = () => false;

describe("resolveResumeCandidate", () => {
	/** THE REGRESSION. A fleet spawn seeds an id; if a transcript happens to
	 *  exist for it, the lane must still be NEW. */
	it("a fleet spawn NEVER replays a seeded id, even when a transcript exists", () => {
		expect(
			resolveResumeCandidate({
				seedId: "019fc188-ccdf-7603-9fb8-1c1cfa1426f3",
				transcriptExists: exists,
				freshSession: true,
			}),
		).toBeUndefined();
	});

	/** The operator's restore path is untouched: a silent caller still gets the
	 *  helpful guess, which is what made a reopened tab work at all. */
	it("a silent caller still resumes a seeded id whose transcript exists", () => {
		expect(
			resolveResumeCandidate({
				seedId: "019fc188-ccdf-7603-9fb8-1c1cfa1426f3",
				transcriptExists: exists,
			}),
		).toBe("019fc188-ccdf-7603-9fb8-1c1cfa1426f3");
	});

	it("a seeded id with no transcript is a fresh session either way", () => {
		expect(resolveResumeCandidate({ seedId: "x", transcriptExists: missing })).toBeUndefined();
		expect(
			resolveResumeCandidate({ seedId: "x", transcriptExists: missing, freshSession: true }),
		).toBeUndefined();
	});

	/** An EXPLICIT resumeId is an explicit intent and survives freshSession —
	 *  otherwise a caller could not resume deliberately on the fleet path. */
	it("an explicit resumeId is honoured even on a fleet spawn", () => {
		expect(
			resolveResumeCandidate({ resumeId: "abc", transcriptExists: missing, freshSession: true }),
		).toBe("abc");
	});

	it("no ids at all means a fresh session", () => {
		expect(resolveResumeCandidate({ transcriptExists: exists })).toBeUndefined();
	});
});
