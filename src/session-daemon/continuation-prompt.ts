/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Default prompt handed to every RESUMED lane so it does not sit on its full context and do nothing.
 */


/**
 * Handed to every lane a spawn RESUMES. Phrased as continuation, not as a new
 * assignment: the lane still holds its own task list and history, so the whole
 * job of the instruction is to say "this is the same session, keep going" and to
 * head off the two failure modes a resumed agent falls into — restarting
 * finished work, or re-planning from scratch.
 *
 * It lives HERE, on the single spawn surface, rather than in any one caller. It
 * used to belong to switch-model alone, so only a model switch told its lanes to
 * continue: `/rpc/spawn` with a resume id and the restore path both brought lanes
 * back holding their full context and silent. That is indistinguishable from work
 * being lost, and an operator said so directly on 2026-07-30 — "when you
 * respawned it didn't get notified automatically to keep going". Making it a
 * property of RESUMING means every path that brings a lane back gets it, and no
 * future caller has to remember.
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

export const DEFAULT_CONTINUATION_PROMPT =
	"Your lane was resumed with your full conversation intact — nothing was lost. Continue exactly where you left off: re-read your task list, confirm what is still unfinished, and carry on with the next item. Do not restart, re-plan, or redo work you have already completed.";
