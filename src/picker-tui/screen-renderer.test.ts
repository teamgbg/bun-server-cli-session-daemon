// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { createScreenRenderer } from "./screen-renderer.ts";

describe("screen renderer", () => {
	test("paints the first frame fully and subsequent frames incrementally", () => {
		const renderer = createScreenRenderer();
		const first = renderer.paint(["one", "two"]);
		const second = renderer.paint(["one", "changed"]);

		expect(first).toContain("\x1b[2J\x1b[H");
		expect(first).toContain("\x1b[?2026h");
		expect(first).toContain("\x1b[?2026l");
		expect(second).not.toContain("\x1b[2J");
		expect(second).toContain("changed");
		expect(second).not.toContain("\x1b[1;1H\x1b[2Kone");
	});

	test("erases rows that disappeared and reset forces a full frame", () => {
		const renderer = createScreenRenderer();
		renderer.paint(["one", "two"]);
		const shortened = renderer.paint(["one"]);
		expect(shortened).toContain("\x1b[2;1H\x1b[2K");

		renderer.reset();
		expect(renderer.paint(["one"])).toContain("\x1b[2J\x1b[H");
	});
});
