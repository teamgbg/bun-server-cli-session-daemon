/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * uniqueWindowName — collision-free tmux window-name allocator (numbered series or millis suffix).
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

function uniqueWindowName(session: string, base: string, numbered = false): string {
	const existing = new Set(listWindows(session).map((w) => w.name));
	// Numbered series: always suffix, starting at -1 (scala-1, scala-2, …).
	// Default: leave the first window bare and only number collisions.
	if (!numbered && !existing.has(base)) return base;
	const start = numbered ? 1 : 2;
	for (let i = start; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}
