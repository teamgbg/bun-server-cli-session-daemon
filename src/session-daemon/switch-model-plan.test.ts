// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { planModelSwitch, type SwitchModelTab } from "./switch-model-plan.ts";

const GROUPS: Record<string, string | undefined> = {
	"cc-opus": "claude-code",
	"cc-sonnet": "claude-code",
	"cc-glm52": "claude-code",
	codex: "codex",
	pi: "pi",
	btop: undefined,
};

function tab(over: Partial<SwitchModelTab> & { windowName: string }): SwitchModelTab {
	return {
		paneId: "%1",
		windowId: "@1",
		sessionId: "019fa248-b68c-700a-b1f1-75dab1b24c6f",
		optionSlug: "cc-glm52",
		cwd: "/home/joe-bellissimo",
		...over,
	};
}

describe("planModelSwitch", () => {
	test("moves a same-family tab, carrying its session id and window name", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "Heat Diagnostics" })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
			fromSlugs: ["cc-glm52"],
		});
		expect(plan.skipped).toEqual([]);
		expect(plan.moves).toHaveLength(1);
		expect(plan.moves[0]?.windowName).toBe("Heat Diagnostics");
		expect(plan.moves[0]?.resumeId).toBe("019fa248-b68c-700a-b1f1-75dab1b24c6f");
	});

	test("with no fromSlugs, selects the target's whole CLI family and nothing else", () => {
		const plan = planModelSwitch({
			tabs: [
				tab({ windowName: "glm lane", optionSlug: "cc-glm52" }),
				tab({ windowName: "codex lane", optionSlug: "codex" }),
				tab({ windowName: "btop", optionSlug: "btop", sessionId: null }),
			],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
		});
		expect(plan.moves.map((m) => m.windowName)).toEqual(["glm lane"]);
		// A non-family tab is not a candidate at all — it is neither moved nor
		// reported, because the operator never asked about it.
		expect(plan.skipped).toEqual([]);
	});

	test("refuses a tab with no captured session id rather than opening a fresh lane", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "unrestorable", sessionId: null })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
			fromSlugs: ["cc-glm52"],
		});
		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("no-session-id");
	});

	test("refuses a cross-CLI move even when explicitly asked for", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "codex lane", optionSlug: "codex" })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
			fromSlugs: ["codex"],
		});
		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("cross-cli-family");
	});

	test("refuses a tab with no live pane, which would survive the switch", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "ghost", paneId: undefined })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
			fromSlugs: ["cc-glm52"],
		});
		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("no-pane");
	});

	test("reports a tab already on the target instead of restarting it", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "already opus", optionSlug: "cc-opus" })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
		});
		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("already-on-target");
	});

	test("windowNames narrows the selection to named tabs", () => {
		const plan = planModelSwitch({
			tabs: [tab({ windowName: "keep" }), tab({ windowName: "leave" })],
			targetSlug: "cc-opus",
			familyBySlug: GROUPS,
			fromSlugs: ["cc-glm52"],
			windowNames: ["keep"],
		});
		expect(plan.moves.map((m) => m.windowName)).toEqual(["keep"]);
	});
});
