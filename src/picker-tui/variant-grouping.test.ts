// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { activeOptionFor, buildDisplayRows, groupLabel } from "./launcher.ts";
import type { CliFamily, MenuOption } from "./types.ts";

function opt(
	slug: string,
	label: string,
	sortOrder: number,
	family: CliFamily | null = null,
	extra: Partial<MenuOption["config"]> = {},
): MenuOption {
	return {
		slug,
		label,
		sortOrder,
		family,
		config: {
			key: slug[0] ?? "x",
			category: "AI Coding",
			parent_menu: null,
			action_type: "tmux_window",
			command: `echo ${slug}`,
			...extra,
		},
	};
}

const GLM_FAMILY: CliFamily = { key: "glm", name: "GLM" };

test("buildDisplayRows: standalone rows (no family) pass through one-to-one", () => {
	const options = [opt("alpha", "Alpha", 10), opt("beta", "Beta", 20)];
	const rows = buildDisplayRows(options);
	expect(rows).toHaveLength(2);
	expect(rows[0]?.variants).toEqual([]);
	expect(rows[0]?.primary.slug).toBe("alpha");
	expect(rows[1]?.primary.slug).toBe("beta");
});

test("buildDisplayRows: siblings sharing a family key collapse into one row", () => {
	const options = [
		opt("oc-glm", "GLM", 10, GLM_FAMILY, { variant_label: "OpenCode" }),
		opt("cc-glm", "GLM", 20, GLM_FAMILY, { variant_label: "Claude Code" }),
		opt("cd-glm", "GLM", 30, GLM_FAMILY, { variant_label: "Codex" }),
	];
	const rows = buildDisplayRows(options);
	// One collapsed row, not three.
	expect(rows).toHaveLength(1);
	const row = rows[0]!;
	expect(row.variants.map((s) => s.slug)).toEqual(["oc-glm", "cc-glm", "cd-glm"]);
	// Primary is the first sibling (lowest sortOrder).
	expect(row.primary.slug).toBe("oc-glm");
});

test("buildDisplayRows: a mix of grouped and standalone rows preserves order", () => {
	const options = [
		opt("claude", "Claude", 5),
		opt("oc-glm", "GLM", 10, GLM_FAMILY, { variant_label: "OpenCode" }),
		opt("cc-glm", "GLM", 20, GLM_FAMILY, { variant_label: "Claude Code" }),
		opt("bash", "Bash", 30),
	];
	const rows = buildDisplayRows(options);
	expect(rows.map((r) => (r.variants.length ? r.primary.slug : r.primary.slug))).toEqual([
		"claude",
		"oc-glm",
		"bash",
	]);
	expect(rows[1]!.variants).toHaveLength(2);
});

test("activeOptionFor: standalone row returns primary regardless of selection", () => {
	const row = buildDisplayRows([opt("bash", "Bash", 10)])[0]!;
	expect(activeOptionFor(row, {}).slug).toBe("bash");
});

test("activeOptionFor: variant row returns the selected sibling, defaulting to first", () => {
	const options = [
		opt("oc-glm", "GLM", 10, GLM_FAMILY, { variant_label: "OpenCode" }),
		opt("cc-glm", "GLM", 20, GLM_FAMILY, { variant_label: "Claude Code" }),
		opt("cd-glm", "GLM", 30, GLM_FAMILY, { variant_label: "Codex" }),
	];
	const row = buildDisplayRows(options)[0]!;
	// Default (no selection) → first sibling.
	expect(activeOptionFor(row, {}).slug).toBe("oc-glm");
	// Tab once → second sibling.
	expect(activeOptionFor(row, { glm: 1 }).slug).toBe("cc-glm");
	// Tab twice → third sibling.
	expect(activeOptionFor(row, { glm: 2 }).slug).toBe("cd-glm");
	// Out-of-range index falls back to primary (first).
	expect(activeOptionFor(row, { glm: 99 }).slug).toBe("oc-glm");
});

test("menu_scope keeps a row OUT of its CLI's family while others group by cli_id", () => {
	const options = [
		opt("cc-glm52", "Claude Code (GLM 5.2)", 10, { key: "claude", name: "Claude Code" }),
		opt(
			"personal-claude-glm52",
			"Clean | GLM 5.2",
			20,
			{ key: "clean-no-md", name: "Claude Code" },
			{ menu_scope: "clean-no-md" },
		),
	];
	const rows = buildDisplayRows(options);
	expect(rows).toHaveLength(2);
	expect(rows[0]!.variants).toHaveLength(1);
	expect(rows[1]!.variants).toHaveLength(1);
});

test("groupLabel: strips a trailing provider parenthetical (no duplicate with the dim tag)", () => {
	// "Codex (OpenAI)" + dim "[OpenAI]" → white shows just the group name.
	expect(groupLabel("Codex (OpenAI)")).toBe("Codex");
	expect(groupLabel("Claude Code (DeepSeek V4 Flash)")).toBe("Claude Code");
	expect(groupLabel("OpenCode (GLM 5.2)")).toBe("OpenCode");
});

test("groupLabel: leaves an already-bare group label untouched", () => {
	expect(groupLabel("Scala Terminal")).toBe("Scala Terminal");
	expect(groupLabel("Bash")).toBe("Bash");
});

test("Tab cycling wraps: index modulo sibling count", () => {
	const options = [
		opt("oc-glm", "GLM", 10, GLM_FAMILY, { variant_label: "OpenCode" }),
		opt("cc-glm", "GLM", 20, GLM_FAMILY, { variant_label: "Claude Code" }),
	];
	const row = buildDisplayRows(options)[0]!;
	// The launcher cycles (cur + 1) % length; here length 2, so 1 → 0.
	expect(activeOptionFor(row, { glm: 0 }).slug).toBe("oc-glm");
	expect(activeOptionFor(row, { glm: 1 }).slug).toBe("cc-glm");
	expect(activeOptionFor(row, { glm: 0 }).slug).toBe("oc-glm");
});
