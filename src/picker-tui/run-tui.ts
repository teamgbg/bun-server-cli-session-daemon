/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * runTui loop: raw-mode stdin, alt-screen ANSI rendering, menu → confirm → running → ops_result state machine, live hot-reload from the daemon.
 */

import { spawnOption, fetchOptions, watchPickerEvents } from "./picker-rpc.ts";
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
import { createScreenRenderer } from "./screen-renderer.ts";
import { pushConsoleEvent, pushOpsOutput, pushDispatchError } from "./console-log.ts";
import { buildMenuTree, optionSignature, rootLevel, type MenuLevel } from "./menu-tree.ts";
import { activeOptionFor, buildDisplayRows } from "./option-display.ts";
import { render } from "./render-menu.ts";
import type { AppState, MenuOption, PickerConfig } from "./types.ts";

export interface TuiDeps {
	config: PickerConfig;
	initialOptions: MenuOption[];
	tmuxSession: string;
}

export interface TuiDeps {
	config: PickerConfig;
	initialOptions: MenuOption[];
	tmuxSession: string;
}

export async function runTui(deps: TuiDeps): Promise<number> {
	const { config, tmuxSession } = deps;
	let levels = buildMenuTree(deps.initialOptions);
	let lastOptionsSig = optionSignature(deps.initialOptions);
	let state: AppState = {
		kind: "menu",
		stack: [rootLevel(levels)],
		status: null,
		selectedIdx: 0,
		variantSelection: {},
	};

	pushConsoleEvent("info", `picker started — session "${tmuxSession}"`);

	// Live hot-reload: a database emission re-fetches the option list from the
	// daemon so registry edits appear in the open picker without a restart.
	// Rebuilds the menu tree, preserving the
	// current submenu stack + selection + variant choices. Skips the redraw when
	// the option set is unchanged (cheap signature compare) to avoid flicker.
	let refreshInFlight = false;
	const refreshOptions = async (): Promise<void> => {
		// Coalesce a burst of database emissions while one refresh is in flight.
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			const fresh = await fetchOptions();
			const sig = optionSignature(fresh);
			if (sig === lastOptionsSig) return;
			lastOptionsSig = sig;
			const nextLevels = buildMenuTree(fresh);
			// Preserve the current submenu stack by id, carrying over titles.
			const stackIds = state.kind === "menu" ? state.stack.map((l) => l.id) : ["root"];
			const oldTitles = state.kind === "menu" ? state.stack.map((l) => l.title) : ["Main"];
			const newStack: MenuLevel[] = [];
			let cur = nextLevels.get("root") ?? rootLevel(nextLevels);
			newStack.push({ ...cur, title: oldTitles[0] ?? cur.title });
			for (let i = 1; i < stackIds.length; i += 1) {
				const next = nextLevels.get(stackIds[i] ?? "");
				if (!next) break;
				newStack.push({ ...next, title: oldTitles[i] ?? next.title });
			}
			levels = nextLevels;
			if (state.kind === "menu") {
				const level = newStack[newStack.length - 1] ?? rootLevel(nextLevels);
				const clamped = Math.min(state.selectedIdx, level.displayRows.length - 1);
				state = {
					...state,
					stack: newStack,
					selectedIdx: Math.max(0, clamped),
					status: null,
				};
				redraw();
			}
		} catch {
			// Keep the last-good menu. The event stream reconnects after transport
			// failure and its initial event requests a fresh snapshot.
		} finally {
			refreshInFlight = false;
		}
	};
	const stdin = process.stdin;
	const stdout = process.stdout;
	const renderer = createScreenRenderer();

	if (!stdin.isTTY) {
		stdout.write("session-picker: stdin is not a TTY — cannot render TUI\n");
		return 2;
	}

	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	stdout.write(`${ALT_ON}${CURSOR_HIDE}${MOUSE_ON}`);
	const eventAbort = new AbortController();
	void watchPickerEvents(eventAbort.signal, refreshOptions);

	const cleanup = (): void => {
		eventAbort.abort();
		stdout.write(`${MOUSE_OFF}${CURSOR_SHOW}${ALT_OFF}`);
		try {
			stdin.setRawMode(false);
		} catch {
			// ignore
		}
		stdin.pause();
	};

	process.on("SIGTERM", () => {
		// SIGTERM is honoured — system shutdown / tmux session-kill needs to
		// reach the process. Operator-keystroke exits are blocked elsewhere.
		cleanup();
		process.exit(0);
	});
	// SIGINT (Ctrl-C) is intentionally swallowed. The picker must remain
	// captive inside its tmux window for the lifetime of the session — there
	// is no UX path to restore a closed picker. Operators reach the menu by
	// returning to it, never by killing it.
	process.on("SIGINT", () => {
		// no-op
	});

	const redraw = (): void => {
		stdout.write(renderer.paint(render(state, config).split("\n"), process.stdout.columns !== lastColumns));
	};
	let lastColumns = process.stdout.columns;
	const onResize = (): void => {
		lastColumns = process.stdout.columns;
		renderer.reset();
		redraw();
	};
	process.stdout.on("resize", onResize);
	redraw();

	const handleKey = async (keyRaw: string): Promise<void> => {
		// Ctrl-C (\x03) and Ctrl-D (\x04) are intentionally swallowed. The
		// picker MUST remain captive — there is no keystroke that restores a
		// closed picker, and dismissing it from inside its own tmux window
		// leaves the operator with no menu and no way to reach it again. The
		// only ways out are: choose a menu item, kill the tmux session, or
		// shut down the host.
		if (keyRaw === "\x03" || keyRaw === "\x04") {
			return;
		}

		// SGR mouse press: \x1b[<BTN;COL;ROWM (release uses trailing 'm').
		// Bits 0-1 of BTN encode left/middle/right; bit 5 (32) is motion, bit 6
		// (64) is wheel. Treat any plain left/middle/right press on a mapped
		// menu row as "tap → select + activate" (iOS-style one-tap launch).
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse protocol
		const mouse = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(keyRaw);
		if (mouse) {
			const btn = Number(mouse[1]);
			const col = Number(mouse[2]);
			const row = Number(mouse[3]);
			const isPlainButton = (btn & 0x60) === 0 && (btn & 0x03) < 3;
			const target = clickTargets.find(
				(entry) => entry.row === row && col >= entry.colStart && col <= entry.colEnd,
			);
			if (isPlainButton && state.kind === "menu" && target) {
				const optIdx = target.index;
				state = { ...state, selectedIdx: optIdx, status: null };
				await handleKey("\r");
			}
			return;
		}
		// Swallow mouse release / wheel / motion sequences silently.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse protocol
		if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(keyRaw)) return;

		switch (state.kind) {
			case "menu": {
				if (keyRaw === "\x1b") {
					// Escape pops one submenu level deep. At the TOP level it is
					// intentionally a no-op — once the picker is open inside its
					// tmux window, dismissing it would leave the operator with no
					// menu and no keystroke that brings it back. The picker MUST
					// remain captive for the lifetime of the tmux session window.
				if (state.stack.length > 1) {
					state = {
						kind: "menu",
						stack: state.stack.slice(0, -1),
						status: null,
						selectedIdx: 0,
						variantSelection: state.variantSelection,
					};
					redraw();
				}
				return;
			}
			const level = state.stack[state.stack.length - 1];
			if (!level) return;

			// Arrow-key navigation (bounds by display rows, which collapse variant
			// groups into single entries).
			if (keyRaw === "\x1b[A" || keyRaw === "\x1bOA") {
				const next = Math.max(0, state.selectedIdx - 1);
				state = { ...state, selectedIdx: next, status: null };
				redraw();
				return;
			}
			if (keyRaw === "\x1b[B" || keyRaw === "\x1bOB") {
				const next = Math.min(level.displayRows.length - 1, state.selectedIdx + 1);
				state = { ...state, selectedIdx: next, status: null };
				redraw();
				return;
			}

			// Tab → cycle the active sibling of the selected variant group. No-op
			// for standalone rows (no family key or single sibling).
			if (keyRaw === "\t") {
				const row = level.displayRows[state.selectedIdx];
				if (row && row.variants.length > 1) {
					const g = row.primary.family?.key ?? "";
					const cur = state.variantSelection[g] ?? 0;
					const nextVariant = (cur + 1) % row.variants.length;
					state = {
						...state,
						variantSelection: { ...state.variantSelection, [g]: nextVariant },
						status: null,
					};
					redraw();
				}
				return;
			}

			// Enter → activate current selection. All other keys ignored.
			if (keyRaw !== "\r" && keyRaw !== "\n") return;
			const row = level.displayRows[state.selectedIdx] ?? null;
			if (!row) return;
			const opt = activeOptionFor(row, state.variantSelection);
			// Submenu navigation is a pure view concern — resolve locally.
			if (opt.config.action_type === "submenu") {
				const child = opt.config.submenu_id ? levels.get(opt.config.submenu_id) : undefined;
				if (!child) {
					state = { ...state, status: `no submenu: ${opt.config.submenu_id ?? "?"}` };
				} else {
					state = {
						kind: "menu",
						stack: [...state.stack, { ...child, title: opt.label }],
						status: null,
						selectedIdx: 0,
						variantSelection: state.variantSelection,
					};
				}
				redraw();
				return;
			}
				if (opt.config.action_type === "quit") {
					pushConsoleEvent("info", "quitting picker");
					cleanup();
					process.exit(0);
				}
				// ops with a confirm prompt → confirm screen first.
				if (opt.config.action_type === "ops" && opt.config.confirm_message) {
					state = { kind: "confirm", option: opt, stack: state.stack };
					redraw();
					return;
				}
				// tmux_window or ops → the daemon owns the ENTIRE spawn (window
				// allocation, seed/resume, slug marker, tab-state, capture). The
				// view only names the slug + target session and renders the result.
				pushConsoleEvent("info", `running ${opt.label}…`);
				redraw();
				{
					const result = await spawnOption(opt.slug, tmuxSession);
					if (result.ok) {
						if (result.windowName) {
							pushConsoleEvent("success", `→ ${result.windowName}`);
							state = { ...state, status: `opened ${result.windowName}` };
						} else if (result.output !== undefined) {
							pushOpsOutput(opt.label, result.exitCode ?? 0, result.output ?? "");
							state = { ...state, status: null };
						} else {
							pushConsoleEvent("success", `✓ ${opt.label}`);
							state = { ...state, status: null };
						}
					} else {
						pushDispatchError(opt.label, result.error ?? "unknown error");
						state = { ...state, status: `error: ${(result.error ?? "").split("\n")[0]}` };
					}
					redraw();
					return;
				}
			}
			case "confirm": {
				// Enter = confirm, Esc / any other key = cancel.
				if (keyRaw === "\r" || keyRaw === "\n") {
					const opt = state.option;
					const stack = state.stack;
				pushConsoleEvent("info", `running ${opt.label}…`);
				state = { kind: "menu", stack, status: null, selectedIdx: 0, variantSelection: {} };
				redraw();
				const result = await spawnOption(opt.slug, tmuxSession);
				if (result.ok && result.output !== undefined) {
					pushOpsOutput(opt.label, result.exitCode ?? 0, result.output ?? "");
				} else if (result.ok) {
					pushConsoleEvent("success", `✓ ${opt.label}`);
				} else {
					pushDispatchError(opt.label, result.error ?? "unknown error");
				}
			} else {
				pushConsoleEvent("info", `cancelled: ${state.option.label}`);
				state = { kind: "menu", stack: state.stack, status: null, selectedIdx: 0, variantSelection: {} };
			}
				redraw();
				return;
			}
		}
	};

	return new Promise<number>((resolve) => {
		stdin.on("data", (chunk: string) => {
		handleKey(chunk).catch((err) => {
			pushConsoleEvent("error", err instanceof Error ? err.message : String(err));
			const stack = state.kind === "menu" ? state.stack : [rootLevel(levels)];
			const variantSelection = state.kind === "menu" ? state.variantSelection : {};
			state = { kind: "menu", stack, status: null, selectedIdx: 0, variantSelection };
			redraw();
		});
		});
		stdin.on("end", () => {
			cleanup();
			resolve(0);
		});
	});
}