/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * render — the full two-column picker table (sessions left, options right) with hero/footer chrome and click-target registration.
 */

import {
	AMBER_BRIGHT,
	BOLD,
	center,
	clipAnsi,
	DIM,
	FG,
	ITALIC,
	RED,
	RESET,
	renderHero,
	rule,
	termCols,
} from "./style.ts";
import { renderBox, joinColumns, renderRow } from "./render-row.ts";
import { clickTargets, isSelectable, type Row } from "./row-build.ts";
import type { PickerConfig } from "./types.ts";

export function render(
	config: PickerConfig,
	rows: Row[],
	leftRowIndices: number[],
	rightRowIndices: number[],
	selectedIdx: number,
	emptyLeft: boolean,
	identity: string,
	footerHint: string,
	loadError: string | null,
): string {
	const cols = termCols();
	const L = config.labels;
	const gap = "   ";
	clickTargets.length = 0;

	// An unreachable daemon must NEVER read as "no sessions" — session state
	// lives in the DB regardless of daemon health, so an empty list is only
	// truthful when a load actually SUCCEEDED and returned zero rows.
	const leftLines = emptyLeft
		? loadError
			? [
					`${RED}${BOLD}⚠ Session daemon unreachable${RESET}`,
					`${FG}Your sessions are NOT lost — state is safe in the DB.${RESET}`,
					`${DIM}${ITALIC}${loadError}${RESET}`,
					`${DIM}Retrying automatically…${RESET}`,
				]
			: [`${DIM}${ITALIC}${L.empty_state}${RESET}`]
		: leftRowIndices.map((idx) => renderRow(rows[idx] as Row, idx === selectedIdx, L));
	const rightLines = rightRowIndices.map((idx) =>
		renderRow(rows[idx] as Row, idx === selectedIdx, L),
	);
	const heroLines = renderHero(config.title, cols).split("\n");
	const footer = [
		rule(cols),
		center(`${DIM}${ITALIC}${footerHint}${RESET}`, cols, footerHint.length),
		center(`${DIM}${identity}${RESET}`, cols, identity.length),
	];

	// Single column unless the terminal is genuinely wide. A session row is
	// ~45 visible cols, so two side-by-side boxes only fit cleanly past ~100
	// cols — below that (mobile included, which reports ~80) stack vertically
	// at full width. Two columns is a wide-desktop bonus, never the mobile path.
	if (cols < 100) {
		const boxWidth = Math.max(12, cols - 2);
		const inner = boxWidth - 4;
		const clip = (lines: string[]) => lines.map((l) => clipAnsi(l, inner));
		const leftBox = renderBox(L.sessions_heading, clip(leftLines), boxWidth);
		const rightBox = renderBox(L.actions_heading, clip(rightLines), boxWidth);
		const outputLines = [...heroLines, ...leftBox, "", ...rightBox, ...footer];

		const leftStart = heroLines.length + 1; // after left box top border
		if (!emptyLeft) {
			for (let i = 0; i < leftRowIndices.length; i += 1) {
				const r = rows[leftRowIndices[i] as number] as Row;
				if (!isSelectable(r)) continue;
				clickTargets.push({
					row: leftStart + i,
					colStart: 1,
					colEnd: boxWidth,
					index: leftRowIndices[i] as number,
				});
			}
		}
		const rightStart = heroLines.length + leftBox.length + 1 + 1; // + spacer + right top
		for (let i = 0; i < rightRowIndices.length; i += 1) {
			const r = rows[rightRowIndices[i] as number] as Row;
			if (!isSelectable(r)) continue;
			clickTargets.push({
				row: rightStart + i,
				colStart: 1,
				colEnd: boxWidth,
				index: rightRowIndices[i] as number,
			});
		}
		return outputLines.join("\n");
	}

	// Wide: side-by-side columns.
	const leftWidth = Math.max(20, Math.floor((cols - gap.length) / 2));
	const rightWidth = Math.max(20, cols - gap.length - leftWidth);
	const leftBox = renderBox(L.sessions_heading, leftLines, leftWidth);
	const rightBox = renderBox(L.actions_heading, rightLines, rightWidth);
	const joined = joinColumns(leftBox, rightBox, cols).split("\n");
	const outputLines = [...heroLines, ...joined, ...footer];

	const dataStart = heroLines.length + 2;
	if (!emptyLeft) {
		for (let i = 0; i < leftRowIndices.length; i += 1) {
			const r = rows[leftRowIndices[i] as number] as Row;
			if (!isSelectable(r)) continue;
			clickTargets.push({
				row: dataStart + i,
				colStart: 1,
				colEnd: leftWidth,
				index: leftRowIndices[i] as number,
			});
		}
	}
	for (let i = 0; i < rightRowIndices.length; i += 1) {
		const r = rows[rightRowIndices[i] as number] as Row;
		if (!isSelectable(r)) continue;
		clickTargets.push({
			row: dataStart + i,
			colStart: leftWidth + gap.length + 1,
			colEnd: leftWidth + gap.length + rightWidth,
			index: rightRowIndices[i] as number,
		});
	}

	return outputLines.join("\n");
}
