/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Run an `ops` picker option — a shell action, not a lane.
 *
 * An ops option (`pm2 status`, `picker reload`) produces OUTPUT for the operator
 * rather than a tmux window with a CLI in it, so it shares nothing with lane
 * spawning but the `SpawnResult` shape it reports through. Extracted from
 * `spawn-core.ts` to keep that file within its line budget, and because a shell
 * runner sitting inside the lane-spawn module invited the two to be read as one
 * mechanism (`single-canonical-unit`).
 */

import { spawnSync } from "@teamscala/os/spawn/spawn";
import type { MenuOption } from "../picker-tui/types.ts";
import type { SpawnResult } from "./spawn-result.ts";

const TMUX_COMMAND_WITH_DANGEROUS_DEFAULT_TARGET =
	/\btmux\s+(?:respawn-window|kill-window|respawn-pane|kill-pane|rename-window|swap-window|move-window)\b/;

/**
 * Refuse tmux mutations whose omitted target means "whatever window is active".
 *
 * The picker reload row once ran `tmux respawn-window -k ...` from the daemon.
 * tmux therefore replaced the operator's selected work tab instead of the
 * picker. Declarative ops rows are still data, but this invariant belongs at
 * the executor wall so a future malformed row cannot recreate the incident.
 */
export function assertSafeOpsCommand(command: string): void {
	if (
		TMUX_COMMAND_WITH_DANGEROUS_DEFAULT_TARGET.test(command) &&
		!/(?:^|\s)-t(?:\s|=)/.test(command)
	) {
		throw new Error(
			"spawn: tmux window/pane mutation requires an explicit -t target; refusing to act on the active window",
		);
	}
}

export function spawnOps(option: MenuOption): SpawnResult {
	const command = option.config.command;
	if (!command) throw new Error(`spawn: ops option "${option.slug}" has no command`);
	assertSafeOpsCommand(command);
	const r = spawnSync({ name: "bash:spawn-ops", command: ["bash", "-lc", command], timeoutMs: 30_000 });
	const stdout = r.stdout.toString();
	const stderr = r.stderr.toString();
	const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
	return { ok: (r.exitCode ?? 1) === 0, slug: option.slug, output, exitCode: r.exitCode ?? 1 };
}
