/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Row model: the SessionInfo + Row types, the selectable test, the shared click-target table, and the rows built from sessions/archived/hidden.
 */

import type { ArchivedSession, AttachedClient } from "./types.ts";

/** Live-session shape the view renders. Sourced from GET /rpc/picker-data —
 * the daemon is the single place that queries tmux. This view never does. */
export interface SessionInfo {
	name: string;
	windows: number;
	attached: boolean;
	clients: AttachedClient[];
}

export type Row =
	| { kind: "session"; info: SessionInfo }
	| { kind: "archived"; info: ArchivedSession }
	| { kind: "hidden"; info: ArchivedSession }
	| { kind: "header"; label: string }
	| { kind: "new"; label: string; hint: string }
	| { kind: "refresh"; label: string }
	| { kind: "quit"; label: string };

export function isSelectable(row: Row): boolean {
	return row.kind !== "header";
}

export interface ClickTarget {
	row: number;
	colStart: number;
	colEnd: number;
	index: number;
}

/** Mutable click-target table rebuilt by render() on every paint; the key
 * handler reads it to map mouse rows back onto logical rows. */
export const clickTargets: ClickTarget[] = [];

export function buildRows(
	sessions: SessionInfo[],
	archived: ArchivedSession[],
	hidden: ArchivedSession[],
	retentionDays: number,
	L: import("./types.ts").PickerLabels,
): Row[] {
	const rows: Row[] = [];
	if (sessions.length > 0) {
		rows.push({ kind: "header", label: L.live_group });
		for (const info of sessions) rows.push({ kind: "session", info });
	}
	if (archived.length > 0) {
		const headerLabel = (L.historical_group || "Recent (last {days}d)").replace(
			"{days}",
			String(retentionDays),
		);
		rows.push({ kind: "header", label: headerLabel });
		for (const info of archived) rows.push({ kind: "archived", info });
	}
	if (hidden.length > 0) {
		rows.push({ kind: "header", label: L.archived_group });
		for (const info of hidden) rows.push({ kind: "hidden", info });
	}
	rows.push(
		{ kind: "new", label: L.new_session, hint: L.new_session_hint },
		{ kind: "refresh", label: L.refresh },
		{ kind: "quit", label: L.quit },
	);
	return rows;
}
