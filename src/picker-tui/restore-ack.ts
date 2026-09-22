/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure line content for the partial-restore ack screen — the operator-facing
 * half of the silent-partial restore guard (Task #53). A restore that reopens
 * SOME tabs and reports success is worse than one that fails, because the
 * operator sees a populated screen and assumes it is complete. So the ack screen
 * NAMES every failed and degraded tab before attach takes the terminal.
 *
 * Extracted from `session-select.ts` as a pure sibling so the NAMING itself is
 * unit-testable in isolation (no TUI/stdin/tmux graph to load): the disease is a
 * tab being silently omitted, so the test asserts each problem windowName
 * appears in the rendered lines. The side-effectful paint (clear screen + modal
 * key wait) stays in the picker closure; this module owns only the content.
 */

import { AMBER_BRIGHT, BOLD, clipAnsi, DIM, RED, RESET } from "./style.ts";

/** The subset of a restore outcome the ack screen renders. Structurally
 * compatible with picker-rpc's `RestoreResult` + the daemon's `RestoreOutcome`
 * (mapped at the RPC boundary), so neither type is imported here — keeping this
 * module free of the picker/daemon graphs. */
export interface RestoreAckProblem {
	kind: "failed" | "degraded";
	windowName: string;
	reason: string;
}

export interface RestoreAckInput {
	ok: boolean;
	restored: unknown[];
	failed: RestoreAckProblem[];
	degraded: RestoreAckProblem[];
	error?: string;
}

/**
 * Render the ack screen as a list of ANSI-styled lines, each clipped to `cols`.
 * Every failed and degraded windowName appears on its own line — the omission
 * guard. `name` is the session being attached to; `cols` is the terminal width
 * (passed in, not read from the tty, so the function is pure + testable).
 */
export function formatRestoreAckLines(
	outcome: RestoreAckInput,
	name: string,
	cols: number,
): string[] {
	const clip = (s: string): string => clipAnsi(s, Math.max(20, cols));
	const lines: string[] = [
		clip(`${AMBER_BRIGHT}${BOLD}⚠ Restore of '${name}' incomplete${RESET}`),
	];
	if (outcome.error) lines.push(clip(`${RED}${outcome.error}${RESET}`));
	if (outcome.failed.length > 0) {
		lines.push(clip(`${RED}failed — window did not come up (${outcome.failed.length}):${RESET}`));
		for (const p of outcome.failed) lines.push(clip(`  • ${p.windowName} — ${p.reason}`));
	}
	if (outcome.degraded.length > 0) {
		lines.push(
			clip(
				`${AMBER_BRIGHT}degraded — reopened, conversation lost (${outcome.degraded.length}):${RESET}`,
			),
		);
		for (const p of outcome.degraded) lines.push(clip(`  • ${p.windowName} — ${p.reason}`));
	}
	lines.push(clip(`${DIM}${outcome.restored.length} tab(s) restored fully${RESET}`));
	lines.push(clip(`${BOLD}Press any key to attach to '${name}'…${RESET}`));
	return lines;
}
