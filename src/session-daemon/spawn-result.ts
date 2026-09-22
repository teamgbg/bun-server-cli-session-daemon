/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * SpawnResult type — the ok/error/result shape every spawn caller hands back.
 */


	/**
	 * The REAL reason a spawn returned ok:false — what actually happened, never
	 * an HTTP status code or a generic "failed". A caller (spawn_agent_tab)
	 * surfaces this verbatim to the orchestrator, and an opaque reason there cost
	 * three wrong hypotheses on 2026-08-01 (the caller fell back to
	 * `session-picker returned 200` — an HTTP SUCCESS presented as a failure —
	 * because this field was absent and the body carried only `warnings`).
	 *
	 * `friction-is-a-stop-condition`: a component that knows why it failed EMITs
	 * that reason. Every ok:false SpawnResult sets this; ok:true never does.
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

export interface SpawnResult {
	ok: boolean;
	windowName?: string;
	/** Stable address of the spawned pane (raw tmux `%<id>` form). */
	paneId?: string;
	slug: string;
	output?: string;
	exitCode?: number;
	/** Non-fatal issues observed during spawn (e.g. a malformed resume id was
	 * refused and the tab opened fresh). Surfaced so callers/restore can log. */
	warnings?: string[];
	error?: string;
	/**
	 * True when this spawn REPLAYED an existing conversation rather than seeding a
	 * fresh one. Load-bearing in two directions: it decides whether the lane is
	 * handed the continuation instruction (only a resumed lane needs telling to
	 * carry on), and it lets a caller distinguish "your session is back" from "a
	 * new session opened under that name" — a distinction `/rpc/spawn` used to
	 * collapse into an identical `{"ok":true}`, which is how an operator was told
	 * their conversation had resumed when it had not.
	 */
	resumed?: boolean;
}
