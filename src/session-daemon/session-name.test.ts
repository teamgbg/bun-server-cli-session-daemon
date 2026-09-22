// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { isValidTmuxSessionName } from "./session-name.ts";

test("accepts clean lowercase slug session names", () => {
	for (const ok of ["joe", "valencia", "nebula", "lane-2", "a", "x9"]) {
		expect(isValidTmuxSessionName(ok)).toBe(true);
	}
});

test("rejects names tmux or the derived registry slug cannot carry", () => {
	for (const bad of [
		"Joe's session", // space + apostrophe + uppercase
		"joe.dev", // '.' breaks tmux target syntax
		"a:b", // ':' breaks tmux target syntax
		"has space",
		"UPPER",
		"-leading-hyphen",
		"",
	]) {
		expect(isValidTmuxSessionName(bad)).toBe(false);
	}
});
