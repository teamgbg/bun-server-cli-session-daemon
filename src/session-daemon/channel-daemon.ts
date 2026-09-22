/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Starts a lane's per-session channel daemon from the SPAWN path rather than
 * from a CLI hook. The daemon is what makes a pane reachable by
 * `send_orchestrator_message`; without it the channel reports `relay-detect:
 * not-found` and every message emitted to that pane is confirmed and unread.
 */
/**
 * Start the pane's channel daemon, detached, if its CLI needs the picker to do
 * it. Never throws and never blocks the spawn: a lane that comes up without its
 * channel is degraded (unreachable by the orchestrator) but working, and
 * failing the spawn over it would trade a reachable-lane problem for a no-lane
 * problem.
 *
 * The failure IS recorded rather than swallowed, because an unreachable lane is
 * indistinguishable from a compliant one at every surface that matters — the
 * orchestrator sends, the channel confirms, and nothing arrives.
 */

import { spawn } from "@teamscala/os/spawn/spawn";
import { getAppLogger } from "@teamscala/logger/app-loggers";
import { queryActiveOptions } from "./query-options.ts";
import { cliKindForGroup } from "./cli-kind.ts";

const log = getAppLogger();

type ChannelDaemonLogger = Pick<ReturnType<typeof getAppLogger>, "info" | "warn">;
type ChannelDaemonDeps = {
	spawn?: typeof spawn;
	log?: ChannelDaemonLogger;
};

/**
 * CLI kinds whose channel daemon the PICKER must start, because the CLI itself
 * never fires the SessionStart hook that would otherwise do it.
 *
 * Claude Code is deliberately absent: it fires SessionStart, its daemon starts,
 * and its panes report `relay-detect: found`. Starting it twice from here would
 * be a second surface for a thing that already works.
 */
const PICKER_STARTED_CHANNEL_DAEMON: Readonly<Record<string, string>> = {};

export function startChannelDaemonDetached(input: {
	cliKind: string;
	paneId: string | undefined;
	sessionId: string | null;
}, deps: ChannelDaemonDeps = {}): void {
	const spawnProcess = deps.spawn ?? spawn;
	const logger = deps.log ?? log;
	const bin = PICKER_STARTED_CHANNEL_DAEMON[input.cliKind];
	if (!bin) return;
	// The daemon resolves its own pane from TMUX_PANE. Without one it would
	// subscribe on behalf of no pane, which is the same silent-unreachable state
	// as no daemon at all — so say so rather than starting a useless process.
	if (!input.paneId) {
		logger.warn(
			`[channel-daemon] ${input.cliKind} lane has no pane id — channel daemon NOT started, the lane will be UNREACHABLE by send_orchestrator_message`,
		);
		return;
	}
	// The daemon keys its subscription on the lane's session id. Without one it
	// would subscribe to nothing, so skip rather than start a daemon that cannot
	// route — and say so, since this is the same silent-unreachable state.
	if (!input.sessionId) {
		logger.warn(
			`[channel-daemon] ${input.cliKind} pane ${input.paneId} has no seeded session id — channel daemon NOT started, the lane will be unreachable by send_orchestrator_message`,
		);
		return;
	}
	// Same envelope the CLI hook would have delivered on stdin, so the daemon's
	// entrypoint is unchanged and there is one implementation of what it does.
	const payload = JSON.stringify({
		session_id: input.sessionId,
		cli_kind: input.cliKind,
	});
	// Fire-and-forget: the daemon outlives this call by design, so the spawn is
	// never awaited. The rejection handler is what keeps a failed start from
	// becoming an unhandled rejection AND from being invisible.
	spawnProcess({
		name: `channel-daemon:${input.cliKind}`,
		command: ["bash", "-c", `printf '%s' ${shellQuote(payload)} | ${bin}`],
		env: { ...process.env, TMUX_PANE: input.paneId },
	})
		.then(() => {
			logger.info(
				`[channel-daemon] started ${bin} for ${input.cliKind} pane ${input.paneId} session=${input.sessionId}`,
			);
		})
		.catch((err: unknown) => {
			logger.warn(
				`[channel-daemon] failed to start ${bin} for pane ${input.paneId}: ${String(err)} — lane is spawned but UNREACHABLE by the channel`,
			);
		});
}

/**
 * Capture-path entrypoint: resolve the CLI kind from the lane's picker option,
 * then start the daemon. Used by the captured-lane adoption path, where the
 * session id only becomes known after the CLI mints it — a capture CLI cannot
 * be seeded, so there is no id at spawn.
 *
 * Resolves the option's cli_id-derived family key rather than matching on the
 * option slug, because slugs multiply per model while the family is the CLI
 * itself.
 */
export async function startChannelDaemonForOption(
	optionSlug: string | undefined,
	paneId: string | undefined,
	sessionId: string,
): Promise<void> {
	if (!optionSlug) return;
	let familyKey: string | undefined;
	try {
		const opt = (await queryActiveOptions()).find((o) => o.slug === optionSlug);
		familyKey = opt?.family?.key;
	} catch {
		// An unresolvable option is not worth failing adoption over; the lane is
		// already adopted by the time this runs. It IS worth saying, because the
		// consequence is an unreachable lane.
		log.warn(
			`[channel-daemon] could not resolve option "${optionSlug}" — channel daemon NOT started, lane may be UNREACHABLE`,
		);
		return;
	}
	if (!familyKey) return;
	startChannelDaemonDetached({
		cliKind: cliKindForGroup(familyKey),
		paneId: paneId ? `tmux:${paneId}` : undefined,
		sessionId,
	});
}

/** Single-quote for `bash -c`, escaping embedded single quotes. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
