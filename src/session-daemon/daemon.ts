/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Session-picker daemon lifecycle. Boot opens NOTHING — no tmux sessions, no
 * CLI tabs. Restore is operator-triggered by the picker's session-select action
 * (POST /rpc/restore ensures the shell + reopens tabs, idempotent), never
 * automatic — so no CLI is ever spawned into a session nobody is attached to.
 * Across the process lifetime the daemon reacts to database and tmux lifecycle
 * emissions. It never polls: missed lifecycle work remains visible as durable
 * state for the owning consumer instead of being reconstructed by a sweep.
 *
 * Called from the boot hook registered in mount.ts.
 */

import { getAppLogger } from "@teamscala/logger/app-loggers";
import { ensureWindowSizeLatest } from "./sizing.ts";
import { scrubTmuxServerIdentityEnv } from "./tmux-env-hygiene.ts";
import { registerShutdownPhase, installSignalHandlers } from "@teamscala/signal-shutdown/register";
import { configure as configureEventLog } from "@teamscala/event-log/configure";
import { getPrisma } from "@teamscala/db/prisma-registry";
import { startPickerEventBridge, stopPickerEventBridge } from "./picker-events.ts";

export async function startSessionPickerDaemon(): Promise<void> {
	const logger = getAppLogger();

	logger.info("daemon: ready (boot opens nothing; restore is picker-on-select)");

	// Own the window-size policy: keep `window-size=latest` so the operator's
	// active device sets the window size and a stale tiny client (an old
	// 49-row phone/tablet SSH) can never clamp every window the way `smallest`
	// did. Promotes the operator's interim manual fix to daemon-enforced.
	try {
		const corrected = ensureWindowSizeLatest();
		if (corrected) logger.info("daemon: window-size corrected to latest");
	} catch (err) {
		logger.warn("daemon: window-size ensure failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Keep the daemon's own service identity out of the tmux server environment.
	// The tmux server inherits this process's env and hands it to every pane it
	// spawns, so SERVICE_SLUG/PORT become ambient host-wide and a service
	// launched from any pane boots wearing session-picker's identity — loga
	// crash-looped on the slug (2026-06-26) and scala-quiz bound port 3021 on
	// the port (2026-07-31). Runs at boot so the policy is daemon-owned and
	// self-healing rather than a one-shot manual fix that drifts back.
	try {
		const removed = scrubTmuxServerIdentityEnv();
		if (removed.length > 0) {
			logger.info(`daemon: scrubbed leaked identity from tmux server env: ${removed.join(", ")}`);
		}
	} catch (err) {
		logger.warn("daemon: tmux env scrub failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Heal any session-state row whose stored `command` still carries a resolved
	// secret_env value. spawn/adopt store the command TEMPLATE; the materialised
	// form prepends resolved `secret_env` values as `export SECRET='literal';`,
	// and the row is type `config` (not `secret`), so a literal there is returned
	// in cleartext by /rpc/closed-tabs (credentials-only-in-secret-rows). This
	// pass rewrites such rows to the template + is idempotent (a clean row writes
	// nothing). Best-effort: a failure never blocks boot — the write sites are
	// already safe, this only rewrites rows that still carry a literal.
	try {
		const { scrubStoredCommandSecrets } = await import("./resolve-and-query.ts");
		const { rowsScrubbed } = await scrubStoredCommandSecrets();
		if (rowsScrubbed > 0) {
			logger.info(`daemon: scrubbed materialised secret from ${rowsScrubbed} session-state row(s)`);
		}
	} catch (err) {
		logger.warn("daemon: stored-command secret scrub failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Fold legacy name-keyed session-state rows onto the immutable project-id
	// keying (developer-seat-map). Idempotent + convergent: a seat that is down
	// retries on the next boot. Best-effort — never blocks boot.
	try {
		const { rekeySessionStateRows } = await import("./rekey-session-state.ts");
		const { rekeyed } = await rekeySessionStateRows();
		if (rekeyed > 0) {
			logger.info(`daemon: rekeyed ${rekeyed} session-state row(s) to project-id keys`);
		}
	} catch (err) {
		logger.warn("daemon: session-state rekey failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Configure durable event-log with the daemon's Prisma client so
	// /rpc/record-event (login telemetry from the stateless picker) actually
	// writes to event_log. Best-effort: a failure leaves recordEvent as a
	// no-op (login never depends on telemetry).
	try {
		configureEventLog({ prisma: getPrisma() });
		logger.info("daemon: event-log configured");
	} catch (err) {
		logger.warn("daemon: event-log configure failed (recordEvent stays no-op)", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	await startPickerEventBridge();
	logger.info("daemon: picker database-emission bridge active");
	registerShutdownPhase("session-picker:stop-database-emissions", {
		order: 9,
		timeoutMs: 5_000,
		handler: async () => {
			await stopPickerEventBridge();
		},
	});

	installSignalHandlers();

	logger.info("daemon: running");
}
