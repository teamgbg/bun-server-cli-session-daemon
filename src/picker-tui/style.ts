/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Shared visual primitives — ANSI escapes, the warm amber palette, and layout
 * helpers (terminal width, centering, horizontal rule). Used by every screen
 * so the look stays consistent.
 *
 * Marked: every export is part of one canonical surface —
 * the TUI's visual vocabulary. Splitting into ansi/palette/helpers files
 * forces every screen renderer to import from 3+ paths and obscures the
 * vocabulary's cohesion (the colours reference SUPPORTS_MOUSE; the helpers
 * reference RESET/FAINT; the banner references the palette). The 20 export
 * "groups" the shared-token detector flags is a name-overlap artifact —
 * short identifiers like CLEAR, RESET, RED, FG don't share tokens but ARE
 * one screen-vocabulary by purpose.
 */

import { fg, SUPPORTS_MOUSE } from "./terminal-caps.ts";

const ESC = "\x1b";

// Terminal control
export const ALT_ON = `${ESC}[?1049h`;
export const ALT_OFF = `${ESC}[?1049l`;
export const CURSOR_HIDE = `${ESC}[?25l`;
export const CURSOR_SHOW = `${ESC}[?25h`;
export const CLEAR = `${ESC}[2J${ESC}[H`;
// xterm SGR 1006 mouse reporting — only on terms that advertise 256-color or
// richer (proxy for "desktop with a real pointer"). Touch-screen mobile SSH
// clients reporting TERM=xterm get empty strings here; their touches don't
// generate mouse events that flood the keyboard read loop.
export const MOUSE_ON = SUPPORTS_MOUSE ? `${ESC}[?1000h${ESC}[?1006h` : "";
export const MOUSE_OFF = SUPPORTS_MOUSE ? `${ESC}[?1000l${ESC}[?1006l` : "";

// Styles
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM_STYLE = `${ESC}[2m`;
export const ITALIC = `${ESC}[3m`;

// Palette — warm amber three-shade + neutrals + accents. Resolved via fg()
// so 24-bit emitters fall back to nearest 256-color on TERM=xterm, and to
// monochrome on truly limited terminals.
export const AMBER = fg(216, 167, 90);
export const AMBER_BRIGHT = fg(240, 195, 120);
export const AMBER_DIM = fg(156, 120, 70);
export const FG = fg(230, 225, 215);
export const DIM = fg(170, 165, 155);
export const FAINT = fg(135, 130, 122);
export const RED = fg(220, 130, 130);
export const GREEN = fg(120, 190, 130);
export const BLUE = fg(140, 175, 220);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function visibleLen(s: string): number {
	return s.replace(ANSI, "").length;
}

/** Truncate to a visible width, preserving ANSI escapes (which don't count) and
 * closing with RESET so styling never leaks — keeps rows inside a narrow box
 * border instead of overflowing it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape match
const ESC_AT_START = /^\x1b\[[0-9;?]*[A-Za-z]/;
export function clipAnsi(s: string, width: number): string {
	if (width <= 0 || visibleLen(s) <= width) return s;
	let out = "";
	let vis = 0;
	for (let i = 0; i < s.length; ) {
		if (s[i] === "\x1b") {
			const m = s.slice(i).match(ESC_AT_START);
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		if (vis >= width - 1) break;
		out += s[i];
		vis += 1;
		i += 1;
	}
	return `${out}…${RESET}`;
}

export function termCols(): number {
	const w = process.stdout.columns;
	if (typeof w === "number" && w > 0) return w;
	return 80;
}

/** Center `s` horizontally within `cols`. Pass an explicit visible width when
 * the string contains ANSI or multi-byte content that `visibleLen` can't tell. */
export function center(s: string, cols: number, widthOverride?: number): string {
	const w = widthOverride ?? visibleLen(s);
	const pad = Math.max(0, Math.floor((cols - w) / 2));
	return `${" ".repeat(pad)}${s}`;
}

/** Thin horizontal rule spanning the full width. */
export function rule(cols: number): string {
	return `${FAINT}${"─".repeat(Math.max(20, cols - 2))}${RESET}`;
}

// The big SCALA DEV banner — shared hero across screens that have room.
const BANNER_LINES: readonly string[] = [
	"███████╗ ██████╗ █████╗ ██╗      █████╗   ██████╗ ███████╗██╗   ██╗",
	"██╔════╝██╔════╝██╔══██╗██║     ██╔══██╗  ██╔══██╗██╔════╝██║   ██║",
	"███████╗██║     ███████║██║     ███████║  ██║  ██║█████╗  ██║   ██║",
	"╚════██║██║     ██╔══██║██║     ██╔══██║  ██║  ██║██╔══╝  ╚██╗ ██╔╝",
	"███████║╚██████╗██║  ██║███████╗██║  ██║  ██████╔╝███████╗ ╚████╔╝ ",
	"╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ╚═════╝ ╚══════╝  ╚═══╝  ",
];
const BANNER_WIDTH = BANNER_LINES[0]?.length ?? 67;
const BANNER_PALETTE = [AMBER_BRIGHT, AMBER_BRIGHT, AMBER, AMBER, AMBER_DIM, AMBER_DIM];

// Phone-sized 3-row block banner. Width 28 cols — fits every Termius /
// mobile-SSH window we care about while still feeling substantial. Used
// whenever the full desktop banner doesn't fit.
const BANNER_MEDIUM_LINES: readonly string[] = [
	"█▀ █▀ ▄▀█ █ ▄▀█ ▄ █▀▄ █▀ █ █",
	"▀▄ █  █▀█ █ █▀█ ▀ █ █ █▀ █▀█",
	"▀▀ ▀▀ ▀ ▀ ▀▀ ▀ ▀   ▀▀  ▀▀ ▀ ▀",
];
const BANNER_MEDIUM_WIDTH = BANNER_MEDIUM_LINES[0]?.length ?? 28;
const BANNER_MEDIUM_PALETTE = [AMBER_BRIGHT, AMBER, AMBER_DIM];

/** Big centered SCALA DEV banner. Two tiers: full ASCII banner for desktop,
 * a compact 3-row block banner for every narrower terminal. */
export function renderHero(_tagline: string, cols: number): string {
	if (cols >= BANNER_WIDTH + 4) {
		const lines = BANNER_LINES.map((l, i) =>
			center(`${BANNER_PALETTE[i]}${l}${RESET}`, cols, BANNER_WIDTH),
		);
		return `${lines.join("\n")}\n${rule(cols)}\n`;
	}
	const lines = BANNER_MEDIUM_LINES.map((l, i) =>
		center(`${BANNER_MEDIUM_PALETTE[i]}${l}${RESET}`, cols, BANNER_MEDIUM_WIDTH),
	);
	return `${lines.join("\n")}\n${rule(cols)}\n`;
}

/** Left-aligned bold section heading with a thin underline — proper heading weight. */
export function sectionHeading(label: string, _cols?: number): string {
	const underline = `${FAINT}${"─".repeat(label.length)}${RESET}`;
	void _cols;
	return `\n${BOLD}${AMBER_BRIGHT}${label}${RESET}\n${underline}\n\n`;
}

/** Centered screen title above a short body (used for confirm / running / error / ops_result). */
export function screenTitle(label: string, cols: number, color = AMBER_BRIGHT): string {
	const t = `${color}${BOLD}${label}${RESET}`;
	return `${center(t, cols, label.length)}\n`;
}
