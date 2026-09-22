/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * spawnTmuxWindow — opens a new tmux window for the CLI, sets env, places slug marker, captures produced turn.
 */


	// Source-mode PATH precedence (dev-host-scala-tools-source-mode). The daemon
	// runs under Bun from a service dir, so its inherited PATH (which every
	// spawned pane gets via the tmux server env) lists ancestor node_modules/.bin
	// FIRST — that shadows ~/.bun/bin/scala-tools (the live source-mode binary)
	// with whatever stale published copy a node_modules happens to hold. That
	// shadow defeated source-mode workspace-wide and let pre-chokepoint clients
	// publish untagged versions (publish-tag-integrity bleed, 2026-05-31).
	// Prepend the source-mode bin dirs so every spawned pane resolves scala-tools
	// (and other ~/.local|.bun tools) to source. Idempotent — only reorders
	// priority, never removes a path; node_modules-only binaries still resolve.
	// Strip the daemon's own service identity from every spawned CLI pane.
	// service-runtime injects SERVICE_SLUG and PORT to boot session-picker, and
	// both leak into each pane through the tmux server env. An agent in such a
	// pane that starts a service inherits them, booting it as the WRONG service
	// (loga crash-looped on a session-picker slug, 2026-06-26) or onto the WRONG
	// port (scala-quiz bound session-picker's 3021, 2026-07-31). Spawned agent
	// panes have no business carrying a service identity, so unset the set
	// before the CLI starts. Harmless to the agent CLIs (none read either); only
	// service-runtime does. The durable fix is `scrubTmuxServerIdentityEnv` at
	// daemon boot, which removes these from the tmux SERVER env so panes created
	// outside this code path are clean too; this stays as the per-spawn belt.
	// Host-wide Bun/JSC runtime tuning, from the SAME `config/bun-runtime-tuning`
	// row the ecosystem transform injects into every PM2 service. An agent lane
	// is a Bun process too, and until 2026-07-28 nothing applied the row here —
	// so the tuning stopped at the service boundary and the gap was invisible.
	//
	// It was the largest idle-power item on the host. Measured with
	// `scala-tools wakeups`: five pi lanes at 1,165-2,136 wakeups/sec each, ~7,700
	// of the platform's 10,472 (73%), all in JSC HeapHelper threads — services ran
	// ZERO of those threads, lanes ran FIVE apiece. Isolated confirmation: 2,108
	// wakeups/sec by default vs 157 with the marker count pinned, a 13.4x cut from
	// one variable. Invisible in behaviour, which is why it survived.
	//
	// Fails soft to "" — a lane must always spawn, tuned or not.

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

async function spawnTmuxWindow(
	option: MenuOption,
	tmuxSession: string,
	focus: boolean,
	/** Spawn overrides, NAMED (not positional) so two same-typed strings
	 * (seedId, cwdOverride) can never be transposed at a call site. The prior
	 * positional form fed cwd into the --session-id slot and the UUID into the
	 * cwd slot, crashing every fleet-dispatched Claude lane on boot
	 * ("Invalid session ID. Must be a valid UUID.") while bare spawns — which
	 * pass neither seedId nor cwd — stayed dormant and masked the bug. */
	{
		resumeId,
		windowNameOverride,
		seedId,
		cwdOverride,
		requestedBy,
		workItemId,
		idempotencyKey,
		freshSession,
	}: {
		resumeId?: string;
		/** New conversation: a seeded id is not promoted to a resume (fleet spawns). */
		freshSession?: boolean;
		windowNameOverride?: string;
		/**
		 * Caller-supplied idempotency key. Persisted onto the tab row so a retried
		 * spawn (same key) is recognised by `findLiveIdempotentTab` at the top of
		 * `spawnOptionInSession` and returned as the existing lane instead of
		 * opening a second window.
		 */
		idempotencyKey?: string;
		/** The `work_items` project this lane is opened to work on, exported into
		 *  the pane as SCALA_LANE_WORK_ITEM for the SessionStart bind. */
		workItemId?: string;
		/** WHO asked for this pane, persisted onto the tab row so ownership is
		 *  queryable from session-state rather than only reconstructable from an
		 *  event_log join. Threaded from spawnOptionInSession, which requires it. */
		requestedBy?: string;
		/** Fleet-provided session id to SEED (--session-id) rather than generating
		 * one. When provided (and no resumeId), the new Claude session is created
		 * with this id → JSONL is {seedId}.jsonl → the tail watches an exact file. */
		seedId?: string;
		/** Original cwd from the tab state. When resuming a session under a different
		 * slug, the new option's cwd may differ from where the session was created.
		 * Using the original cwd ensures `--resume <id>` finds the .jsonl in the
		 * right project directory. Falls back to the option's cwd when absent. */
		cwdOverride?: string;
	},
): Promise<SpawnResult> {
	const command = option.config.command;
	if (!command) throw new Error(`spawn: option "${option.slug}" has no command`);

	// Preflight: refuse BEFORE opening a window if the launch binary is gone.
	// Without this the daemon creates the window, the exec fails inside tmux,
	// and the operator sees a pane flash and die while the real reason
	// ("Failed to find executable …: No such file or directory") is buried in
	// daemon logs — which reads as "the picker is broken" when the picker is
	// faithfully launching a binary that no longer exists (2026-07-25, a native
	// claude auto-update left ~/.local/bin/claude dangling).
	const missingBinaries = await findMissingBinaries(extractLaunchPaths(command, userHome()));
	if (missingBinaries.length > 0) {
		throw new Error(formatPreflightError(option.slug, missingBinaries));
	}

	// A restore passes the stored windowName so a reopened tab keeps its label
	// (SCM, DB Theming, …) instead of the option's default. The override is
	// still uniquified (never collide with a live window), but numbering is off
	// — a restored name is taken verbatim when free.
	const baseName = windowNameOverride ?? option.config.window_name ?? option.slug;
	const numbered = windowNameOverride ? false : option.config.window_name_numbered;
	const windowName = uniqueWindowName(tmuxSession, baseName, numbered);

	let commandToRun = command;
	let seededId: string | null = null;
	const resume = option.config.resume;
	const warnings: string[] = [];
	const resumeCandidate = freshSession
		? resumeId
		: (resumeId ?? (seedId && (await sessionTranscriptExists(seedId)) ? seedId : undefined));
	// Whether this spawn REPLAYED a prior conversation (as opposed to seeding a
	// fresh one). Read further down to decide whether the lane needs the
	// continuation instruction — only a resumed lane does.
	let didReplay = false;
	if (resumeCandidate && resume?.replay) {
		if (isValidSessionId(resumeCandidate)) {
			commandToRun = `${command} ${resume.replay.replace(/\{id\}/g, resumeCandidate)}`;
			seededId = resumeCandidate;
			didReplay = true;
		} else {
			const reason = `refusing to replay malformed session id "${resumeCandidate}" for "${option.slug}" — not a full UUID; spawning fresh`;
			warnings.push(reason);
			getAppLogger().warn(`spawn: ${reason}`);
			// Fall through to the seed branch below (mint fresh) — do NOT replay.
		}
	}
	if (seededId === null && resume?.seed) {
		seededId = seedId ?? Bun.randomUUIDv7();
		commandToRun = `${command} ${resume.seed.replace(/\{id\}/g, seededId)}`;
	}

	const tuningPrefix = await runtimeTuningPrefix();
	// Credentials are different: a declared secret is required for the selected
	// option to be the option the operator requested. Resolution therefore fails
	// closed before tmux opens instead of silently launching against another
	// provider or borrowing another CLI's credential store.
	const credentialPrefix = await secretEnvPrefix(option.config.secret_env ?? []);
	// The project this lane is opened to work on, handed to the CLI's
	// SessionStart hook so its task row is parented under that project rather
	// than floating. Shell-quoted because it reaches the pane through a command
	// string; only present when the caller named a project, so a spawn without
	// one is byte-identical to what it was before.
	const workItemPrefix = workItemId
		? `export SCALA_LANE_WORK_ITEM=${JSON.stringify(workItemId)}; `
		: "";
	commandToRun = `unset ${SERVICE_IDENTITY_VARS.join(" ")}; export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; ${workItemPrefix}${tuningPrefix}${credentialPrefix}${commandToRun}`;

	// When resuming, use the original cwd from the tab state so the CLI
	// starts in the directory where the session was created — critical for
	// cross-slug resume where the new option's cwd may differ. Also extend
	// the startup probe: a resume CLI that can't find its session file exits
	// shortly after boot, and the longer probe catches that crash before the
	// daemon returns ok (the window-unlinked hook race).
	const effectiveCwd = cwdOverride ?? option.config.cwd;
	const probeMs = seedId ? 0 : (resumeId ? 5000 : 1500);
	const result = newWindow({
		session: tmuxSession,
		name: windowName,
		command: commandToRun,
		focus,
		cwd: effectiveCwd,
		probeMs,
	});

	if (!result.ok) {
		const parts = [result.error ?? "newWindow failed"];
		if (result.paneOutput) parts.push(result.paneOutput);
		throw new Error(parts.join("\n"));
	}

	setOptionSlugMarker(tmuxSession, windowName, option.slug);

	// Capture the stable window id (+ first pane id) at spawn so the tab is
	// id-anchored from birth — a later rename updates the label on this same
	// tab (matched by windowId) instead of being seen as a new window.
	const windowId = listWindows(tmuxSession).find((w) => w.name === windowName)?.id;
	const paneId = windowId ? (firstPaneIdForWindow(windowId) ?? undefined) : undefined;

	// Register the visible assignment directly in the canonical runtime table.
	// The old lane-event HTTP post coupled opening a tab to scala-agents-ui and
	// could silently lose the identity while that service restarted. A fleet
	// assignment is not usable until this durable row exists.
	if (workItemId && paneId) {
		await registerCliSession({
			workItemId,
			windowName,
			optionSlug: option.slug,
			runtimeSlug: option.slug,
			provider: option.family?.key,
			paneId: `tmux:${paneId}`,
			nativeSessionId: seededId ?? undefined,
			commandId: requestedBy,
		});
	}

	const cwd = paneCurrentPath(tmuxSession, windowName) ?? option.config.cwd ?? null;
	const tabId = createTabId();
	const state = await loadSessionState(tmuxSession);
	state.tabs.push({
		tabId,
		optionSlug: option.slug,
		workItemId,
		windowId: windowId || undefined,
		paneId,
		windowName,
		// Store the option's COMMAND TEMPLATE — never the materialised
		// `commandToRun`. The latter prepends resolved `secret_env` values as
		// `export SECRET='literal';`, and this row is type `config`
		// (session-state), NOT `secret`, so a credential here leaks to every
		// /rpc/closed-tabs reader (credentials-only-in-secret-rows). The
		// materialised command still reaches the pane via `newWindow` above; the
		// stored `command` is informational only and replay uses `sessionId`.
		command,
		cwd: cwd ?? undefined,
		sessionId: seededId,
		// Ownership is recorded on the ROW, not only on the spawn event, so
		// "which lanes are mine" is a query rather than a reconstruction from
		// event_log joined on timestamp and window name. requestedBy is required
		// on this function, so this is always a real value.
		requestedBy,
		// The caller-supplied idempotency key, so a retried spawn recognises this
		// tab and returns it instead of creating a duplicate lane.
		idempotencyKey,
	});
	await saveSessionState(tmuxSession, state);

	// Start the lane's channel daemon from HERE, not from a CLI hook. A CLI
	// that never fires SessionStart leaves its hook unrun, and every such pane
	// reported `relay-detect: not-found` — messages
	// to it were emitted, confirmed, and read by nothing. The picker knows the
	// pane and the seeded session id at exactly this point, so it can do what the
	// missing hook would have done, for any CLI whose hook does not fire.
	startChannelDaemonDetached({
		cliKind: cliKindForGroup(option.family?.key),
		paneId,
		sessionId: seededId ?? null,
	});

	return {
		ok: true,
		windowName,
		paneId,
		slug: option.slug,
		resumed: didReplay,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
