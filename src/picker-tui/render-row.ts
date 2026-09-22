/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Row rendering primitives: renderRow per-kind line, ANSI-aware padding, bordered box, and two-column join.
 */

import {
	AMBER_BRIGHT,
	BLUE,
	BOLD,
	DIM,
	DIM_STYLE,
	FG,
	GREEN,
	ITALIC,
	RESET,
	visibleLen,
} from "./style.ts";
import { formatClients, relativeAgo } from "./format-helpers.ts";
import type { Row } from "./row-build.ts";

export function renderRow(row: Row, selected: boolean, L: import("./types.ts").PickerLabels): string {
	if (row.kind === "header") {
		return `  ${DIM}${ITALIC}${row.label}${RESET}`;
	}
	const prefix = selected ? `${AMBER_BRIGHT}▸ ${RESET}` : `  `;
	const boldOn = selected ? BOLD : "";
	if (row.kind === "session") {
		const windows = `${row.info.windows} window${row.info.windows === 1 ? "" : "s"}`;
		const devices = formatClients(row.info.clients);
		const tag = row.info.attached
			? `  ${BLUE}● attached${RESET}${devices ? `${DIM} ${devices}${RESET}` : ""}`
			: `  ${DIM_STYLE}${DIM}○ detached${RESET}`;
		const name = `${FG}${boldOn}${row.info.name.padEnd(18)}${RESET}`;
		return `${prefix}${name}  ${DIM}${windows.padEnd(11)}${RESET}${tag}`;
	}
	if (row.kind === "archived") {
		const windows = `${row.info.tabCount} tab${row.info.tabCount === 1 ? "" : "s"}`;
		const ago = relativeAgo(row.info.updatedAt);
		const marker = (L.archived_marker || "archived {ago}").replace("{ago}", ago);
		const tag = `  ${DIM_STYLE}${DIM}○ ${marker}${RESET}`;
		const nameStyled = selected
			? `${FG}${boldOn}${row.info.name.padEnd(18)}${RESET}`
			: `${DIM}${row.info.name.padEnd(18)}${RESET}`;
		return `${prefix}${nameStyled}  ${DIM}${windows.padEnd(11)}${RESET}${tag}`;
	}
	if (row.kind === "hidden") {
		const windows = `${row.info.tabCount} tab${row.info.tabCount === 1 ? "" : "s"}`;
		const ago = relativeAgo(row.info.updatedAt);
		const marker = (L.hidden_marker || "hidden {ago}").replace("{ago}", ago);
		const tag = `  ${DIM_STYLE}${DIM}✕ ${marker}${RESET}`;
		const nameStyled = selected
			? `${FG}${boldOn}${row.info.name.padEnd(18)}${RESET}`
			: `${DIM}${row.info.name.padEnd(18)}${RESET}`;
		return `${prefix}${nameStyled}  ${DIM}${windows.padEnd(11)}${RESET}${tag}`;
	}
	if (row.kind === "new") {
		const icon = selected ? `${AMBER_BRIGHT}${BOLD}+${RESET}` : `${AMBER_BRIGHT}+${RESET}`;
		const label = selected ? `${GREEN}${BOLD}${row.label}${RESET}` : `${GREEN}${row.label}${RESET}`;
		const hint = row.hint.trim() ? `   ${DIM}${ITALIC}${row.hint}${RESET}` : "";
		return `${prefix}${icon} ${label}${hint}`;
	}
	if (row.kind === "refresh") {
		const label = selected ? `${FG}${BOLD}${row.label}${RESET}` : `${FG}${row.label}${RESET}`;
		return `${prefix}  ${label}`;
	}
	const label = selected ? `${FG}${BOLD}${row.label}${RESET}` : `${FG}${row.label}${RESET}`;
	return `${prefix}  ${label}`;
}

function padRightAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLen(text)))}`;
}

export function renderBox(title: string, content: string[], width: number): string[] {
	const boxWidth = Math.max(12, width);
	const inner = boxWidth - 4;
	const titleText = ` ${title} `;
	const titleWidth = Math.min(inner, titleText.length);
	const leftRule = Math.max(0, Math.floor((boxWidth - 2 - titleWidth) / 2));
	const rightRule = Math.max(0, boxWidth - 2 - titleWidth - leftRule);
	const label = titleWidth < titleText.length ? titleText.slice(0, titleWidth) : titleText;
	const top =
		`${AMBER_BRIGHT}╭${"─".repeat(leftRule)}${RESET}` +
		`${BOLD}${FG}${label}${RESET}` +
		`${AMBER_BRIGHT}${"─".repeat(rightRule)}╮${RESET}`;
	const rows = content.map(
		(line) => `${AMBER_BRIGHT}│${RESET} ${padRightAnsi(line, inner)} ${AMBER_BRIGHT}│${RESET}`,
	);
	const bottom = `${AMBER_BRIGHT}╰${"─".repeat(boxWidth - 2)}╯${RESET}`;
	return [top, ...rows, bottom];
}

export function joinColumns(left: string[], right: string[], cols: number): string {
	const gap = "   ";
	const leftWidth = Math.max(20, Math.floor((cols - gap.length) / 2));
	const rightWidth = Math.max(20, cols - gap.length - leftWidth);
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i += 1) {
		const leftLine = left[i] ?? "";
		const rightLine = right[i] ?? "";
		out.push(`${padRightAnsi(leftLine, leftWidth)}${gap}${padRightAnsi(rightLine, rightWidth)}`);
	}
	return out.join("\n");
}
