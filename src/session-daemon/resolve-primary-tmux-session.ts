/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Resolve the daemon's primary managed tmux session from live tmux sessions.
 */

import { run as tmuxRun } from "@teamscala/tmux-session/command-runner";

export function resolvePrimaryTmuxSession(): string | null {
	const result = tmuxRun(["list-sessions", "-F", "#{session_name}"]);
	if (result.exitCode !== 0) return null;
	const sessions = String(result.stdout ?? "").trim().split("\n").filter(Boolean);
	return sessions[0] ?? null;
}
