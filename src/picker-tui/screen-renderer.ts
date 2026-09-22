/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Atomic alternate-screen renderer for the picker TUIs. It diffs complete
 * terminal rows and paints one synchronized frame, avoiding clear-and-redraw
 * flashes while ensuring rows removed by a resize or state change are erased.
 */

const ESC = "\x1b";
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const ERASE_LINE = `${ESC}[2K`;

export interface ScreenRenderer {
	paint(lines: readonly string[], forceFull?: boolean): string;
	reset(): void;
}

/**
 * Keep the terminal's previous frame in memory and emit only changed rows.
 * The terminal receives one synchronized-output frame, so it never exposes
 * the intermediate blank/partial state that clear-and-redraw creates.
 */
export function createScreenRenderer(): ScreenRenderer {
	let previous: string[] | null = null;

	return {
		paint(lines, forceFull = false): string {
			const next = [...lines];
			const full = forceFull || previous === null;
			const out: string[] = [SYNC_ON, CURSOR_HIDE];

			if (full) out.push(CLEAR_SCREEN, HOME);
			const limit = Math.max(previous?.length ?? 0, next.length);
			for (let i = 0; i < limit; i += 1) {
				const oldLine = previous?.[i] ?? "";
				const newLine = next[i] ?? "";
				if (!full && oldLine === newLine) continue;
				out.push(`${ESC}[${i + 1};1H`, ERASE_LINE, newLine);
			}

			// Leave the cursor at a stable location without adding a visible
			// newline that could scroll the alternate screen.
			out.push(`${ESC}[1;1H`, SYNC_OFF);
			previous = next;
			return out.join("");
		},

		reset(): void {
			previous = null;
		},
	};
}
