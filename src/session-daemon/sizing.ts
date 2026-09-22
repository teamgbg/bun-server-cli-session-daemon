/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Window-sizing policy for the session-picker daemon. The daemon keeps
 * `window-size=latest` so the operator's ACTIVE (most-recently-active) device
 * sets window size — a stale tiny client (an old 49-row phone/tablet SSH still
 * nominally attached) can never clamp every window the way `window-size=smallest`
 * did. It also surfaces those stale clamping clients so the operator can detach
 * them. This promotes the operator's interim manual fix (`set-option -g
 * window-size latest`) to a daemon-owned, self-healing policy.
 */
/**
 * Clients that would clamp the operator's bigger devices under
 * `window-size=smallest` — the live bug: a 49-row stale tablet halved every
 * window against an 87-row desktop. DETECTION is SET-RELATIVE + activity-aware:
 * a client clamps when it is SHORTER than the tallest attached client AND it is
 * NOT the most-recently-active one (the operator's current focus — which under
 * `latest` sets the size and is never itself a clamp candidate). A single
 * attached client can never clamp. Under the daemon's `latest` policy the active
 * device is protected regardless; these are the stale small clients surfaced for
 * detach so they stop competing for the active-device slot.
 */

import { run } from "@teamscala/tmux-session/command-runner";
import type { AttachedClient } from "./picker-data.ts";

/** Read the global tmux `window-size` option value (e.g. "latest", "smallest"). */
export function readWindowSize(): string {
	const r = run(["show-options", "-g", "-v", "window-size"]);
	if (r.exitCode !== 0) return "";
	return r.stdout.toString().trim();
}

/**
 * Ensure `window-size=latest` (the active device wins; a stale tiny client can't
 * clamp). Returns true if it corrected a drifted/smallest setting. Idempotent —
 * a no-op when already `latest`. Called at daemon boot so the daemon owns the
 * policy permanently rather than relying on a one-shot manual fix that can drift.
 */
export function ensureWindowSizeLatest(): boolean {
	if (readWindowSize() === "latest") return false;
	const r = run(["set-option", "-g", "window-size", "latest"]);
	return r.exitCode === 0;
}

export function detectClampingClients(clients: AttachedClient[]): AttachedClient[] {
	if (clients.length < 2) return [];
	const maxHeight = Math.max(...clients.map((c) => c.height));
	const maxActivity = Math.max(...clients.map((c) => c.activity));
	return clients.filter((c) => c.height > 0 && c.height < maxHeight && c.activity < maxActivity);
}

export interface SizingInfo {
	/** Current tmux `window-size` value (the daemon keeps it `latest`). */
	windowSize: string;
	/** Stale size-clamping clients across all sessions (detach recommended). */
	clampingClients: AttachedClient[];
}

/** Build the sizing summary the picker renders: current window-size + any stale
 * clamping clients. `allClients` is every attached client across all live
 * sessions (the picker flattens them for the clamp scan). */
export function buildSizingInfo(allClients: AttachedClient[]): SizingInfo {
	return {
		windowSize: readWindowSize(),
		clampingClients: detectClampingClients(allClients),
	};
}
