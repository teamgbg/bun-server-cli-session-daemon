/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Keeps the daemon's own service identity out of the tmux server environment.
 *
 * The session-picker daemon is a PM2 service, so service-runtime injects
 * SERVICE_SLUG and PORT to boot it. When the daemon starts the tmux server,
 * that server inherits the daemon's whole environment and hands it to every
 * pane it will ever spawn — so the daemon's identity becomes ambient across
 * the entire host, indefinitely, for processes that have nothing to do with
 * session-picker.
 *
 * That is only a curiosity until a pane launches a SERVICE. service-runtime
 * reads exactly these two variables to decide what it is and where it listens,
 * so a service started from an inheriting pane boots wearing session-picker's
 * identity instead of its own.
 *
 * Both variables have now done this, and the second is the reason this file
 * exists rather than another `unset` at one spawn site:
 *
 *   SERVICE_SLUG (2026-06-26) — loga booted with a session-picker slug and
 *   crash-looped. Loud, and fixed at the time by stripping SERVICE_SLUG from
 *   the spawn command.
 *
 *   PORT (2026-07-31) — scala-quiz booted on 3021, session-picker's port,
 *   while every registry row said 5203. Both processes bound 3021, SO_REUSEPORT
 *   load-balanced between them, and roughly half of every RPC call to the
 *   session daemon landed in a quiz service that has no /rpc routes. The daemon
 *   looked healthy the whole time — it WAS healthy, it just only received half
 *   its traffic.
 *
 *   SCALA_ORCH_SESSION_ID (2026-07-31, third instance) — the tmux server
 *   carried the orchestrator identity of whatever pane session-picker was
 *   launched from, and every pane that never overrode it reported THAT pane's
 *   id as its own. Measured: panes %152/%150/%17 all carried
 *   SCALA_ORCH_SESSION_ID=tmux:%234 while their TMUX_PANE was correct and
 *   distinct, and %234 was not even live — one shared, stale identity across
 *   three unrelated panes. The turn-end stop gate fail-opened on it, and the
 *   gateway routed cross-pane traffic to the wrong pane. This is a different
 *   KIND of identity from SERVICE_SLUG/PORT (it identifies a pane to the fleet,
 *   not a service to service-runtime) but the SAME leak, so it lives in the
 *   same scrub. A pane's identity is derived from its own pane id (TMUX_PANE,
 *   set per-pane by tmux), never inherited — the derivation lives in
 *   `resolveOrchestratorIdentity` (mcp-multi-session), paired with this scrub.
 *
 * The 2026-06-26 fix stripped one variable at one call site, which left its
 * sibling live and the class open. The lesson is that the leak is not a
 * property of any spawn path — it is a property of the tmux SERVER's
 * environment, which is where this scrub operates. Removing the variables at
 * the source means every pane is clean regardless of how it was created,
 * including panes created by tmux itself (`split-window`, a `+` menu entry, a
 * hook) that never pass through the daemon's spawn code at all.
 *
 * SESSION_PICKER_URL is deliberately NOT scrubbed: it points every pane at the
 * daemon, which is correct and is what `getSessionPickerUrl` expects to find.
 * The set below is only the variables that change what a booted service IS.
 */
/**
 * Remove the daemon's leaked identity (service + orchestrator) from the tmux
 * server environment.
 *
 * Returns the variables it actually removed, so the caller can log a real
 * event rather than an unconditional "scrubbed" line. Idempotent — a clean
 * server environment returns [] and issues no tmux commands.
 *
 * Note this scrubs the environment INHERITED BY FUTURE panes; it does not
 * reach into panes that already exist. Those are the operator's live shells,
 * and rewriting a running shell's environment out from under it is not
 * something a boot-time policy should do. New panes are clean, which is the
 * property that matters — a service is launched by a command in a new pane.
 */

import { run } from "@teamscala/tmux-session/command-runner";

/**
 * The variables service-runtime reads to establish service identity. A pane
 * inheriting one of these can boot a service as the wrong service (SERVICE_SLUG)
 * or onto another service's port (PORT). Extend this set if service-runtime
 * ever grows a third identity input — that is the whole contract.
 */
export const SERVICE_IDENTITY_VARS = ["SERVICE_SLUG", "PORT"] as const;

/**
 * The variables that identify a pane/process to the fleet (read by the gateway,
 * the channel relay, MCP config substitution). A pane inheriting a stale
 * SCALA_ORCH_SESSION_ID reports ANOTHER pane's identity as its own — the third
 * instance of the leak class (2026-07-31). Distinct from SERVICE_IDENTITY_VARS
 * (a pane's identity is derived from TMUX_PANE, not inherited — see
 * `resolveOrchestratorIdentity`), but the leak mechanism is identical so it is
 * scrubbed in the same pass. Extend if the fleet ever grows a second
 * orchestrator-identity env input.
 */
export const ORCHESTRATOR_IDENTITY_VARS = ["SCALA_ORCH_SESSION_ID"] as const;

/** Read the tmux global environment as raw `NAME=value` lines. */
function readGlobalEnvironment(): string[] {
	const r = run(["show-environment", "-g"]);
	if (r.exitCode !== 0) return [];
	return r.stdout.toString().split("\n");
}

/**
 * Which identity variables are currently present in the tmux server environment.
 * Split out so the scrub is observable — reporting "removed nothing" and
 * "could not read the environment" as the same silent success is how a broken
 * scrub would look exactly like a clean one.
 */
export function leakedIdentityVars(lines: string[] = readGlobalEnvironment()): string[] {
	const allVars = [...SERVICE_IDENTITY_VARS, ...ORCHESTRATOR_IDENTITY_VARS];
	return allVars.filter((name) =>
		lines.some((line) => line.startsWith(`${name}=`)),
	);
}

export function scrubTmuxServerIdentityEnv(): string[] {
	const leaked = leakedIdentityVars();
	const removed: string[] = [];
	for (const name of leaked) {
		// -u unsets the variable; -g scopes it to the server-wide environment
		// every future pane inherits.
		if (run(["set-environment", "-gu", name]).exitCode === 0) removed.push(name);
	}
	return removed;
}
