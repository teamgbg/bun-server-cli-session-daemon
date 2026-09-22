/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * spawnOptionInSession — single spawn surface: pickers/CLI flags, seed/replay, brief delivery, reap-on-fail.
 */


	// RESTORE path: caller supplies the id of a prior conversation to reopen.
	// Consumes the option's `resume.replay` template (e.g. `--resume {id}` for
	// Claude Code, `--session {id}` for OpenCode). This is the missing primitive
	// that makes "restore a closed session" real — previously `replay` was
	// declared in the schema + documented but no code path consumed it, so a
	// killed/closed pane could never be reopened resumed. The captured id is
	// recorded as the tab's sessionId so a subsequent reconcile keeps it.
	//
	// Truncation hardening: a resumeId that isn't a FULL UUID (8-4-4-4-12) is
	// REFUSED here — replaying a truncated id resolves to no conversation and
	// propagates the bad id forward. Fall through to seed/fresh instead so the
	// tab at least opens functional. The closed-tabs truncation incident
	// (Scala-Chrome-Ext, 2026-07-04) is the class this guard closes.
	// THE SESSION UUID IS THE SINGLE SOURCE OF TRUTH for which conversation a tab
	// is (operator ruling 2026-07-30: "session should be single source of truth
	// since its uuid"; the window NAME is a human label carried alongside, never a
	// key — names are non-unique, renamed freely, and reused across incarnations).
	//
	// So a caller that names an EXISTING session gets that session REPLAYED, and it
	// does not have to know which of two parameters to use. `sessionId` used to mean
	// "seed a NEW session with this id" while `resumeId` meant "replay this one" —
	// two spellings for one uuid, and picking the wrong one silently produced a
	// fresh empty tab under the name you asked to restore. That happened in front of
	// the operator: `/rpc/spawn` with the correct uuid in `sessionId` returned a
	// clean `{"ok":true}` and spawned `--session-id 019fb287-…`, a brand new
	// conversation, while their real session sat untouched on disk.
	//
	// Deciding here rather than at the call site is the point: the CLI-specific
	// spelling (`--session` vs `--resume` vs `--session-id`) already lives in the
	// option row's `resume` block, so the daemon is the only place holding all the
	// information. A caller supplying a uuid that already has a transcript means
	// "resume", every time, whichever field carried it.
	// A caller that STATES its intent is believed; only a silent one is guessed at.
	// Fixtures + the 2026-08-02 incident: `fresh-session.test.ts`.


		/**
		 * WHO asked for this pane — the picker's tty, a calling pane identity, or
		 * a tool name. REQUIRED, not optional: it was optional with an
		 * `?? "unattributed"` default, and the result was that 100% of spawns
		 * recorded "unattributed" while the field looked instrumented. A default
		 * that absorbs a missing value cannot be distinguished from a value, so
		 * the omission is silent and permanent — every caller that forgot it
		 * looked identical to one that could not know.
		 *
		 * Making it required moves the failure to the call site, where a compiler
		 * error names the caller that has not decided. Callers that genuinely
		 * cannot identify their requester must say so EXPLICITLY by passing a
		 * describing string, so "we do not know" is a recorded decision rather
		 * than an absent field.
		 */


		/**
		 * The `work_items` row this lane is being opened to work ON — a project id.
		 *
		 * Exported into the pane as SCALA_LANE_WORK_ITEM so the CLI's SessionStart
		 * hook can pass it to taskSync `bindLane` as the parent, which parents the
		 * lane's task row UNDER that project. Without it every lane binds to a
		 * free-floating task: `bindLane` has always accepted a parent_id, but no
		 * spawn path supplied one, so the field was unreachable in practice and
		 * every lane's work hung off an unparented row titled after the lane. The
		 * operator could see ten engineering questions in their project view and
		 * not the one project a real person had asked for, because that project's
		 * subtasks were parented to lane scratch instead of to it.
		 *
		 * Optional: a lane opened for exploration has no project, and that is a
		 * legitimate spawn rather than an omission to default away.
		 */


			// The lane's opening brief is delivered HERE, with the spawn, because a
			// channel message sent afterwards races the CLI's startup and loses.
			//
			// A RESUMED lane gets the continuation prompt by DEFAULT — the caller no
			// longer has to remember. A resumed CLI restores its transcript and then
			// WAITS: with no instruction it holds its entire context and does nothing,
			// which is indistinguishable from work that was lost. That reasoning was
			// already written down, and it lived in switch-model, so only the
			// switch-model caller acted on it: `/rpc/spawn` with a resumeId and the
			// restore path both brought lanes back silent. Measured 2026-07-30 — an
			// operator's lane was resumed with its full history and sat idle, and the
			// operator's read was the correct one: "when you respawned it didn't get
			// notified automatically to keep going".
			//
			// Defaulting here rather than at each call site is the whole point: this is
			// the single spawn surface, so "resumed lanes are told to continue" is now
			// a property of RESUMING instead of a step three callers each have to
			// repeat. Pass `initialPrompt: ""` to opt out deliberately.
			//
			// The brief is TYPED into the composer (paste-buffer + Enter) and the
			// delivery is verified to PRODUCE A TURN, never merely to empty the
			// composer. The positional-arg path that used to run for options whose
			// command declared a `{prompt}` placeholder is gone: one CLI DISPLAYS
			// a positional prompt above an EMPTY composer and never takes a turn, so
			// the arg path's Enter no-oped on the empty composer and reported
			// delivered while the lane sat on an unread brief doing nothing
			// (2026-07-31 — three lanes at 4% context with zero uploads, each
			// reported delivered). A typed brief lands in the composer, and
			// deliverInitialPrompt verifies the composer HELD it, EMPTIED on submit,
			// AND produced a turn.


					// REAP THE WINDOW. Reporting ok:false while LEAVING the pane open is
					// what produces the state the operator actually sees: a tab that looks
					// like a working lane, sitting on a brief nobody will ever read. The
					// caller is then told the spawn failed and the fleet is told a lane
					// exists, and both act on it — the orchestrator re-dispatches while the
					// tab bar fills with panes at 4% context uploading nothing.
					//
					// ok:false must therefore MEAN "no lane exists", never "a lane exists
					// but did not start". That is the difference between a failure and a
					// mess, and it is why this is construction rather than a sweep: a
					// stranded lane cannot accumulate if it is never left behind
					// (no-uncontrolled-repetition-or-cascade; the dead-pane sweep exists to
					// catch crashes, not to clean up after our own failed spawns).
					//
					// RE-CHECK IMMEDIATELY BEFORE KILLING. The delivery verdict is a
					// SNAPSHOT taken when the budget ran out, and a lane whose first act is
					// a long tool call (a workspace `find`, a repo-wide grep) produces no
					// upload figure for a while — indistinguishable, at that instant, from
					// a lane that never started. Reaping on the stale verdict therefore
					// kills healthy lanes.
					//
					// Measured 2026-08-01, and it was this code that did it: a lane sitting
					// at ⇑239k, actively grepping for its task's symbols, was SIGTERMed —
					// `journalctl` shows "Sending signal SIGTERM to process (the CLI) on
					// client request", 150.4M peak, so not OOM and not a crash. It was this
					// reap, acting on a verdict that had already expired. A reap that
					// destroys working lanes is worse than the stranding it was added to
					// prevent, because the stranded lane was at least recoverable.
					//
					// So the kill is gated on the CURRENT state, not the remembered one:
					// if the lane has produced a turn by now, it started late rather than
					// never, and it is left alone with the warning downgraded.

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

export async function spawnOptionInSession(
	slug: string,
	tmuxSession: string,
	opts: {
		focus?: boolean;
		resumeId?: string;
		windowName?: string;
		cwd?: string;
		seedId?: string;
		requestedBy: string;
		/** Fleet spawn only: refuse a disabled runtime at the fleet route wall;
		 *  operator spawns pass false and remain unconstrained. */
		enforceRuntimePolicy?: boolean;
		/** A schema-discriminated fresh request is a new lane, never a continuation. */
		freshSession?: boolean;
		/**
		 * First instruction for the lane, delivered into the pane once its CLI is
		 * up. A lane's opening brief MUST travel with its spawn: a channel message
		 * sent afterwards races the CLI's startup and loses, because a subscriber
		 * registers during boot but nothing consumes until the first turn. The send
		 * is then confirmed at the transport and read by nothing, which strands the
		 * assignment — observed 2026-07-27, a lane spawned, assigned, dispatch
		 * `native-confirm confirmed`, and idle forever holding work it never saw.
		 */
		initialPrompt?: string;
		workItemId?: string;
		/**
		 * Caller-supplied idempotency key. When set, a prior LIVE lane spawned
		 * under the same key is returned instead of creating a new window — making
		 * a retried spawn safe by construction. Omit for a spawn that should
		 * always open fresh (the legacy behaviour).
		 */
		idempotencyKey?: string;
	},
): Promise<SpawnResult> {
	// IDEMPOTENT SPAWN: a caller-supplied idempotency key lets a retried spawn
	// return the lane the FIRST attempt already opened, instead of creating a
	// second window — `uniqueWindowName` would otherwise append "-2" and both
	// lanes would race on the same files doing identical work. The check lives
	// HERE, the single spawn surface, so a retry is safe by construction at the
	// point the second create is attempted, never safe-only-if-nobody-retries.
	// A prior window that has since died falls through to a fresh spawn (the key
	// is re-recorded on the new tab; the dead row is pruned by reconcile).
	if (opts.idempotencyKey) {
		const state = await loadSessionState(tmuxSession);
		const existing = findLiveIdempotentTab(
			normaliseTabs(state.tabs),
			opts.idempotencyKey,
			(tab) =>
				tab.windowId
					? windowExists(tab.windowId)
					: listWindows(tmuxSession).some((w) => w.name === tab.windowName),
		);
		if (existing) {
			recordEvent({
				kind: "cli-session.spawn.idempotent-hit",
				payload: {
					idempotencyKey: opts.idempotencyKey,
					windowName: existing.windowName,
					slug: existing.optionSlug,
				},
			});
			return {
				ok: true,
				windowName: existing.windowName,
				paneId: existing.paneId,
				slug: existing.optionSlug,
				resumed: Boolean(existing.sessionId),
			};
		}
	}
	const focus = opts.focus ?? true;
	const options = await queryActiveOptions();
	const option = options.find((o) => o.slug === slug);
	if (!option) {
		const available = options.map((o) => o.slug).join(", ");
		throw new Error(
			`spawn: no session_picker_option with slug "${slug}" (available: ${available})`,
		);
	}
	// Fleet spawns are bound to the selected typed launch option AT THE WALL: a
	// direct /rpc/spawn call cannot bypass the row's fleet eligibility.
	if (opts.enforceRuntimePolicy) {
		const guard = assertFleetSpawnable(
			option,
			options,
		);
		if (!guard.ok) {
			recordEvent({
				kind: "cli-session.spawn.runtime-refused",
				payload: { slug, cli_family: option.family?.key ?? null },
			});
			return { ok: false, slug, error: guard.error };
		}
	}

	// When resuming with a resumeId but no explicit cwd, resolve the original
	// working directory from the session state by matching the resumeId against
	// stored tabs' sessionId. This covers the direct /rpc/spawn path (where the
	// caller passes resumeId but has no way to know the original cwd) — critical
	// for cross-slug resume where the new option's cwd differs from where the
	// session was created. The restoreSession path passes cwd explicitly, so
	// this is a fallback that also catches the direct spawn case.
	let resolvedCwd = opts.cwd;
	if (opts.resumeId && !resolvedCwd) {
		try {
			const state = await loadSessionState(tmuxSession);
			const tab = [...(state.tabs ?? []), ...(state.closedTabs ?? [])].find(
				(t) => t.sessionId === opts.resumeId,
			);
			if (tab?.cwd) resolvedCwd = tab.cwd;
		} catch {
			// Best-effort: if we can't load session state, fall through to the
			// option's default cwd. A failed resume is better than no attempt.
		}
	}

	switch (option.config.action_type) {
		case "tmux_window": {
			// AWAITED deliberately. `spawnTmuxWindow` is async, and without the await
			// `spawned` is a Promise whose `.paneId` is undefined — so the delivery
			// guard below never fired and every lane's opening brief was silently
			// dropped, while the spawn itself still resolved correctly at the caller
			// and looked healthy.
		const spawned = await spawnTmuxWindow(option, tmuxSession, focus, {
			requestedBy: opts.requestedBy,
			resumeId: opts.resumeId,
			windowNameOverride: opts.windowName,
			seedId: opts.seedId,
			cwdOverride: resolvedCwd,
			workItemId: opts.workItemId,
			idempotencyKey: opts.idempotencyKey,
			freshSession: opts.freshSession === true,
		});
			// Emit here, at the ONE place tmux windows are actually created, rather
			// than in the picker. The picker already logged launch + select, but
			// only ever recorded WHAT (term, session, action) and never WHO — and a
			// caller reaching /rpc/spawn directly bypassed it entirely, so a pane
			// could appear with no record anywhere. Three panes did exactly that on
			// 2026-07-25 and nothing in event_log, the attribution records, or the process
			// tree could say who made them (tmux reparents every pane to its server,
			// so the OS cannot answer either). Logging at the creation point means a
			// bypassing caller is still recorded.
			recordEvent({
				kind: "cli-session.lane.spawned",
				payload: {
					slug,
					tmuxSession,
					windowName: opts.windowName ?? null,
					resumed: Boolean(opts.resumeId),
					// No `?? "unattributed"` fallback: the type now requires this, so a
					// caller that cannot identify its requester states that explicitly
					// rather than having a default silently stand in for it.
					requestedBy: opts.requestedBy,
				},
			});
			const promptToSend =
				opts.initialPrompt ?? (spawned.resumed ? DEFAULT_CONTINUATION_PROMPT : undefined);
			if (promptToSend && spawned.paneId) {
				const outcome = await deliverInitialPrompt(
					spawned.paneId,
					promptToSend,
					cliKindForGroup(option.family?.key),
				);
				if (outcome === "vanished") {
					spawned.ok = false;
					spawned.error =
						"the spawned window closed immediately — its command exited before the lane started; check the option's command and provider env";
					spawned.warnings = [
						...(spawned.warnings ?? []),
						"the spawned window closed immediately — its command exited; check the option's command and provider env",
					];
				} else if (outcome === "undelivered") {
					// FAIL the spawn: a lane whose brief produced no turn has not started,
					// and ok:true here is exactly what let stalled lanes accumulate looking
					// healthy (2026-07-31). The delivery is verified to produce a turn, so
					// an undelivered outcome means the brief never reached the model.
					spawned.ok = false;
					spawned.warnings = [
						...(spawned.warnings ?? []),
						"the brief could not be delivered or produced no turn — the lane has not started; check the option's command and provider env",
					];
					const startedLate = await captureProducedTurn(
						spawned.paneId,
						cliKindForGroup(option.family?.key),
					);
					if (startedLate) {
						spawned.ok = true;
						spawned.warnings = [
							...(spawned.warnings ?? []),
							"the lane produced its first turn AFTER the delivery budget expired — started late, not stranded; left running",
						];
					} else {
						const reaped = await closeWindowForPane(spawned.paneId);
						// The REAL reason, surfaced to the caller verbatim. Names
						// the known long-brief shape so an orchestrator reading it
						// stops chasing memory/args/ghost-row hypotheses.
						spawned.error = reaped.ok
							? "the opening brief was pasted into the composer but produced no turn within the delivery budget; the lane was reaped (no lane left behind). A long brief can fail to submit via keystroke (the submit Enter is consumed as a newline while the TUI ingests the paste); or the CLI failed to start — check the option's command and provider env"
							: `the opening brief produced no turn and the stranded window could not be closed (${reaped.error ?? "unknown"}) — a pane holding an undelivered brief may still be open`;
						spawned.warnings = [
							...(spawned.warnings ?? []),
							reaped.ok
								? "the stranded window was closed — no lane was left behind"
								: `the stranded window could NOT be closed (${reaped.error ?? "unknown"}) — a pane holding an undelivered brief is still open`,
						];
					}
				}
			}
			return spawned;
		}
		case "ops":
			return spawnOps(option);
		default:
			throw new Error(
				`spawn: action_type "${option.config.action_type}" for "${slug}" is not daemon-spawnable`,
			);
	}
}
