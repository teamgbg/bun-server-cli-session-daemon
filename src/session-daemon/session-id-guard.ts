/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Session-id shape guard + transcript probe — refuses replaying a malformed uuid into --resume.
 */


/**
 * Does a transcript already exist on disk for this session uuid?
 *
 * This is what lets the SESSION UUID be the single identifier a caller supplies
 * (operator ruling 2026-07-30). The daemon asks the filesystem whether the id
 * names an existing conversation and picks replay-vs-seed itself, so a caller
 * cannot get a tab back empty by putting the right uuid in the wrong parameter —
 * the failure that handed the operator a blank pane while their real session sat
 * on disk untouched.
 *
 * Matches by SUBSTRING because each CLI names its file differently and only the
 * uuid is common: pi writes `<iso-timestamp>_<uuid>.jsonl`, Claude Code writes
 * `<uuid>.jsonl`, and both sit under a per-project directory whose name is a
 * mangled cwd. Keying on the uuid alone is the only thing stable across all of
 * them, which is precisely the ruling's point.
 *
 * Answers FALSE on any read failure. A false negative seeds a fresh session —
 * recoverable and obvious. A false positive would replay an id with no
 * transcript, which for some CLIs starts an empty session that then LOOKS
 * resumed, and that is the failure mode being eliminated.
 */
/**
 * ASYNC PARALLEL, NEVER A SYNC LOOP (spawn-sync-in-dynamic-loop): the probe
 * pair was a `for` loop of spawnSync calls — fixed two iterations, but each
 * find holds the event loop up to its 5s timeout while a spawn waits on it,
 * which is exactly the blocking class the rule exists for. Both probes now run
 * concurrently and the semantic contract is unchanged: FALSE on any failure,
 * either-root match wins.
 */

import { uptime as osUptime } from "node:os";
import { spawn } from "@teamscala/os/spawn/spawn";
import { userHome } from "@teamscala/os/host-paths";
import {
	firstPaneIdForWindow,
	listWindows,
	newWindow,
	paneCurrentPath,
	setOptionSlugMarker,
	windowExists,
} from "@teamscala/tmux-session/windows";
import { recordEvent } from "@teamscala/event-log/record-event";
import { getAppLogger } from "@teamscala/logger/app-loggers";
import { startChannelDaemonDetached } from "./channel-daemon.ts";
import { captureProducedTurn, deliverInitialPrompt } from "./prompt-delivery.ts";
import { cliKindForGroup } from "./cli-kind.ts";
import { runtimeTuningPrefix } from "./runtime-tuning-env.ts";
import { secretEnvPrefix } from "./secret-env.ts";
import { SERVICE_IDENTITY_VARS } from "./tmux-env-hygiene.ts";
import {
	extractLaunchPaths,
	findMissingBinaries,
	formatPreflightError,
} from "./spawn-preflight.ts";
import { assertFleetSpawnable } from "./spawn-runtime-policy.ts";
import { loadSessionState, saveSessionState } from "./load-save.ts";
import { queryActiveOptions } from "./query-options.ts";
import { closeWindowForPane } from "./rename-close.ts";
import {
	absentNamedRestoreOutcome,
	createTabId,
	findLiveIdempotentTab,
	normaliseTabs,
	reconcileRestore,
	selectRestoreCandidates,
	type RestoreOutcome,
	type RestoreSpawnOutcome,
} from "./state-tabs.ts";
import type { MenuOption } from "./types.ts";
import { spawnOps } from "./spawn-ops.ts";
import { registerCliSession } from "./register-cli-session.ts";

/**
 * Full session-id shape guard. Stored session ids are complete UUIDs (36 chars,
 * 8-4-4-4-12 hex). A value that doesn't match — most dangerously a TRUNCATED
 * UUID (e.g. `019f27b6-db43-7000-b`, 20 chars) — MUST NOT be replayed into a
 * CLI's `--resume {id}` flag: it resolves to no conversation, produces a broken
 * spawn, and the truncated id then propagates forward through every
 * restore→close→restore cycle. Rejecting a malformed id at the replay chokepoint
 * is the hardening for the read→restore truncation class (the Scala-Chrome-Ext
 * closed tab, 2026-07-04, carried a truncated id and would have restored broken).
 */
const FULL_SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isValidSessionId(id: string | null | undefined): id is string {
	return typeof id === "string" && FULL_SESSION_ID.test(id);
}

export async function sessionTranscriptExists(sessionId: string): Promise<boolean> {
	if (!isValidSessionId(sessionId)) return false;
	const roots = [`${userHome()}/.pi/agent/sessions`, `${userHome()}/.claude/projects`];
	const probes = await Promise.all(
		roots.map((root) =>
			spawn({
				name: "session-id-guard:session-transcript-probe",
				// -name over a shell glob: the uuid is embedded mid-filename for pi and
				// leading for Claude, and `find` needs no shell to express either.
				command: ["find", root, "-maxdepth", "3", "-name", `*${sessionId}*`, "-print", "-quit"],
				timeoutMs: 5_000,
			}),
		),
	);
	return probes.some((found) => found.exitCode === 0 && (found.stdout ?? "").trim().length > 0);
}
