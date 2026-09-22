// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { detectCaps } from "./terminal-caps.ts";

describe("detectCaps", () => {
	test("bare xterm (Termius) caps at 256-color even when COLORTERM=truecolor is forced", () => {
		const caps = detectCaps("xterm", "truecolor");
		expect(caps.supportsTruecolor).toBe(false);
		expect(caps.supports256).toBe(true);
	});

	test("bare xterm with no COLORTERM still gets 256-color (not monochrome)", () => {
		const caps = detectCaps("xterm", "");
		expect(caps.supports256).toBe(true);
		expect(caps.supportsTruecolor).toBe(false);
	});

	test("xterm-256color + truecolor (desktop) unlocks 24-bit truecolor", () => {
		const caps = detectCaps("xterm-256color", "truecolor");
		expect(caps.supportsTruecolor).toBe(true);
		expect(caps.supports256).toBe(true);
	});

	test("tmux-256color gets 256-color", () => {
		const caps = detectCaps("tmux-256color", "");
		expect(caps.supports256).toBe(true);
		expect(caps.supportsTruecolor).toBe(false);
	});

	test("xterm-direct (TERM advertises direct) unlocks truecolor even without COLORTERM", () => {
		const caps = detectCaps("xterm-direct", "");
		expect(caps.supportsTruecolor).toBe(true);
		expect(caps.supports256).toBe(true);
	});

	test("dumb terminal is monochrome (no color escapes emitted)", () => {
		const caps = detectCaps("dumb", "");
		expect(caps.supportsTruecolor).toBe(false);
		expect(caps.supports256).toBe(false);
	});

	test("supportsMouse tracks supports256 (desktop-pointer proxy)", () => {
		expect(detectCaps("xterm-256color", "").supportsMouse).toBe(true);
		expect(detectCaps("dumb", "").supportsMouse).toBe(false);
	});
});
