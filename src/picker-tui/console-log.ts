/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Persistent console event buffer + push helpers + the box renderer that draws it under every menu screen.
 */
import {
	ALT_OFF,
	ALT_ON,
	AMBER_BRIGHT,
	BOLD,
	CURSOR_HIDE,
	CURSOR_SHOW,
	center,
	clipAnsi,
	DIM,
	FAINT,
	FG,
	GREEN,
	ITALIC,
	MOUSE_OFF,
	MOUSE_ON,
	RED,
	RESET,
	renderHero,
	rule,
	screenTitle,
	termCols,
	visibleLen,
} from "./style.ts";

export interface ConsoleEvent {
	ts: string;
	level: "info" | "success" | "error";
	text: string;
}

const CONSOLE_BUFFER_SIZE = 8;
const consoleEvents: ConsoleEvent[] = [];

function nowLocal(): string {
	return new Date().toLocaleTimeString("en-AU", { hour12: false });
}

export function pushConsoleEvent(level: ConsoleEvent["level"], text: string): void {
	consoleEvents.push({ ts: nowLocal(), level, text });
	while (consoleEvents.length > CONSOLE_BUFFER_SIZE) consoleEvents.shift();
}

function padRightAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLen(text)))}`;
}

export function renderConsoleBox(cols: number): string[] {
	if (consoleEvents.length === 0) return [];
	const out: string[] = [];
	const boxWidth = Math.max(60, cols - 4);
	const inner = boxWidth - 4;
	const top = `${FAINT}╭─ Console ${"─".repeat(Math.max(0, boxWidth - 14))}╮${RESET}`;
	const bottom = `${FAINT}╰${"─".repeat(boxWidth - 2)}╯${RESET}`;
	out.push(top);
	for (const ev of consoleEvents) {
		const color = ev.level === "error" ? RED : ev.level === "success" ? GREEN : FAINT;
		let body = `${color}[${ev.ts}] ${ev.text}${RESET}`;
		const visiblePrefix = `[${ev.ts}] ${ev.text}`;
		if (visiblePrefix.length > inner) {
			body = `${color}[${ev.ts}] ${ev.text.slice(0, inner - 3 - ev.ts.length - 3)}…${RESET}`;
		}
		const padded = padRightAnsi(body, boxWidth - 4);
		out.push(`${FAINT}│${RESET} ${padded} ${FAINT}│${RESET}`);
	}
	out.push(bottom);
	return out;
}

// Push a multi-line ops output into the Console panel — first non-empty line
// gets the status indicator + label; subsequent non-empty lines (up to 3) get
// faint info entries so the operator can see useful debug context inline
// without leaving the menu.
export function pushOpsOutput(label: string, exitCode: number, output: string): void {
	const ok = exitCode === 0;
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const headline = lines[0] ?? "(no output)";
	pushConsoleEvent(
		ok ? "success" : "error",
		`${ok ? "✓" : "✗"} ${label}: exit ${exitCode} — ${headline.slice(0, 100)}`,
	);
	for (const line of lines.slice(1, 4)) {
		pushConsoleEvent("info", `  ${line.slice(0, 120)}`);
	}
}

// Push a dispatch error to the Console — captured pane output from a dead
// tmux child contains embedded newlines and tmux's own "Pane is dead (status
// …)" overlay text. Pushing the whole multi-line blob as one console event
// shatters the Console box rendering. Split into headline + up to 3 detail
// lines, same shape as pushOpsOutput so the panel is the single source of
// dispatch feedback.
export function pushDispatchError(label: string, message: string): void {
	const lines = message
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const headline = lines[0] ?? "unknown error";
	pushConsoleEvent("error", `✗ ${label}: ${headline.slice(0, 120)}`);
	for (const line of lines.slice(1, 4)) {
		pushConsoleEvent("info", `  ${line.slice(0, 120)}`);
	}
}
