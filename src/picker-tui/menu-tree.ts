/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Menu tree: parent_menu grouping + change-detection signature + shared click-target table.
 */

import { buildDisplayRows, type DisplayRow } from "./option-display.ts";
import type { MenuOption } from "./types.ts";

export interface MenuLevel {
	id: string;
	title: string;
	options: MenuOption[];
	displayRows: DisplayRow[];
}

/** Cheap signature of an option list for hot-reload change detection. Stable
 * across fetches that don't change the rendered menu, so the periodic refresh
 * skips the redraw when nothing changed (no flicker). */
export function optionSignature(options: MenuOption[]): string {
	return options
		.map(
			(o) =>
				`${o.slug}:${o.sortOrder}:${o.family?.key ?? ""}:${o.config.variant_label ?? ""}:${o.config.action_type}:${o.config.command ?? ""}`,
		)
		.join("|");
}

/** Group flat option rows into menu levels by parent_menu (pure view-side
 * organisation of the daemon's option list — no truth here). Mirrors the old
 * actions.ts helper, now local since dispatch lives in the daemon. */
export function buildMenuTree(options: MenuOption[]): Map<string, MenuLevel> {
	const byParent = new Map<string, MenuOption[]>();
	for (const opt of options) {
		const parent = opt.config.parent_menu ?? "root";
		const arr = byParent.get(parent) ?? [];
		arr.push(opt);
		byParent.set(parent, arr);
	}
	for (const arr of byParent.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
	const levels = new Map<string, MenuLevel>();
	for (const [id, opts] of byParent.entries()) {
		levels.set(id, {
			id,
			title: id === "root" ? "Main" : id,
			options: opts,
			displayRows: buildDisplayRows(opts),
		});
	}
	return levels;
}

export function rootLevel(levels: Map<string, MenuLevel>): MenuLevel {
	return levels.get("root") ?? { id: "root", title: "Main", options: [], displayRows: [] };
}

export interface ClickTarget {
	row: number;
	colStart: number;
	colEnd: number;
	index: number;
}

/** Mutable click-target table rebuilt by renderMenu on every paint; the key
 * handler reads it to map mouse rows back onto logical rows. */
export const clickTargets: ClickTarget[] = [];
