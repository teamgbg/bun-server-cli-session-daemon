/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Internal daemon helper — sweeps every live tmux session and converges it on
 * two invariants: the session has its picker home window, and its tabs[] row
 * matches the live window list. Called by the daemon's `@teamscala/watchdog`
 * probe on a periodic interval.
 *
 * The picker-window half is why this is a CONVERGENT RECONCILER and not a
 * one-shot (liveness-by-capability-not-process-existence). ensurePickerHomeWindow
 * used to be reachable ONLY from the /rpc/restore route, so the picker existed
 * because a restore had happened to create it — never because anything held it
 * true. Close that window, or let its process exit, and no code path ever
 * brought it back: the session ran picker-less until the next restore. Observed
 * 2026-07-26 on the `joe` session, which had nine windows and no picker.
 *
 * Re-ensuring here makes the operator's stated invariant — a session can never
 * be without its picker — hold by construction rather than by history. It is
 * idempotent: ensurePickerHomeWindow returns immediately when the window is
 * already present, so the steady-state cost is one listWindows call that this
 * sweep already performs.
 */

import { getAppLogger } from "@teamscala/logger/app-loggers";
import { exponentialBackoff } from "@teamscala/retry/backoff";
import { withRetry } from "@teamscala/retry/with-retry";
import { listWindows } from "@teamscala/tmux-session/windows";
import { listSessions } from "@teamscala/tmux-session/session/list-sessions";
import { reconcileSessionState } from "./reconcile.ts";
import { ensurePickerHomeWindow } from "./picker-home-window.ts";

export async function reconcileAll(): Promise<number> {
	const logger = getAppLogger();
	const sessions = listSessions();
	let failed = 0;
	for (const session of sessions) {
		// Picker first, and never fatal to the sweep: a session that cannot get
		// its picker back still deserves an accurate tabs[] row, and throwing
		// here would strand every LATER session in the list unreconciled.
		try {
			ensurePickerHomeWindow(session);
		} catch (err) {
			failed += 1;
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error(`picker-ensure-failed: ${session}`, { session, error: errMsg });
		}

		const live = listWindows(session).filter((w) => Boolean(w.name));
		try {
			await withRetry(() => reconcileSessionState(session, live), {
				maxAttempts: 5,
				backoff: exponentialBackoff({ baseMs: 200, maxMs: 10_000 }),
			});
		} catch (err) {
			failed += 1;
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error(`reconcile-failed: ${session}`, { session, error: errMsg });
		}
	}

	return failed > 0 ? 1 : 0;
}
