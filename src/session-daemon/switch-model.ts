/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Moves live lanes from one `session_picker_option` to another — a different
 * model — carrying each lane's conversation and window name across, and handing
 * the resumed lane a continuation instruction so it picks its work back up
 * instead of sitting at an idle prompt.
 *
 * Why this lives in the daemon rather than in a caller: the switch is a
 * close-then-respawn pair, and everything that makes the respawn correct
 * (registry row lookup, resume substitution, original-cwd resolution, capture
 * wiring, kill-switch, telemetry) is already owned here by
 * `single-spawn-surface-is-the-daemon`. A caller doing it itself would be
 * constructing the very tmux argv that rule forbids, and would have to
 * re-derive the family and resumability checks the planner makes structural.
 *
 * The continuation prompt is not a nicety. A resumed CLI restores its
 * transcript and then waits: without an instruction the lane holds its entire
 * context and does nothing, which reads to an operator as work that was lost.
 * It travels WITH the spawn for the same reason a lane's opening brief does —
 * a message sent afterwards races the CLI's startup and is read by nothing.
 */

/**
 * The continuation instruction now lives on the SINGLE SPAWN SURFACE
 * (option-spawn), not here. It was defined in this file, so only a model switch
 * handed it to its lanes — `/rpc/spawn` with a resume id and the restore path
 * both brought lanes back holding their full context and silent, which reads as
 * work that was lost. Telling a resumed lane to continue is a property of
 * RESUMING, not of switching models, so option-spawn applies it to every path.
 *
 * Re-exported because `switch-model`'s own contract still names it: a caller may
 * pass `prompt` to override, or `null` to suppress.
 */

import { detectTabBusy } from "@teamscala/pane-inventory/busy-detect";
import { cliKindForGroup } from "./cli-kind.ts";
import { DEFAULT_CONTINUATION_PROMPT } from "./continuation-prompt.ts";
import { spawnOptionInSession } from "./option-spawn.ts";
import { loadSessionState } from "./load-save.ts";
import { queryActiveOptions } from "./query-options.ts";
import { closeWindowForPane } from "./rename-close.ts";
import { normaliseTabs } from "./state-tabs.ts";
import { planModelSwitch, type SwitchModelSkip } from "./switch-model-plan.ts";

export { DEFAULT_CONTINUATION_PROMPT };

export interface SwitchModelRequest {
	tmuxSession: string;
	targetSlug: string;
	fromSlugs?: readonly string[];
	windowNames?: readonly string[];
	/** Continuation instruction; `null` sends none. Defaults to the standard one. */
	prompt?: string | null;
	/** Plan only — report what would move and why, touch nothing. */
	dryRun?: boolean;
	/** Move a lane that is mid-turn. Off by default: its in-flight work is lost. */
	force?: boolean;
	/** WHO asked, recorded on each spawn event. */
	requestedBy?: string;
}

export interface SwitchModelOutcome {
	windowName: string;
	fromSlug?: string;
	ok: boolean;
	paneId?: string;
	warnings?: string[];
	error?: string;
}

export interface SwitchModelResult {
	ok: boolean;
	dryRun: boolean;
	targetSlug: string;
	switched: SwitchModelOutcome[];
	planned: Array<{ windowName: string; fromSlug?: string; resumeId: string }>;
	skipped: SwitchModelSkip[];
	error?: string;
}

export async function switchModel(req: SwitchModelRequest): Promise<SwitchModelResult> {
	const base = { dryRun: req.dryRun === true, targetSlug: req.targetSlug };
	const options = await queryActiveOptions();
	const target = options.find((o) => o.slug === req.targetSlug);
	if (!target) {
		return {
			...base,
			ok: false,
			switched: [],
			planned: [],
			skipped: [],
			error: `no active session_picker_option with slug "${req.targetSlug}" (available: ${options.map((o) => o.slug).join(", ")})`,
		};
	}

	const familyBySlug: Record<string, string | undefined> = {};
	for (const o of options) familyBySlug[o.slug] = o.family?.key;

	const state = await loadSessionState(req.tmuxSession);
	const plan = planModelSwitch({
		tabs: normaliseTabs(state.tabs),
		targetSlug: req.targetSlug,
		familyBySlug,
		fromSlugs: req.fromSlugs,
		windowNames: req.windowNames,
	});

	// A busy lane loses its in-flight turn when its window dies, so the check is
	// part of planning rather than a warning after the fact. Only reachable moves
	// are probed — one ~7ms capture each, and never for a dry run's report.
	const moves: typeof plan.moves = [];
	const skipped = [...plan.skipped];
	for (const move of plan.moves) {
		if (req.force) {
			moves.push(move);
			continue;
		}
		const kind = cliKindForGroup(familyBySlug[move.tab.optionSlug ?? ""]);
		const busy = move.tab.paneId ? await detectTabBusy(move.tab.paneId, kind) : null;
		if (busy?.busy) {
			skipped.push({
				windowName: move.windowName,
				optionSlug: move.tab.optionSlug,
				reason: "busy",
				detail: `lane is mid-turn (${busy.activity ?? "working"}) — switching now discards its in-flight work; pass force to override`,
			});
			continue;
		}
		moves.push(move);
	}

	const planned = moves.map((m) => ({
		windowName: m.windowName,
		fromSlug: m.tab.optionSlug,
		resumeId: m.resumeId,
	}));
	if (base.dryRun) {
		return { ...base, ok: true, switched: [], planned, skipped };
	}

	const prompt = req.prompt === null ? undefined : (req.prompt ?? DEFAULT_CONTINUATION_PROMPT);
	const switched: SwitchModelOutcome[] = [];

	// Sequential by construction. Each iteration closes a window and spawns a
	// replacement that blocks until its CLI's prompt accepts the continuation
	// instruction; running these concurrently would race the reconcile pass that
	// archives each closed tab, and the tab archive is where the resume id lives.
	for (const move of moves) {
		const paneId = move.tab.paneId;
		if (!paneId) continue;
		const closed = await closeWindowForPane(paneId);
		if (!closed.ok) {
			switched.push({
				windowName: move.windowName,
				fromSlug: move.tab.optionSlug,
				ok: false,
				error: `could not close the existing window: ${closed.error ?? "unknown"}`,
			});
			continue;
		}
		try {
			const spawned = await spawnOptionInSession(req.targetSlug, req.tmuxSession, {
				focus: false,
				resumeId: move.resumeId,
				windowName: move.windowName,
				cwd: move.tab.cwd,
				initialPrompt: prompt,
				requestedBy: req.requestedBy ?? "switch-model",
			});
			switched.push({
				windowName: move.windowName,
				fromSlug: move.tab.optionSlug,
				ok: spawned.ok !== false,
				paneId: spawned.paneId,
				warnings: spawned.warnings,
			});
		} catch (err) {
			// The old window is already gone, so a failed respawn is reported per
			// lane and the remaining lanes still move — the alternative strands the
			// rest of the session on one bad row.
			switched.push({
				windowName: move.windowName,
				fromSlug: move.tab.optionSlug,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		...base,
		ok: switched.every((s) => s.ok),
		switched,
		planned,
		skipped,
	};
}
