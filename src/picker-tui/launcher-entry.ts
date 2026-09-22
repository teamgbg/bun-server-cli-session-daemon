/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Home-window entry for a session: the CLI picker. session-select runs this as
 * a new session's first window (argv[2] = the tmux session name). It fetches
 * the launchable options from the daemon and spawns via the daemon — no logic
 * of its own.
 *
 * Run as: bun <this file> <tmux-session-name>
 */

import { setProcessName } from "@teamscala/os/set-process-name";

// Launcher-only module (import.meta.main): executed by path as a session's
// first window; importing it in a clean consumer must be inert.
if (import.meta.main) {
// Name FIRST, before the heavy launcher/picker graph loads (dynamic import) so
// btop/htop never cache a bare `bun` for this long-lived home-window picker.
setProcessName("scala-picker");

const { currentSession } = await import("@teamscala/tmux-session/command-runner");
const { runTui } = await import("./launcher.ts");
const { DEFAULT_PICKER_CONFIG, mergePickerConfig } = await import("./picker-config.ts");
const { fetchPickerData } = await import("./picker-rpc.ts");

function resolveSession(): string {
	const fromArgv = process.argv[2];
	if (fromArgv && fromArgv.length > 0) return fromArgv;
	return currentSession() ?? "main";
}

const tmuxSession = resolveSession();
const data = await fetchPickerData();
const code = await runTui({
	// Db-driven chrome: merge the config row over the baked defaults.
	config: mergePickerConfig(DEFAULT_PICKER_CONFIG, data.configOverride),
	initialOptions: data.options,
	tmuxSession,
});
process.exit(code);
}
