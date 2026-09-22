/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Login entry for the rich session picker. The daemon launches this (and
 * bashrc triggers it) OUTSIDE tmux on SSH login; it presents the SCALA-DEV
 * page and hands the tty to tmux on select. Daemon-backed: all data via /rpc.
 *
 * Run as: bun <this file>
 */

import { setProcessName } from "@teamscala/os/set-process-name";

// Launcher-only module (import.meta.main): executed by path on login;
// importing it in a clean consumer must be inert.
if (import.meta.main) {
// Name FIRST, before the heavy picker graph loads (dynamic import) so btop/
// htop never cache a bare `bun` for this long-lived login picker. prctl via
// @teamscala/os (Bun's process.title is broken on posix, oven-sh/bun#14255).
setProcessName("scala-picker");

const { DEFAULT_PICKER_CONFIG } = await import("./picker-config.ts");
const { runSessionSelect } = await import("./run-session-select.ts");

await runSessionSelect(DEFAULT_PICKER_CONFIG);
}
