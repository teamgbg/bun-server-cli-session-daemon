// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { isSuspectedTmuxChurn } from "./reconcile-guard.ts";
import type { SessionTab } from "./state-tabs.ts";

const tab = (windowName: string): SessionTab => ({ windowName, optionSlug: "x" }) as SessionTab;

test("disjoint live set over a multi-tab record is churn (preserve)", () => {
	const existing = [tab("orch:gpt-decomp"), tab("Partner Proposal"), tab("btop")];
	// impostor server: live windows from a replaced socket, names don't match
	expect(isSuspectedTmuxChurn(existing, new Set(["bash", "btop-2"]))).toBe(true);
	// empty read (server unreachable)
	expect(isSuspectedTmuxChurn(existing, new Set())).toBe(true);
});

test("any overlap means a real reconcile, not churn", () => {
	const existing = [tab("a"), tab("b"), tab("c")];
	// operator closed 'c'; a + b still live -> overlap -> real close, prune c
	expect(isSuspectedTmuxChurn(existing, new Set(["a", "b"]))).toBe(false);
	// even a single surviving name is a real read
	expect(isSuspectedTmuxChurn(existing, new Set(["b"]))).toBe(false);
});

test("a single-tab or empty record is not churn-guarded here", () => {
	// the `<= 1` companion guard owns the single-tab case; this predicate is
	// only the disjoint-multi-tab signal, so it stays false here
	expect(isSuspectedTmuxChurn([tab("only")], new Set())).toBe(false);
	expect(isSuspectedTmuxChurn([], new Set())).toBe(false);
});
