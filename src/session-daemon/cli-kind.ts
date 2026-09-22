/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Translates a picker option's cli_id-derived family key (the cli_routing
 * slug, or the row's explicit menu_scope override) into the CliKind vocabulary
 * the busy detector classifies on. Single home for the mapping — the copies in
 * option-spawn, switch-model and close-tab drifted, misclassifying lanes.
 */

import type { CliKind } from "@teamscala/pane-inventory/agent-pane-detect";

const CLI_KIND_BY_FAMILY: Record<string, CliKind> = {
	claude: "claude-code",
	opencode: "opencode",
	pi: "pi",
	codex: "codex",
};

export function cliKindForGroup(family: string | undefined): CliKind {
	return (family && CLI_KIND_BY_FAMILY[family]) || "unknown";
}
