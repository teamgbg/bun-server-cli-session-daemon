/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Session-select actions: attachTo, createSession/createDetached, navigation,
 * row mutations, delete-confirm, activate (restore + attach), and the
 * partial-restore ack screen. Each takes the shared PickerRuntime; the closures
 * that used to close over `let` bindings now read and write `rt` fields.
 */
import { spawnSync } from "@teamscala/os/spawn/spawn";
import { attach } from "@teamscala/tmux-session/interact";
import {
	mutateSession,
	restoreSession,
	type RestoreResult,
	type SessionRowOp,
} from "./picker-rpc.ts";
import { formatRestoreAckLines } from "./restore-ack.ts";
import { CLEAR, termCols } from "./style.ts";
import { recordEvent } from "@teamscala/event-log/record-event";
import { pickCoolName, reservedNames } from "./format-helpers.ts";
import { isSelectable } from "./row-build.ts";
import type { PickerRuntime } from "./picker-runtime.ts";

// Per-row action for the A / u / Del / d keys. Delete is eligible on ANY
	// session row — a live session is killed then its row removed (kill+delete),
	// a stored row is just removed. Archive is for closed sessions only; on a
	// live row it explains instead of silently doing nothing. The daemon owns the
	// actual kill/delete (mutateSessionRow); the picker just names the op.
	export function rowAction(rt: PickerRuntime, key: "archive" | "unarchive" | "delete"): void {
	const layout = rt.computeLayout();
	const row = layout.rows[rt.selectedIdx];
	if (!row || !isSelectable(row)) return;
	if (key === "archive") {
		if (row.kind === "session") {
			// Live: the daemon closes (kills) the session if it's idle (no real
			// CLI tabs — just a shell/picker) and hides its row; if it has
			// running tabs the daemon refuses and the status surfaces the error.
			rt.runMutation(row.info.name, "archive", `Archived & closed '${row.info.name}'`);
		} else if (row.kind === "archived") {
			rt.runMutation(row.info.name, "archive", `Archived '${row.info.name}'`);
		}
		return;
	}
	if (key === "unarchive") {
		if (row.kind !== "hidden") return; // only a hidden row can be restored
		rt.runMutation(row.info.name, "unarchive", `Restored '${row.info.name}'`);
		return;
	}
	// delete — eligible on live (kill+delete), archived, or hidden rows
	if (row.kind === "session" || row.kind === "archived" || row.kind === "hidden") {
		rt.armDelete(row.info.name, row.kind === "session");
	}
	}
	// Selecting a session is the ONLY thing that reopens CLI tabs — boot opens
	// nothing, so nothing restores automatically. For a live or archived session
	// we restore its recorded tabs through the daemon (idempotent: live tabs
	// stay, dead ones reopen resumed), then attach. `activating` guards against
	// a second select landing while a restore is in flight (spawning tabs takes a
	// second or two). The non-restore branches (new / hidden / refresh / quit)
	// bypass the guard.
	
	export async function activate(rt: PickerRuntime): Promise<void> {
	if (rt.activating) return;
	const layout = rt.computeLayout();
	const row = layout.rows[rt.selectedIdx];
	if (!row || !isSelectable(row)) return;
	if (row.kind === "session" || row.kind === "archived") {
		rt.activating = true;
		const name = row.info.name;
		rt.statusMsg = row.kind === "archived" ? `Restoring '${name}'…` : `Reconnecting '${name}'…`;
		rt.redraw();
		// An archived session isn't live yet — create its shell (picker home
		// window) detached so the daemon's restore reopens the recorded tabs
		// alongside it before we attach. /rpc/restore also ensures the shell;
		// createDetached preserves the picker-home-window UX.
		if (row.kind === "archived") rt.createDetached(name);
		const outcome = await restoreSession(name);
		// FAIL LOUD: a partial restore (any tab failed or reopened degraded) is
		// surfaced as a full ack screen NAMING every problem tab BEFORE attach
		// takes the terminal. Without this the operator sees the tabs that DID
		// come back, assumes the session is complete, and the missing work is
		// invisible — the silent-partial disease. The ack is modal: any key
		// proceeds to attach (the lane is still usable); the warning has been
		// seen and the names live in event_log for recall.
		if (!outcome.ok) await ackRestoreProblems(name, outcome);
		rt.attachTo(name); // cleanupTerminal + recordEvent + attach + exit
		return;
	}
	if (row.kind === "hidden") {
		// Enter on a hidden row restores it (unarchive) — reverses hiding.
		// (u does the same; Del removes it permanently.)
		rt.runMutation(row.info.name, "unarchive", `Restored '${row.info.name}'`);
		return;
	}
	if (row.kind === "new") {
		const taken = reservedNames(rt.sessions, rt.archived, rt.hidden);
		rt.createSession(pickCoolName(taken));
		return;
	}
	if (row.kind === "refresh") {
		void rt.refreshData().then(() => rt.redraw());
		return;
	}
	if (row.kind === "quit") rt.quit();
	}

	// Paint the partial-restore ack screen (every failed/degraded tab named) and
	// block attach on a keypress. Pure line content comes from
	// `formatRestoreAckLines` (unit-tested); this closure owns only the
	// side-effectful paint + the modal key wait. `renderer.reset()` first so the
	// next real paint is full-frame — the ack screen is a one-off surface outside
	// the incremental renderer's frame model, so without the reset a stale frame
	// diff would corrupt the picker screen after the operator acknowledges.
	export async function ackRestoreProblems(rt: PickerRuntime, name: string, outcome: RestoreResult): Promise<void> {
	const lines = formatRestoreAckLines(outcome, name, termCols());
	rt.renderer.reset();
	rt.stdout.write(`${CLEAR}${lines.join("\n")}\n`);
	await new Promise<void>((resolve) => {
		rt.pendingRestoreAck = resolve;
	});
	}

// === attach + create + navigation + mutation ===

export function attachTo(rt: PickerRuntime, name: string): never {
	rt.cleanupTerminal();
	recordEvent({ kind: "cli-session.picker.select", payload: { session: name, action: "attach" } });
	process.exit(attach(name));
}

// The new session's home window IS the CLI-picker view. We run it via a
// bash `exec -a scala-picker` so the picker tab shows as `scala-picker`
// (not bare `bun`) in /proc/<pid>/cmdline — argv[0] can only be set at
// execve time (proxy-is-not-behaviour).
export function createSession(rt: PickerRuntime, name: string): never {
	rt.cleanupTerminal();
	recordEvent({ kind: "cli-session.picker.select", payload: { session: name, action: "new" } });
	const launcherEntry = `${import.meta.dir}/launcher-entry.ts`;
	const r = spawnSync({
		name: "tmux:new-session",
		command: ["tmux", "new-session", "-s", name, "-n", rt.config.picker_window, namedLauncherCommand(process.execPath, launcherEntry, name)],
		inheritStdio: true,
	});
	process.exit(r.exitCode);
}

// Detached sibling of createSession: same picker-home-window session shape,
// but created WITHOUT attaching (`-d`, no inheritStdio) so the picker can
// restore tabs into it before attaching.
export function createDetached(rt: PickerRuntime, name: string): void {
	const launcherEntry = `${import.meta.dir}/launcher-entry.ts`;
	spawnSync({
		name: "tmux:new-session",
		command: ["tmux", "new-session", "-d", "-s", name, "-n", rt.config.picker_window, namedLauncherCommand(process.execPath, launcherEntry, name)],
	});
}

export function moveSelection(rt: PickerRuntime, delta: number): void {
	const layout = rt.computeLayout();
	const selectable = rt.selectableIndices(layout.rows);
	if (selectable.length === 0) return;
	const cur = selectable.indexOf(rt.selectedIdx);
	const next = Math.max(0, Math.min(selectable.length - 1, (cur < 0 ? 0 : cur) + delta));
	rt.selectedIdx = selectable[next] as number;
	rt.redraw();
}

// Run a session-row mutation through the daemon's single executor, then
// refresh + redraw with a one-line status. Fire-and-forget from the key
// handler; a transient failure is shown inline, never blocks the picker.
export function runMutation(rt: PickerRuntime, name: string, op: SessionRowOp, doneMsg: string): void {
	void mutateSession(name, op).then(async (r) => {
		rt.pendingDelete = null;
		rt.statusMsg = r.ok ? doneMsg : `${op} failed: ${r.error ?? "unknown error"}`;
		await rt.refreshData();
		rt.redraw();
	});
}

// Delete is a two-step confirm so one mis-tap can't drop a row. Del/d arms
// it (footer shows the prompt); y confirms, anything else cancels.
export function armDelete(rt: PickerRuntime, name: string, live: boolean): void {
	rt.pendingDelete = { name, live };
	rt.statusMsg = null;
	rt.redraw();
}

export function cancelDelete(rt: PickerRuntime): void {
	rt.pendingDelete = null;
	rt.redraw();
}

// === wiring ===

/** Attach every action closure to the runtime. Called once by runSessionSelect. */
export function wirePickerActions(rt: PickerRuntime): void {
	rt.attachTo = (name) => attachTo(rt, name);
	rt.createSession = (name) => createSession(rt, name);
	rt.createDetached = (name) => createDetached(rt, name);
	rt.moveSelection = (delta) => moveSelection(rt, delta);
	rt.runMutation = (name, op, doneMsg) => runMutation(rt, name, op, doneMsg);
	rt.armDelete = (name, live) => armDelete(rt, name, live);
	rt.cancelDelete = () => cancelDelete(rt);
	rt.rowAction = (key) => rowAction(rt, key);
	rt.activate = () => activate(rt);
	rt.ackRestoreProblems = (name, outcome) => ackRestoreProblems(rt, name, outcome);
}
