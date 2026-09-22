/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Default chrome (title + labels) for the picker views. The old picker read
 * these from a registry config row; the rich view bakes sensible defaults so
 * it has zero config dependency — the daemon owns data, the view owns chrome.
 */

import type { PickerConfig } from "./types.ts";

export const DEFAULT_PICKER_CONFIG: PickerConfig = {
	title: "scala dev",
	picker_window: "picker",
	history_retention_days: 7,
	labels: {
		sessions_heading: "Sessions",
		actions_heading: "Actions",
		new_session: "New session",
		new_session_hint: "pick a CLI to launch",
		refresh: "Refresh",
		quit: "Quit",
		empty_state: "No sessions yet — start one",
		nav_hint_menu: "↑↓ <> move · enter select · esc back",
		nav_hint_select: "↑↓ <> move · enter open · A archive · Del delete · q quit",
		confirm_heading: "Confirm",
		result_heading: "Result",
		error_heading: "Error",
		confirm_hint: "enter confirm · esc cancel",
		historical_group: "Recent (last {days}d)",
		live_group: "Live",
		archived_group: "Archived",
		archived_marker: "archived {ago}",
		hidden_marker: "hidden {ago}",
	},
};

/** Merge the db row (config:session-picker-config) over the baked defaults so
 * the picker chrome is db-driven: changing the row re-renders the picker (the
 * daemon serves the raw row in picker-data; this merges it client-side). Loose
 * by design — only known string/number fields are taken, the rest default. */
export function mergePickerConfig(
	base: PickerConfig,
	over: Record<string, unknown> | null | undefined,
): PickerConfig {
	if (!over || typeof over !== "object") return base;
	const labelsOver =
		over.labels && typeof over.labels === "object"
			? (over.labels as Record<string, unknown>)
			: {};
	const mergedLabels = { ...base.labels };
	for (const [k, val] of Object.entries(labelsOver)) {
		if (typeof val === "string" && k in mergedLabels) {
			(mergedLabels as Record<string, string>)[k] = val;
		}
	}
	return {
		title: typeof over.title === "string" ? over.title : base.title,
		picker_window:
			typeof over.picker_window === "string" ? over.picker_window : base.picker_window,
		history_retention_days:
			typeof over.history_retention_days === "number"
				? over.history_retention_days
				: base.history_retention_days,
		labels: mergedLabels,
	};
}
