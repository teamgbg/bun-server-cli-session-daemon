/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Build the shell command that launches the picker-tui launcher entry under a
 * NAMED argv[0] (`scala-picker`) so /proc/<pid>/cmdline (what btop/htop
 * display) shows `scala-picker` instead of bare `bun`. Bun's `process.title`
 * does not set the OS name on posix (oven-sh/bun#14255), and the in-process
 * `prctl(PR_SET_MM_ARG_START)` remap is EPERM for unprivileged processes, so
 * argv[0] can only be set at execve time via `exec -a <name>` — a bash builtin,
 * hence the explicit `bash -c` (the tmux default-shell may be fish, which has
 * no `exec -a`). Doctrine gate: proxy-is-not-behaviour — the only admissible
 * evidence is /proc/cmdline showing a non-`bun` argv[0].
 */

/** shell-quote a single token for safe embedding in a bash -c string. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A bash command string that execs `bun <launcherEntry> <session>` with
 * argv[0] set to `scala-picker`. Pass as the tmux new-session/new-window
 * command (tmux runs it via its shell; the explicit `bash -c` is shell-agnostic).
 */
export function namedLauncherCommand(bunPath: string, launcherEntry: string, session: string): string {
	return `bash -c 'exec -a scala-picker ${shellQuote(bunPath)} ${shellQuote(launcherEntry)} ${shellQuote(session)}'`;
}
