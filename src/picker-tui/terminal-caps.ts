/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Terminal capability detection from TERM / COLORTERM, evaluated once at
 * module load. Drives whether style.ts emits 24-bit truecolor escapes vs
 * 256-color fallback, and whether tui.ts enables xterm SGR mouse tracking.
 *
 * Reason: Termius mobile (and other touch-screen SSH clients) send TERM=xterm
 * with no COLORTERM. They don't render `\e[38;2;R;G;Bm` correctly, and SGR
 * mouse tracking floods the input queue with synthetic click events from
 * every touch — the picker's read loop expects keystrokes and gets buried,
 * which presents as the renderer hanging or the client crashing.
 */

/**
 * Pure terminal-capability detection from TERM / COLORTERM. Extracted so the
 * per-terminal behaviour is unit-testable (module-level constants below evaluate
 * once at load and can't be varied in-process).
 *
 * Bare "xterm" (no -256color suffix) is the signature of mobile/touch SSH
 * clients — notably Termius — that advertise TERM=xterm. They render 256-color
 * reliably but NOT 24-bit truecolor, and do NOT set COLORTERM themselves. A
 * forced COLORTERM=truecolor (e.g. from a dotfile) must NOT trick us into
 * emitting 24-bit escapes they display as garbage (the "washed-out / errors
 * behind the picker" symptom). So bare xterm caps at 256-color regardless of
 * COLORTERM; only an explicit 256/truecolor/direct TERM, or a self-set
 * COLORTERM on a non-bare-xterm TERM, unlocks truecolor.
 */

const TERM = process.env.TERM ?? "";
const COLORTERM = process.env.COLORTERM ?? "";

export interface TerminalCaps {
	supportsTruecolor: boolean;
	supports256: boolean;
	supportsMouse: boolean;
}

export function detectCaps(term: string, colorterm: string): TerminalCaps {
	const bareXterm = term === "xterm";
	const supportsTruecolor =
		!bareXterm &&
		(colorterm === "truecolor" ||
			colorterm === "24bit" ||
			term.includes("direct") ||
			term.includes("truecolor"));
	const supports256 =
		supportsTruecolor ||
		term.includes("256") ||
		term === "screen-256color" ||
		term === "tmux-256color" ||
		bareXterm;
	// SGR mouse tracking floods touch-screen terminals with synthetic click
	// events that drown the keyboard read loop. 256-color advertisement is a
	// reasonable proxy for "desktop terminal emulator with a real pointer."
	return { supportsTruecolor, supports256, supportsMouse: supports256 };
}

const _caps = detectCaps(TERM, COLORTERM);
export const SUPPORTS_TRUECOLOR: boolean = _caps.supportsTruecolor;
export const SUPPORTS_256: boolean = _caps.supports256;
// SGR mouse tracking floods touch-screen terminals with synthetic click
// events that drown the keyboard read loop. 256-color advertisement is a
// reasonable proxy for "desktop terminal emulator with a real pointer."
export const SUPPORTS_MOUSE: boolean = _caps.supportsMouse;

function rgbTo256(r: number, g: number, b: number): number {
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && Math.abs(r - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	const q = (c: number): number => Math.round((c / 255) * 5);
	return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const ESC = "\x1b";

/** SGR foreground for an 8-bit RGB triple — 24-bit when supported, nearest
 * 256-color otherwise, empty string on terms without even 256-color (the
 * picker stays readable as monochrome on TERM=dumb). */
export function fg(r: number, g: number, b: number): string {
	if (SUPPORTS_TRUECOLOR) return `${ESC}[38;2;${r};${g};${b}m`;
	if (SUPPORTS_256) return `${ESC}[38;5;${rgbTo256(r, g, b)}m`;
	return "";
}
