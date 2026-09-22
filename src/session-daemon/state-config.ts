/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure config-shaping helpers extracted from state-file so their regression
 * tests bind no tmux/DB/NotifyCache module state and run order-independently
 * in the shared bun process.
 */

import { normaliseTabs } from "./state-tabs.ts";
import type { SessionStateConfig } from "@teamscala/db-validation/registry-schemas/session-state";

const CLOSED_TABS_CAP = 40;

/**
 * Merge a caller's state with the durable fields a PARTIAL caller omitted:
 * an omitted `closedTabs`/`archived` inherits the prior row's value, an
 * explicitly-passed field (including `[]`, which restore uses to drop a
 * reopened entry) still overrides. This is what makes
 * `every-session-is-restorable` real — the session id is durable from birth
 * only if the archive holding it is.
 */
export function buildSessionStateConfig(
	state: SessionStateConfig,
	inherited: Pick<SessionStateConfig, "closedTabs" | "archived"> | null,
): SessionStateConfig {
	const closedTabs = state.closedTabs ?? inherited?.closedTabs;
	const archived = state.archived ?? inherited?.archived;
	const normalisedState: SessionStateConfig = { tabs: normaliseTabs(state.tabs) };
	if (closedTabs && closedTabs.length > 0) {
		normalisedState.closedTabs = closedTabs.slice(-CLOSED_TABS_CAP);
	}
	if (archived) {
		normalisedState.archived = true;
	}
	return normalisedState;
}

/**
 * Replace a stored command with the option's secret-free template when the two
 * no longer match. Stored literals must never survive as `secret_env`
 * (`export SECRET='literal';`), so an archived command healed to it
 * RETAINS THE PLACEHOLDER and never the resolved key
 * (credentials-only-in-secret-rows). Returns the command UNCHANGED when the
 * option is gone (no template to verify against — see scrubStoredCommandSecrets)
 * or it already equals the template (idempotent).
 */
export function redactCommandToTemplate(
	cmd: string | undefined,
	optionSlug: string,
	templateBySlug: Map<string, string>,
): string | undefined {
	if (cmd === undefined) return cmd;
	const template = templateBySlug.get(optionSlug);
	if (template === undefined || cmd === template) return cmd;
	return template;
}
