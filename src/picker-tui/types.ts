/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * View types for the rich picker TUI. The TUI is a stateless face over the
 * daemon: these types describe what it renders, not what it owns. Session and
 * option data arrive from GET /rpc/picker-data; actions go to POST /rpc/spawn.
 */

import type { SessionPickerOptionConfig } from "@teamscala/db-validation/registry-schemas/session-picker-option";

/** The CLI family an option belongs to, derived from its `cli_id` foreign key
 * by the daemon (`family.key` = the cli_routing slug or the row's explicit
 * `menu_scope` override; `family.name` = the routing row's display name). */
export interface CliFamily {
	key: string;
	name: string;
}

export interface MenuOption {
	slug: string;
	label: string;
	sortOrder: number;
	family: CliFamily | null;
	config: SessionPickerOptionConfig;
}

/**
 * One rendered menu row. For a standalone option `variants` is empty and
 * `primary` is the option itself. For a variant family (options sharing a CLI
 * family key), `primary` is the first sibling (its label is the group
 * label) and `variants` holds every sibling cycled by Tab. Pure view-side
 * collapse of the daemon's flat option list — no truth here.
 */
export interface DisplayRow {
	primary: MenuOption;
	variants: MenuOption[];
}

export interface MenuLevel {
	id: string; // "root" for top level, submenu_id otherwise
	title: string;
	options: MenuOption[];
	/** Display-order rows with variant groups collapsed. selectedIdx indexes this. */
	displayRows: DisplayRow[];
}

export interface LiveSession {
	name: string;
	windows: number;
	attached: boolean;
	/** Attached tmux clients (devices viewing this session). Empty iff detached. */
	clients: AttachedClient[];
}

/** A device currently attached to a session (client of `picker-data`). */
export interface AttachedClient {
	name: string;
	tty: string;
	width: number;
	height: number;
	activity: number;
}

/** Window-sizing state surfaced by the daemon: the current `window-size` (kept
 * `latest` so the active device wins) + any stale size-clamping clients the
 * operator should detach. */
export interface SizingInfo {
	windowSize: string;
	clampingClients: AttachedClient[];
}

export interface ArchivedSession {
	name: string;
	tabCount: number;
	updatedAt: Date;
}

export interface PickerLabels {
	sessions_heading: string;
	actions_heading: string;
	new_session: string;
	new_session_hint: string;
	refresh: string;
	quit: string;
	empty_state: string;
	nav_hint_menu: string;
	nav_hint_select: string;
	confirm_heading: string;
	result_heading: string;
	error_heading: string;
	confirm_hint: string;
	historical_group: string;
	live_group: string;
	archived_group: string;
	archived_marker: string;
	hidden_marker: string;
}

export interface PickerConfig {
	title: string;
	picker_window: string;
	history_retention_days: number;
	labels: PickerLabels;
}

export type AppState =
	| {
			kind: "menu";
			stack: MenuLevel[];
			status: string | null;
			selectedIdx: number;
			/** Active sibling index per CLI family key (Tab cycling). */
			variantSelection: Record<string, number>;
	  }
	| { kind: "confirm"; option: MenuOption; stack: MenuLevel[] };
