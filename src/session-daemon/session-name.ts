/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure predicate: is a string a safe tmux session name? tmux forbids `.` and
 * `:` (target syntax) and we additionally forbid whitespace + uppercase so the
 * derived `session-state-<name>` registry slug (kebab-case, naming-conventions)
 * and the reconcile hook's `?session=` URL param stay clean. Used by
 * renameTmuxSession before any tmux / DB mutation.
 */
const TMUX_SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTmuxSessionName(name: string): boolean {
	return TMUX_SESSION_NAME_RE.test(name);
}
