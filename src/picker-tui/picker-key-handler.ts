/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Stdin keypress handler for the session-select screen. Debounces a lone ESC
 * (it may be the first half of a split escape sequence), dispatches the modal
 * delete-confirm + restore-ack, then nav/enter/action keys.
 */
import { clickTargets } from "./row-build.ts";
import type { PickerRuntime } from "./picker-runtime.ts";

/**
 * Mount the stdin key handler and return the screen's lifetime Promise (it
 * resolves never — the picker exits the process on quit/attach instead).
 */
export function mountKeyHandler(rt: PickerRuntime): Promise<void> {
	const { stdin } = rt;
	const clearPendingEsc = (): void => {
		rt.pendingEsc = false;
		if (rt.escTimer) {
			clearTimeout(rt.escTimer);
			rt.escTimer = null;
		}
	};
	return new Promise<void>((_resolve) => {
		stdin.on("data", (raw: string) => {
			let chunk = raw;
			if (rt.pendingEsc) {
				clearPendingEsc();
				chunk = `\x1b${chunk}`;
			}
			if (chunk === "\x03" || chunk === "\x04") rt.quit();
			// Restore-ack is modal: any key dismisses the partial-restore warning
			// and proceeds to attach. Checked BEFORE the transient-status clear so
			// the warning key is consumed here rather than also clearing state.
			if (rt.pendingRestoreAck) {
				const resolve = rt.pendingRestoreAck;
				rt.pendingRestoreAck = null;
				resolve();
				return;
			}
			// Transient status clears on the next keypress.
			rt.statusMsg = null;
			// Delete-confirm is modal: y confirms; any other key cancels and is NOT
			// re-interpreted (prevents an accidental archive/nav mid-confirm). Esc
			// also cancels rather than quitting while a confirm is pending.
			if (rt.pendingDelete) {
				if (chunk === "y" || chunk === "Y") {
					const { name, live } = rt.pendingDelete;
					rt.runMutation(name, "delete", live ? `Killed & deleted '${name}'` : `Deleted '${name}'`);
				} else {
					rt.cancelDelete();
				}
				return;
			}
			if (chunk === "\x1b") {
				rt.pendingEsc = true;
				rt.escTimer = setTimeout(() => {
					if (rt.pendingEsc) {
						rt.pendingEsc = false;
						rt.escTimer = null;
						rt.quit();
					}
				}, 50);
				return;
			}

			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse protocol
			const mouse = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(chunk);
			if (mouse) {
				const btn = Number(mouse[1]);
				const col = Number(mouse[2]);
				const row = Number(mouse[3]);
				const isPlainButton = (btn & 0x60) === 0 && (btn & 0x03) < 3;
				const target = clickTargets.find(
					(entry) => entry.row === row && col >= entry.colStart && col <= entry.colEnd,
				);
				if (isPlainButton && target) {
					rt.selectedIdx = target.index;
					rt.redraw();
					void rt.activate();
				}
				return;
			}
			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse protocol
			if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(chunk)) return;

			if (chunk === "\x1b[A" || chunk === "\x1bOA" || chunk === "<") {
				rt.moveSelection(-1);
				return;
			}
			if (chunk === "\x1b[B" || chunk === "\x1bOB" || chunk === ">") {
				rt.moveSelection(1);
				return;
			}
			if (chunk === "\r" || chunk === "\n") {
				void rt.activate();
				return;
			}
			// A = archive (closed sessions only); u = unarchive a hidden row;
			// Del OR d = delete (arms a y/n confirm; live sessions are killed +
			// deleted). `d` is the reliable fallback — mobile SSH Delete keys vary.
			if (chunk === "a" || chunk === "A") {
				rt.rowAction("archive");
				return;
			}
			if (chunk === "u" || chunk === "U") {
				rt.rowAction("unarchive");
				return;
			}
			if (chunk === "\x1b[3~" || chunk === "d" || chunk === "D") {
				rt.rowAction("delete");
				return;
			}
			// Everything else ignored. Arrows/</> + enter + esc + A/u/Del/d only.
		});
	});
}
