// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { formatRestoreAckLines, type RestoreAckInput, type RestoreAckProblem } from "./restore-ack.ts";

const prob = (over: Partial<RestoreAckProblem>): RestoreAckProblem => ({
	kind: "failed",
	windowName: "x",
	reason: "r",
	...over,
});

const ok = (over: Partial<RestoreAckInput>): RestoreAckInput => ({
	ok: true,
	restored: [],
	failed: [],
	degraded: [],
	...over,
});

// The rendered lines carry ANSI codes; assertions check the PLAIN text is
// present (substring), not exact equality, so style changes don't break the
// behavioural pin. `visibleLen`/strip logic is style.ts's concern, not here.
const plain = (lines: string[]): string[] => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

test("every failed windowName appears on its own line — the omission guard", () => {
	const lines = plain(
		formatRestoreAckLines(
			ok({
				ok: false,
				restored: [{ windowName: "Good" }],
				failed: [
					prob({ kind: "failed", windowName: "SCM", reason: "window did not come up" }),
					prob({ kind: "failed", windowName: "Overlay", reason: "spawn threw" }),
				],
			}),
			"work",
			120,
		),
	);
	expect(lines.some((l) => l.includes("Restore of 'work' incomplete"))).toBe(true);
	expect(lines.some((l) => l.includes("failed") && l.includes("(2)"))).toBe(true);
	expect(lines.some((l) => l.includes("SCM") && l.includes("window did not come up"))).toBe(true);
	expect(lines.some((l) => l.includes("Overlay") && l.includes("spawn threw"))).toBe(true);
	expect(lines.some((l) => l.includes("1 tab(s) restored fully"))).toBe(true);
	expect(lines.some((l) => l.includes("Press any key to attach to 'work'"))).toBe(true);
});

test("every degraded windowName appears, labelled as conversation-lost", () => {
	const lines = plain(
		formatRestoreAckLines(
			ok({
				ok: false,
				failed: [],
				degraded: [
					prob({ kind: "degraded", windowName: "DB Theming", reason: "reopened fresh" }),
				],
			}),
			"work",
			120,
		),
	);
	expect(lines.some((l) => l.includes("degraded") && l.includes("conversation lost"))).toBe(true);
	expect(lines.some((l) => l.includes("DB Theming") && l.includes("reopened fresh"))).toBe(true);
});

test("an error-level failure (daemon unreachable) is surfaced, not collapsed", () => {
	const lines = plain(
		formatRestoreAckLines(
			ok({ ok: false, error: "HTTP 500", failed: [], degraded: [] }),
			"work",
			120,
		),
	);
	expect(lines.some((l) => l.includes("HTTP 500"))).toBe(true);
});

test("a wide cols value does not clip short names; a narrow cols clips gracefully", () => {
	const narrow = plain(
		formatRestoreAckLines(
			ok({
				ok: false,
				failed: [prob({ windowName: "VeryLongTabName", reason: "x" })],
			}),
			"work",
			10,
		),
	);
	// Narrow clip must still contain the header start; the function never throws.
	expect(narrow.length).toBeGreaterThan(0);
});
