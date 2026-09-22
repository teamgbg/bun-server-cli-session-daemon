/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure planner for `switch-model`: decides which of a session's live tabs may
 * move to a different `session_picker_option` (a different model) carrying
 * their conversation, and why each remaining tab may not. Split from the
 * executor so the selection rules — the part that silently loses an operator's
 * context when wrong — are unit-testable without tmux, the registry, or a
 * running daemon.
 *
 * Two rules are structural rather than advisory, because both failure modes are
 * silent. A tab with no captured `sessionId` cannot be resumed at all, so
 * respawning it would open a FRESH lane wearing the old tab's name; and a
 * transcript id only replays into the CLI that wrote it, so a cross-family move
 * (Claude id into Codex) resolves to no conversation and looks like a lane that
 * simply forgot its work. Both are refused here instead of being reported after
 * the original window is already dead.
 */

/** The subset of a stored session-state tab the planner needs. */
export interface SwitchModelTab {
	windowName: string;
	paneId?: string;
	windowId?: string;
	sessionId?: string | null;
	optionSlug?: string;
	cwd?: string;
}

/** One tab cleared to move, paired with the id that carries its conversation. */
export interface SwitchModelMove {
	tab: SwitchModelTab;
	resumeId: string;
	windowName: string;
}

export type SwitchModelSkipReason =
	| "already-on-target"
	| "no-session-id"
	| "cross-cli-family"
	| "no-pane"
	/** Mid-turn: the executor probes liveness, so the planner never emits this. */
	| "busy";

/** A tab that matched the selection but cannot move, with the reason why. */
export interface SwitchModelSkip {
	windowName: string;
	optionSlug?: string;
	reason: SwitchModelSkipReason;
	detail: string;
}

export interface SwitchModelPlanInput {
	tabs: readonly SwitchModelTab[];
	/** The `session_picker_option` slug every selected tab moves to. */
	targetSlug: string;
	/** The cli_id-derived family key per option slug — the CLI family a slug belongs to. */
	familyBySlug: Readonly<Record<string, string | undefined>>;
	/**
	 * Option slugs to move. Omitted means every tab in the target's own CLI
	 * family, which is the "move all my GLM lanes to Opus" shape.
	 */
	fromSlugs?: readonly string[];
	/** Optional explicit tab filter, by window name. */
	windowNames?: readonly string[];
}

export interface SwitchModelPlan {
	moves: SwitchModelMove[];
	skipped: SwitchModelSkip[];
}

/**
 * A tab is a candidate when the caller asked for its slug (or, with no
 * `fromSlugs`, when it belongs to the target's CLI family) and its window name
 * passes the optional name filter. Non-candidates are dropped silently — only
 * a tab the caller MEANT to move earns a skip entry, so the report is a list of
 * problems rather than an inventory of the session.
 */
function isCandidate(
	tab: SwitchModelTab,
	input: SwitchModelPlanInput,
	targetGroup: string | undefined,
): boolean {
	if (input.windowNames && !input.windowNames.includes(tab.windowName)) return false;
	if (!tab.optionSlug) return false;
	if (input.fromSlugs) return input.fromSlugs.includes(tab.optionSlug);
	// No explicit --from: the target's family is the selection. Without a known
	// target group nothing is implied, because "every tab" would sweep up the
	// btop and bash tabs the operator never meant to touch.
	if (!targetGroup) return false;
	return input.familyBySlug[tab.optionSlug] === targetGroup;
}

export function planModelSwitch(input: SwitchModelPlanInput): SwitchModelPlan {
	const targetGroup = input.familyBySlug[input.targetSlug];
	const moves: SwitchModelMove[] = [];
	const skipped: SwitchModelSkip[] = [];

	for (const tab of input.tabs) {
		if (!isCandidate(tab, input, targetGroup)) continue;

		if (tab.optionSlug === input.targetSlug) {
			skipped.push({
				windowName: tab.windowName,
				optionSlug: tab.optionSlug,
				reason: "already-on-target",
				detail: `already running "${input.targetSlug}"`,
			});
			continue;
		}

		const sourceGroup = tab.optionSlug ? input.familyBySlug[tab.optionSlug] : undefined;
		if (!targetGroup || !sourceGroup || sourceGroup !== targetGroup) {
			skipped.push({
				windowName: tab.windowName,
				optionSlug: tab.optionSlug,
				reason: "cross-cli-family",
				detail: `"${tab.optionSlug}" (${sourceGroup ?? "no family"}) cannot resume into "${input.targetSlug}" (${targetGroup ?? "no family"}) — a transcript id only replays into the CLI that wrote it`,
			});
			continue;
		}

		if (!tab.sessionId) {
			skipped.push({
				windowName: tab.windowName,
				optionSlug: tab.optionSlug,
				reason: "no-session-id",
				detail: "no captured session id — switching would open a fresh lane, not resume this one",
			});
			continue;
		}

		if (!tab.paneId) {
			skipped.push({
				windowName: tab.windowName,
				optionSlug: tab.optionSlug,
				reason: "no-pane",
				detail: "no live pane id — nothing to close, so the old lane would survive the switch",
			});
			continue;
		}

		moves.push({ tab, resumeId: tab.sessionId, windowName: tab.windowName });
	}

	return { moves, skipped };
}
