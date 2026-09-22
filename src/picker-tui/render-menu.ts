/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Menu screen renderer: state-machine dispatch, hero chrome, bordered box, and the menu/confirm renderers.
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
import { renderConsoleBox } from "./console-log.ts";
import { clickTargets, rootLevel, type ClickTarget } from "./menu-tree.ts";
import { groupLabel } from "./option-display.ts";
import type { AppState, PickerConfig } from "./types.ts";

interface RenderLine {
	text: string;
	optIdx?: number;
}

function padRightAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLen(text)))}`;
}

function renderBox(title: string, width: number, lines: RenderLine[]): RenderLine[] {
	const boxWidth = Math.max(12, width);
	const inner = boxWidth - 4;
	const titleText = ` ${title} `;
	const titleWidth = Math.min(inner, titleText.length);
	const leftRule = Math.max(0, Math.floor((boxWidth - 2 - titleWidth) / 2));
	const rightRule = Math.max(0, boxWidth - 2 - titleWidth - leftRule);
	const label = titleWidth < titleText.length ? titleText.slice(0, titleWidth) : titleText;
	const top: RenderLine = {
		text:
			`${AMBER_BRIGHT}╭${"─".repeat(leftRule)}${RESET}` +
			`${BOLD}${FG}${label}${RESET}` +
			`${AMBER_BRIGHT}${"─".repeat(rightRule)}╮${RESET}`,
	};
	const body = lines.map((line) => ({
		text: `${AMBER_BRIGHT}│${RESET} ${padRightAnsi(line.text, inner)} ${AMBER_BRIGHT}│${RESET}`,
		optIdx: line.optIdx,
	}));
	const bottom: RenderLine = { text: `${AMBER_BRIGHT}╰${"─".repeat(boxWidth - 2)}╯${RESET}` };
	return [top, ...body, bottom];
}

}

function padRightAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleLen(text)))}`;
}

interface RenderLine {
	text: string;
	optIdx?: number;
}

function renderBox(title: string, width: number, lines: RenderLine[]): RenderLine[] {
	const boxWidth = Math.max(12, width);
	const inner = boxWidth - 4;
	const titleText = ` ${title} `;
	const titleWidth = Math.min(inner, titleText.length);
	const leftRule = Math.max(0, Math.floor((boxWidth - 2 - titleWidth) / 2));
	const rightRule = Math.max(0, boxWidth - 2 - titleWidth - leftRule);
	const label = titleWidth < titleText.length ? titleText.slice(0, titleWidth) : titleText;
	const top: RenderLine = {
		text:
			`${AMBER_BRIGHT}╭${"─".repeat(leftRule)}${RESET}` +
			`${BOLD}${FG}${label}${RESET}` +
			`${AMBER_BRIGHT}${"─".repeat(rightRule)}╮${RESET}`,
	};
	const body = lines.map((line) => ({
		text: `${AMBER_BRIGHT}│${RESET} ${padRightAnsi(line.text, inner)} ${AMBER_BRIGHT}│${RESET}`,
		optIdx: line.optIdx,
	}));
	const bottom: RenderLine = { text: `${AMBER_BRIGHT}╰${"─".repeat(boxWidth - 2)}╯${RESET}` };
	return [top, ...body, bottom];
}

function renderMenu(state: AppState & { kind: "menu" }, config: PickerConfig): string {
	const cols = termCols();
	const level = state.stack[state.stack.length - 1];
	if (!level) return "";
	const L = config.labels;

	clickTargets.length = 0;
	const lines: string[] = [];

	const hero = renderHero(config.title, cols);
	for (const l of hero.split("\n")) lines.push(l);

	if (state.stack.length > 1) {
		const crumb = state.stack.map((l) => l.title).join(" › ");
		lines.push(center(`${FAINT}${crumb}${RESET}`, cols, crumb.length));
		lines.push(rule(cols));
	}

	const byCategory = new Map<string, DisplayRow[]>();
	for (const row of level.displayRows) {
		const cat = row.primary.config.category;
		const arr = byCategory.get(cat) ?? [];
		arr.push(row);
		byCategory.set(cat, arr);
	}

	// AI Coding renders as a three-column table (CLI | Provider | Model) —
	// every row shows three independent columns, and Tab cycles the active
	// variant's provider+model within the selected CLI's row. Other categories
	// keep their existing boxed layout.
	const AI_CATEGORY = "AI Coding";
	const aiRows = byCategory.get(AI_CATEGORY) ?? [];
	const otherCategories = new Map<string, DisplayRow[]>();
	for (const [cat, rows] of byCategory.entries()) {
		if (cat !== AI_CATEGORY) otherCategories.set(cat, rows);
	}

	let flatIdx = 0;

	// --- Three-column table for AI Coding ---
	if (aiRows.length > 0) {
		const col1Width = 16; // CLI
		const col2Width = 18; // Provider
		const col3Width = 22; // Model
		const sep = `${FAINT} │ ${RESET}`;
		const tableWidth = col1Width + sep.length * 2 + col2Width + col3Width;

		// Header row
		const headerCells = [
			{ text: "CLI", width: col1Width },
			{ text: "Provider", width: col2Width },
			{ text: "Model", width: col3Width },
		];
		const headerLine =
			`${DIM}` +
			headerCells.map((c) => padRightAnsi(c.text, c.width)).join(sep) +
			`${RESET}`;
		lines.push(center(headerLine, cols, tableWidth));
		lines.push(
			center(
				`${FAINT}${"─".repeat(col1Width)}┼${"─".repeat(col2Width)}┼${"─".repeat(col3Width)}${RESET}`,
				cols,
				tableWidth,
			),
		);

		for (const row of aiRows) {
			const opt = activeOptionFor(row, state.variantSelection);
			const selected = flatIdx === state.selectedIdx;
			const isVariant = row.variants.length > 1;
			const cols3 = variantColumns(opt);
			const marker = isVariant ? `${AMBER_BRIGHT}⇄${RESET}` : `${FAINT}·${RESET}`;
			const bar = selected ? `${AMBER_BRIGHT}┃${RESET} ` : "  ";
			const boldOn = selected ? BOLD : "";
			const cell1 = `${FG}${boldOn}${padRightAnsi(cols3.family, col1Width - 2)}${RESET}`;
			const cell2 = `${FG}${boldOn}${padRightAnsi(cols3.provider || "—", col2Width)}${RESET}`;
			const cell3 = `${FG}${boldOn}${padRightAnsi(cols3.model || "—", col3Width)}${RESET}`;
			const rowLine = `  ${bar}${marker} ${cell1}${sep}${cell2}${sep}${cell3}`;
			lines.push(center(rowLine, cols, tableWidth));
			const lineNo = lines.length;
			clickTargets.push({ row: lineNo, colStart: 1, colEnd: cols, index: flatIdx });
			flatIdx += 1;
		}
		lines.push("");
	}

	// --- Boxed layout for other categories ---
	const narrow = cols < 100;
	const columnGap = "   ";
	const leftWidth = narrow
		? Math.max(12, cols - 2)
		: Math.max(24, Math.floor((cols - columnGap.length) / 2));
	const rightWidth = narrow ? leftWidth : Math.max(24, cols - columnGap.length - leftWidth);
	const categoryBlocks: Array<{ title: string; lines: RenderLine[]; selector: boolean }> = [];
	for (const [cat, rows] of otherCategories.entries()) {
		const block: RenderLine[] = [];

		for (const row of rows) {
			const opt = activeOptionFor(row, state.variantSelection);
			const selected = flatIdx === state.selectedIdx;
			const isVariant = row.variants.length > 0;
			const marker = isVariant
				? `${AMBER_BRIGHT}⇄${RESET}`
				: opt.config.action_type === "submenu"
					? `${AMBER_BRIGHT}›${RESET}`
					: `${FAINT}·${RESET}`;
			const bar = selected ? `${AMBER_BRIGHT}┃${RESET} ` : `  `;
			const boldOn = selected ? BOLD : "";
			const cols3 = variantColumns(opt);
			const displayLabel = isVariant
				? `${cols3.family} | ${cols3.provider || "—"} | ${cols3.model || "—"}`
				: row.primary.label;
			const label = `${FG}${boldOn}${displayLabel}${RESET}`;
			block.push({ text: `  ${bar}${marker} ${label}`, optIdx: flatIdx });
			flatIdx += 1;
		}
		categoryBlocks.push({
			title: cat,
			lines: block,
			selector: rows.some((row) => row.variants.length > 1),
		});
	}

	if (narrow) {
		// Stack every category box full-width, one per row, clipping rows to fit.
		const inner = leftWidth - 4;
		for (const blk of categoryBlocks) {
			const clipped = blk.lines.map((l) => ({ ...l, text: clipAnsi(l.text, inner) }));
			const box = renderBox(blk.title, leftWidth, clipped);
			for (const boxLine of box) {
				lines.push(boxLine.text);
				if (boxLine.optIdx !== undefined) {
					clickTargets.push({
						row: lines.length,
						colStart: 1,
						colEnd: leftWidth,
						index: boxLine.optIdx,
					});
				}
			}
			lines.push("");
		}
	} else {
		const renderColumn = (
			blocks: Array<{ title: string; lines: RenderLine[] }>,
			width: number,
		): RenderLine[] =>
			blocks.flatMap((block) => [...renderBox(block.title, width, block.lines), { text: "" }]);
		const left = renderColumn(
			categoryBlocks.filter((block) => block.selector),
			leftWidth,
		);
		const right = renderColumn(
			categoryBlocks.filter((block) => !block.selector),
			rightWidth,
		);
		{
			const rows = Math.max(left.length, right.length);
			for (let rowIdx = 0; rowIdx < rows; rowIdx += 1) {
				const leftLine = left[rowIdx] ?? { text: "" };
				const rightLine = right[rowIdx] ?? { text: "" };
				const outputLine = `${padRightAnsi(leftLine.text, leftWidth)}${columnGap}${padRightAnsi(rightLine.text, rightWidth)}`;
				lines.push(outputLine);
				const lineNo = lines.length;
				if (leftLine.optIdx !== undefined) {
					clickTargets.push({ row: lineNo, colStart: 1, colEnd: leftWidth, index: leftLine.optIdx });
				}
				if (rightLine.optIdx !== undefined) {
					clickTargets.push({
						row: lineNo,
						colStart: leftWidth + columnGap.length + 1,
						colEnd: leftWidth + columnGap.length + rightWidth,
						index: rightLine.optIdx,
					});
				}
			}
		}
	}

	lines.push(center(`${DIM}${ITALIC}${L.nav_hint_menu}${RESET}`, cols, L.nav_hint_menu.length));

	// When the selected row is a variant group, surface the Tab hint so the
	// operator discovers variant-cycling without reading docs.
	const selectedRow = level.displayRows[state.selectedIdx];
	if (selectedRow && selectedRow.variants.length > 1) {
		const g = selectedRow.primary.family?.key ?? "";
		const idx = state.variantSelection[g] ?? 0;
		const text = `Tab: switch variant (${idx + 1}/${selectedRow.variants.length})`;
		lines.push(center(`${DIM}${ITALIC}${text}${RESET}`, cols, text.length));
	}

	// Console event box — last N successes/errors, persistent across redraws.
	// Operator request: errors must be visible and copyable rather than flashing
	// and disappearing. Rendered flush against the menu above — no gap.
	const consoleLines = renderConsoleBox(cols);
	if (consoleLines.length > 0) {
		for (const cl of consoleLines) lines.push(cl);
	}

	return lines.join("\n");
}

function renderConfirm(state: AppState & { kind: "confirm" }, config: PickerConfig): string {
	const cols = termCols();
	const L = config.labels;
	const msg = state.option.config.confirm_message ?? `Run "${state.option.label}"?`;
	const hint = `${DIM}${ITALIC}${L.confirm_hint}${RESET}`;
	return (
		renderHero(config.title, cols) +
		`${screenTitle(L.confirm_heading, cols, RED)}\n` +
		`${center(`${FG}${msg}${RESET}`, cols, msg.length)}\n\n` +
		`${center(hint, cols, L.confirm_hint.length)}\n\n`
	);
}

function render(state: AppState, config: PickerConfig): string {
	switch (state.kind) {
		case "menu":
			return renderMenu(state, config);
		case "confirm":
			return renderConfirm(state, config);
	}
}