/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Ensures a tmux session has the non-persisted picker home window. This is
 * shell chrome, not a managed work tab, so it deliberately does not write to
 * session-state tabs[].
 */

import { spawnSync } from "@teamscala/os/spawn/spawn";
import { listWindows, newWindow } from "@teamscala/tmux-session/windows";
import { hasSession } from "@teamscala/tmux-session/command-runner";
import { DEFAULT_PICKER_CONFIG } from "../picker-tui/picker-config.ts";
import { namedLauncherCommand } from "../picker-tui/named-launcher.ts";

const PICKER_WINDOW = DEFAULT_PICKER_CONFIG.picker_window;
const LAUNCHER_ENTRY = new URL("../picker-tui/launcher-entry.ts", import.meta.url).pathname;

function pickerCommand(tmuxSession: string): string {
	return namedLauncherCommand(process.execPath, LAUNCHER_ENTRY, tmuxSession);
}

export function ensurePickerHomeWindow(tmuxSession: string): void {
	if (!hasSession(tmuxSession)) {
		const result = spawnSync({
			name: "tmux:new-session-picker",
			command: ["tmux", "new-session", "-d", "-s", tmuxSession, "-n", PICKER_WINDOW, pickerCommand(tmuxSession)],
		});
		if (!result.success) {
			throw new Error(`tmux picker session failed (exit ${result.exitCode})`);
		}
		return;
	}

	if (listWindows(tmuxSession).some((w) => w.name === PICKER_WINDOW)) return;

	const result = newWindow({
		session: tmuxSession,
		name: PICKER_WINDOW,
		command: pickerCommand(tmuxSession),
		focus: false,
		probeMs: 0,
	});
	if (!result.ok) {
		throw new Error(result.error ?? "tmux picker window failed");
	}
}
