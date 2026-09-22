/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Shared load + shortfall-report helpers for the restore-fleet-*-tails bootstrap
 * paths. Closes the silent-skip disease (Task #53): a session whose state
 * failed to load (a DB error mid crash-recovery) used to be swallowed by
 * `.catch(() => null)` and skipped with NO record, so tail restoration reported
 * success having restored nothing for that session — its lanes' streams never
 * reached the dashboard and nothing anywhere said why. That is the
 * unrecorded-failure class `friction-is-a-stop-condition` names: the component
 * knew why it failed and only RETURNED null, destroying the reason in transit.
 *
 * Two helpers, used by both the pi and codex restore paths (the two that read
 * daemon-local session-state — claude-tails fetches from scala-agents instead,
 * a different shape):
 *  - loadTailableSessionState: loadSessionState that EMITS a durable event-log
 *    row on failure (session + real error) instead of a bare null.
 *  - reportTailRestoreOutcome: emits a shortfall when sessions were skipped, so
 *    a partial restore is NAMED (restored count + skipped count), not reported
 *    as a clean pass. The daemon.ts caller ignores these functions' return
 *    value, so "fail loud" MUST be the emit — there is no other channel.
 *
 * `load` and `emit` are injectable so the emit-on-failure contract is unit-
 * testable without a DB: the test asserts the OBSERVABLE outcome (the emit
 * fired with the session + error), not that a function was called.
 */

import { recordEvent } from "@teamscala/event-log/record-event";
import { createLogger } from "@teamscala/logger/creator";
import { loadSessionState } from "../session-daemon/load-save.ts";
import type { SessionStateConfig } from "@teamscala/db-validation/registry-schemas/session-state";

const log = createLogger({ service: "cli-session" });

export type FleetTailKind = "pi" | "codex";

/** The event shape `recordEvent` accepts, derived from its own signature so the
 * helper carries no second event type and no separate import path. */
export type RecordEventInput = Parameters<typeof recordEvent>[0];

/** Injectable emit sink — the real wiring passes `recordEvent`; tests pass a
 * spy. Typed by RecordEventInput so the helper carries no second event shape. */
export type EmitEvent = (event: RecordEventInput) => void;

/** Injectable session-state loader — the real wiring passes `loadSessionState`;
 * tests pass a fake loader (incl. one that throws, to exercise the failure path). */
export type SessionStateLoader = (session: string) => Promise<SessionStateConfig>;

/**
 * Load a session's tab state for tail restoration. On failure, EMIT a durable
 * `cli-session.restore-fleet-tails.load-failed` event naming the session + the
 * real error, then return null — the caller still skips the session, but the
 * failure is now RECORDED (queryable via event_log), never destroyed in transit.
 * A session with NO row is not a failure (loadSessionState returns {tabs:[]}),
 * so this only emits for a genuine throw (DB error / connection loss).
 */
export async function loadTailableSessionState(
	session: string,
	kind: FleetTailKind,
	deps: { load?: SessionStateLoader; emit?: EmitEvent } = {},
): Promise<SessionStateConfig | null> {
	const load = deps.load ?? loadSessionState;
	const emit = deps.emit ?? recordEvent;
	try {
		return await load(session);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.warn(
			`[restore-fleet-${kind}-tails] session-state load failed for '${session}': ${error}`,
		);
		emit({
			kind: "cli-session.restore-fleet-tails.load-failed",
			payload: { kind, session, error },
		});
		return null;
	}
}

/**
 * Report the outcome of a tail-restore pass. Emits a shortfall event when one or
 * more sessions were skipped (their state failed to load), so a partial restore
 * is loud — `restored` alone read as success while sessions went un-tailed. No
 * emit when nothing was skipped (a clean pass, or a no-op with no lanes to tail).
 */
export function reportTailRestoreOutcome(
	kind: FleetTailKind,
	restored: number,
	sessionsSkipped: number,
	deps: { emit?: EmitEvent } = {},
): void {
	const emit = deps.emit ?? recordEvent;
	if (sessionsSkipped > 0) {
		log.warn(
			`[restore-fleet-${kind}-tails] partial: restored ${restored} tail(s), ${sessionsSkipped} session(s) skipped (state load failed — see load-failed events)`,
		);
		emit({
			kind: "cli-session.restore-fleet-tails.shortfall",
			payload: { kind, restored, sessionsSkipped },
		});
	} else if (restored > 0) {
		log.info(`[restore-fleet-${kind}-tails] restored ${restored} tail(s)`);
	}
}
