/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Option → display-row projection: family-group collapse, label trim, three-column resolution, and active-variant lookup.
 */

import type { MenuOption } from "./types.ts";

/** Display row model: one row per family (or per standalone option) with the
 * full sibling list so Tab can cycle through variants. */
export interface DisplayRow {
	primary: MenuOption;
	variants: MenuOption[];
}

export function buildDisplayRows(options: MenuOption[]): DisplayRow[] {
	const groups = new Map<string, MenuOption[]>();
	for (const opt of options) {
		const g = opt.family?.key;
		if (!g) continue;
		const arr = groups.get(g) ?? [];
		arr.push(opt);
		groups.set(g, arr);
	}
	const seen = new Set<string>();
	const rows: DisplayRow[] = [];
	for (const opt of options) {
		const g = opt.family?.key;
		if (g) {
			if (seen.has(g)) continue;
			seen.add(g);
			const siblings = (groups.get(g) ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
			rows.push({ primary: siblings[0] ?? opt, variants: siblings });
		} else {
			rows.push({ primary: opt, variants: [] });
		}
	}
	return rows;
}

/** The white primary label for a variant-group row is the GROUP name; the
 * active variant (provider/model) is shown separately in the dim `[…]` tag. So
 * strip a trailing parenthetical from the primary's label — "Codex (OpenAI)"
 * renders as "Codex" with "[OpenAI]" beside it, not the duplicated
 * "Codex (OpenAI) [OpenAI]". Also fixes the stale-label case where the primary
 * is the first sibling but the operator has Tab-cycled to another variant.
 * No-op for already-bare group labels (e.g. "Scala Terminal"). */
export function groupLabel(label: string): string {
	return label.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** Structured three-column display for a variant row: CLI family, provider,
 * model — each an independent column the operator can scan and Tab-cycle. */
interface ColumnDisplay {
	family: string;
	provider: string;
	model: string;
}

/** Resolve the three columns (CLI | Provider | Model) for a variant row.
 * Family from the option's cli_id-derived family name, provider+model from the
 * option's config fields (falling back to parsing variant_label). Always
 * returns three strings so the table layout is consistent across every
 * variant. */
function variantColumns(opt: MenuOption): ColumnDisplay {
	const fam = opt.family?.name;
	const family = fam ?? opt.label.replace(/\s*\([^()]*\)\s*$/, "").trim();
	const provider = opt.config.provider ?? "";
	const model = opt.config.model ?? "";
	if (provider || model) return { family, provider, model };
	const vl = opt.config.variant_label ?? "";
	const parts = vl.split(/\s*·\s*/);
	if (parts.length >= 2) return { family, provider: parts[1] ?? "", model: parts[0] ?? "" };
	return { family, provider: vl, model: "" };
}

/** Resolve the option that runs on Enter for a display row, given the active
 * variant index for its group (0 for standalone rows). */
export function activeOptionFor(row: DisplayRow, variantSelection: Record<string, number>): MenuOption {
	if (row.variants.length === 0) return row.primary;
	const g = row.primary.family?.key ?? "";
	const idx = variantSelection[g] ?? 0;
	return row.variants[idx] ?? row.primary;
}
