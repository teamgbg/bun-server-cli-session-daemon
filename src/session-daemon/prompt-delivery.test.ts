// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { composerLineIsEmpty } from "./prompt-delivery.ts";

/**
 * `composerLineIsEmpty` decides whether a spawned lane's brief is re-sent, so
 * BOTH directions are real damage and both are covered here.
 *
 * Too loose (an occupied composer read as empty) is the failure this replaced:
 * the daemon reports the lane started, the lane never takes a turn, and
 * dispatch silently does nothing fleet-wide. Measured 2026-07-31 — three lanes
 * reported delivered, each holding its full brief with zero bytes uploaded.
 *
 * Too strict (an empty composer read as occupied) types the brief a second time
 * into a lane that already has it, so the lane receives its instructions twice.
 */
describe("composerLineIsEmpty", () => {
	test("a bare prompt marker is empty", () => {
		expect(composerLineIsEmpty("> ")).toBe(true);
		expect(composerLineIsEmpty("❯")).toBe(true);
	});

	test("box-drawing chrome around an empty composer is still empty", () => {
		// a framed TUI composer renders the frame whether or not the
		// user has typed anything, so it must never read as content.
		expect(composerLineIsEmpty("│ >                                  │")).toBe(true);
		expect(composerLineIsEmpty("╭──────────────────────────────────╮")).toBe(true);
		expect(composerLineIsEmpty("")).toBe(true);
		expect(composerLineIsEmpty("   \t  ")).toBe(true);
	});

	test("a held brief is NOT empty", () => {
		// The exact shape observed on the stuck lanes: the composer marker
		// followed by a slice of the brief.
		const held =
			"> s. PRINCIPLE: a pane's identity is a fact ABOUT that pane and must be DERIVED from its own pane id";
		expect(composerLineIsEmpty(held)).toBe(false);
	});

	test("even a single typed character counts as held", () => {
		// The boundary matters: re-sending on a composer the operator has begun
		// typing into would interleave our brief with their input.
		expect(composerLineIsEmpty("> x")).toBe(false);
	});

	test("a brief that happens to contain chrome characters still reads as held", () => {
		// Stripping chrome must not be able to empty out real content — the
		// briefs carry pipes and dashes routinely.
		expect(composerLineIsEmpty("> run a | b and check --flag")).toBe(false);
	});
});
