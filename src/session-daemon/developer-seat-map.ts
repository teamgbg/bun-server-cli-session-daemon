/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The bridge between a developer-session project and the LIVE tmux session its
 * orchestrator seat occupies — the single lookup every session-state surface
 * uses instead of deriving keys from a mutable session name.
 *
 * WHY THIS EXISTS. A session-state row was keyed `session-state-<tmux-name>`:
 * a slug derived from the very thing being renamed could not survive the
 * rename, which is why renaming a developer project orphaned the row for every
 * user but one. The stable identity is the project's work_items id; the MUTABLE
 * fact is what tmux session it currently lives in. This module reads the pair
 * the way host-command-bus session_names.rs does — the seats join, then a pane
 * capability probe (a session NAME is never inferred from resemblance to a
 * title; shape inference was the whole failure) — and answers both directions.
 *
 * Rust twin carrying the identical join: scala-rust/crates/adapters/
 * host-command-bus/src/session_names.rs DEVELOPER_SESSION_SEATS_SQL. One fact,
 * two languages, changed together until a cross-language constants row owns it.
 */

import { run } from "@teamscala/tmux-session/command-runner";
import { getPrisma } from "@teamscala/db/prisma-registry";

interface SeatMapEntry {
	projectId: string;
	title: string;
	liveSession: string | null;
}

/// Mirror of session_names.rs DEVELOPER_SESSION_SEATS_SQL (see header).
const SEATS_SQL = `
	SELECT DISTINCT ON (p.id)
		p.id::text AS project_id,
		p.title AS title,
		s.host_route->>'pane_id' AS pane_id
	FROM work_items p
	JOIN cli_sessions s ON s.work_item_id = p.id
		AND s.closed_at IS NULL AND s.role = 'orchestrator'
	WHERE p.kind = 'project'
		AND p.kind_data->>'category' = 'developer_session'
		AND NULLIF(s.host_route->>'pane_id', '') IS NOT NULL
	ORDER BY p.id, s.created_at DESC`;

const PROBE_TIMEOUT_MS = 2_000;

function probeLiveSession(paneId: string): string | null {
	const result = run(["display-message", "-p", "-t", paneId, "#{session_name}"], {
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	return result.exitCode === 0 && result.stdout.trim().length > 0
		? result.stdout.trim()
		: null;
}

let memo: { at: number; entries: SeatMapEntry[] } | null = null;

// Staleness CEILING, not a cadence (same semantics as the session-id index's
// ceiling): the map degrades within a minute if invalidation were ever missed,
// and otherwise serves across bursts without re-probing tmux per call.
const MEMO_CEILING_MS = 60_000;

export async function loadDeveloperSeatMap(): Promise<SeatMapEntry[]> {
	if (memo && Date.now() - memo.at < MEMO_CEILING_MS) return memo.entries;
	const rows = await getPrisma().$queryRawUnsafe<
		Array<{ project_id: string; title: string; pane_id: string }>
	>(SEATS_SQL);
	const entries: SeatMapEntry[] = rows.map((r) => ({
		projectId: r.project_id,
		title: r.title,
		liveSession: probeLiveSession(r.pane_id),
	}));
	memo = { at: Date.now(), entries };
	return entries;
}

/** The developer-session project owning a LIVE tmux session, or null when the
 * session belongs to no project (an operator shell session keeps its legacy
 * name-keyed row — nothing about renames governs it). */
export async function projectIdForTmuxSession(
	sessionName: string,
): Promise<string | null> {
	try {
		const entries = await loadDeveloperSeatMap();
		return entries.find((e) => e.liveSession === sessionName)?.projectId ?? null;
	} catch {
		// A failed bridge must not strand writers: fall back to legacy keying.
		return null;
	}
}

/** The live tmux session a project's seat currently occupies — the inverse the
 * list/display surfaces need once slugs carry the immutable project id. */
export async function sessionNameForProjectId(
	projectId: string,
): Promise<string | null> {
	try {
		const entries = await loadDeveloperSeatMap();
		return entries.find((e) => e.projectId === projectId)?.liveSession ?? null;
	} catch {
		return null;
	}
}

/** Pure: a project-id-keyed row suffix is a UUID; anything else is a legacy
 * name suffix awaiting the boot rekey (or an ownerless operator session). */
export function isProjectKeyedSuffix(slug: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
}

/** Pure: render a stored row's display name — the live tmux session behind a
 * project-keyed suffix, the suffix itself when legacy/name-keyed. */
export function displayNameForSuffix(
	suffix: string,
	seats: Array<Pick<SeatMapEntry, "projectId" | "liveSession">>,
): string {
	if (!isProjectKeyedSuffix(suffix)) return suffix;
	return (
		seats.find((e) => e.projectId === suffix)?.liveSession ?? suffix
	);
}
