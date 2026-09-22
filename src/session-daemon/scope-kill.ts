/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Systemd scope termination for fleet lanes. Every lane launches via
 * `systemd-run --user --scope`, so the CLI is a child of the USER MANAGER,
 * not of the pane — killing the tmux window alone CANNOT stop it. This
 * module resolves the scope from the pane's PID and terminates it.
 *
 * Extracted into its own file so the systemctl calls are mockable in tests
 * (Bun.spawnSync is a global and cannot be mocked via mock.module).
 */

/**
 * Kill a systemd scope by PID. Sends SIGTERM first, then SIGKILL if the
 * process does not exit within the poll window. Returns true when the
 * process is confirmed gone, false when it refuses both signals.
 *
 * Uses async spawn for the poll loop so the event loop is not blocked
 * (spawnSync inside a dynamic loop is prohibited by no-serial-per-unit-
 * work-on-hot-paths).
 */
/**
 * The scope unit a pid actually belongs to, READ from the kernel.
 *
 * Constructing `run-p<pid>.scope` looks right and is wrong: systemd-run names a
 * transient scope `run-p<pid>-i<instance>.scope`, so the constructed name
 * addresses a unit that does not exist. `systemctl kill` on a missing unit is a
 * no-op, the process survives both signals, and the caller reports "refused
 * SIGTERM and SIGKILL" — which reads as a stubborn process rather than as a
 * name we invented. Measured 2026-07-31: pid 2484096 lives in
 * `run-p2484096-i44404099.scope` while the code targeted `run-p2484096.scope`,
 * so every close_agent_tab failed with that misleading message.
 *
 * /proc/<pid>/cgroup is the authority and needs no guess about the suffix.
 *
 * AND NO GUESS ABOUT THE PREFIX EITHER. The first fix here replaced an INVENTED
 * name with a READ one but still matched a single shape — `run-p<pid>-i<n>` —
 * which is only what `systemd-run` happens to name a transient scope. Panes
 * launched down other paths sit in differently-named scopes, and for those the
 * match returned null, the kill never ran, and the caller reported the process
 * as refusing SIGTERM and SIGKILL. Measured 2026-07-31: pid 2182218 lives in
 * `tmux-spawn-1efbd1d0-e8b5-475d-98ca-1ef658f37e78.scope`, so close_agent_tab
 * failed on it while claiming to have signalled `run-p2182218.scope`.
 *
 * That is the same defect as the original in a narrower disguise: assuming a
 * name instead of reading one. The unit is therefore taken as the LAST path
 * component ending in `.scope`, whatever it is called — the cgroup path already
 * states it, and any pattern narrower than "it is a scope" is another guess
 * waiting to be wrong.
 */

import { spawn, spawnSync } from "@teamscala/os/spawn/spawn";
import { readProcess } from "@teamscala/proc-walker/walk";

export async function scopeUnitForPid(
	pid: number,
	// Injected so the REAL unit shape is testable without a live /proc entry.
	// The bug this replaces was invisible to a test that asserted the string the
	// code itself constructed — a test can only catch an invented name if it is
	// fed a real cgroup line to derive from.
	readScope: (p: number) => Promise<string | null | undefined> = (p) =>
		readProcess(p).then((r) => r?.owningScope),
): Promise<string | null> {
	try {
		return (await readScope(pid)) ?? null;
	} catch {
		// No cgroup file means no such pid — the caller's own liveness probe
		// decides what that means; do not invent a unit name here.
		return null;
	}
}

export async function killScopeForPid(
	pid: number,
	readScope?: (p: number) => Promise<string | null | undefined>,
): Promise<boolean> {
	const scopeUnit = await scopeUnitForPid(pid, readScope);
	if (!scopeUnit) {
		// Nothing to kill, or the pid is already gone. Confirm rather than assume:
		// a missing cgroup for a live pid would otherwise read as success.
		const probe = spawnSync({
			name: "scope-kill:pid-probe-nounit",
			command: ["kill", "-0", String(pid)],
			timeoutMs: 1000,
		});
		return (probe.exitCode ?? 1) !== 0;
	}

	// Send SIGTERM (sync — one call, not a loop)
	spawnSync({
		name: "scope-kill:systemctl-kill",
		command: ["systemctl", "--user", "kill", "-s", "SIGTERM", scopeUnit],
		timeoutMs: 5000,
	});

	// Poll for the PID to vanish (up to 3s). Async spawn so the event loop
	// is not blocked by repeated spawnSync calls.
	const deadline = Date.now() + 3000;
	let pidGone = false;
	while (Date.now() < deadline) {
		const check = await spawn({
			name: "scope-kill:pid-probe",
			command: ["kill", "-0", String(pid)],
			timeoutMs: 1000,
		});
		// `spawn` from @teamscala/os resolves to the RESULT, carrying exitCode
		// directly — it is not a Bun native subprocess, so there is no `.exited`
		// promise to await. Awaiting the absent property yielded undefined and
		// destructuring it threw "Cannot destructure property 'exitCode' from
		// null or undefined", which took close_agent_tab out entirely the moment
		// this shipped: every close returned that error and left the window open.
		// Every other call site in this package already reads `.exitCode ?? 1`.
		const exitCode = check.exitCode ?? 1;
		if (exitCode !== 0) {
			pidGone = true;
			break;
		}
		await Bun.sleep(200);
	}

	if (pidGone) return true;

	// SIGTERM didn't take it — escalate to SIGKILL
	spawnSync({
		name: "scope-kill:systemctl-kill-9",
		command: ["systemctl", "--user", "kill", "-s", "SIGKILL", scopeUnit],
		timeoutMs: 5000,
	});

	await Bun.sleep(500);

	const finalCheck = spawnSync({
		name: "scope-kill:pid-probe-final",
		command: ["kill", "-0", String(pid)],
		timeoutMs: 1000,
	});

	return finalCheck.exitCode !== 0;
}
