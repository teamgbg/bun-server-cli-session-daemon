// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";

const SRC = new URL("./show-menu.ts", import.meta.url).pathname;

async function code(): Promise<string> {
	return (await Bun.file(SRC).text())
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

describe("every menu spawn carries a caller identity", () => {
	test("the spawn curl sends x-requested-by", async () => {
		// Without it /rpc/spawn returns 400 and the menu item silently does
		// nothing — the curl ends in `|| true`, so tmux reports no error at all.
		expect(await code()).toContain("x-requested-by: operator:tmux-menu");
	});

	test("the spawn curl proves it is the operator", async () => {
		// Attribution alone does not release the operator path: without the
		// per-boot token the daemon correctly treats this as fleet.
		expect(await code()).toContain("OPERATOR_TOKEN_HEADER");
		expect(await code()).toContain("spawnCurl(url, operatorToken)");
	});

	test("a missing operator token fails before the menu is displayed", async () => {
		const c = await code();
		expect(c).toContain("if (!operatorToken)");
		expect(c).toContain("misclassified as fleet");
	});

	test("BOTH spawn sites go through the one helper", async () => {
		// There are two: the root menu and the submenu. Fixing only one leaves
		// half the menu dead, and which half depends on where the option sits.
		const c = await code();
		const helperUses = c.split("spawnCurl(url, operatorToken)").length - 1;

		expect(helperUses).toBe(2);
		// No spawn URL may be curled without going through the helper.
		expect(c).not.toMatch(/rpc\/spawn[\s\S]{0,400}?run-shell "curl(?![\s\S]{0,80}x-requested-by)/);
	});

	test("the identity is a real attribution, not a sentinel", async () => {
		// The whole point of the 400 was to stop recording a value that looks
		// populated but identifies nobody. A menu spawn IS the operator acting
		// directly, so it names that rather than inventing a placeholder.
		const c = await code();

		expect(c).toContain("operator:tmux-menu");
		expect(c).not.toContain("caller-unidentified");
		expect(c).not.toContain("unknown");
	});

	test("menu navigation is NOT given a spawn identity", async () => {
		// /rpc/menu and the Back button do not spawn anything, so they must not
		// be handed a spawn attribution — that would put a fake spawn identity on
		// a navigation action.
		const c = await code();
		const menuNav = c.match(/rpc\/menu[\s\S]{0,300}?run-shell "curl[^"]*"/g) ?? [];

		for (const nav of menuNav) expect(nav).not.toContain("x-requested-by");
	});
});
