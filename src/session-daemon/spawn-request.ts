/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Pure derivation of spawn options from an HTTP /rpc/spawn request shape.
 * Extracted from the route handler so the body→opts forwarding contract is
 * unit-testable without booting the Hono app (and its DB/tmux imports).
 *
 * Pre-naming contract: `windowName` forwarded here is what lets a lane open
 * already-named at spawn (no generic `cc-glm52` flash then self-rename). The
 * override flows route → spawnOptionInSession → spawnTmuxWindow verbatim
 * (numbering off, still uniquified against live windows). See doctrine:
 * `session-picker-spawn-and-reconcile-via-daemon`.
 */

/**
 * Body wins, query string falls back. `focus` defaults to true (matches the
 * prior route behaviour); `resumeId`/`windowName`/`cwd` are `undefined` when
 * absent so option-spawn's "no override" branches still fire.
 */
/**
 * The task title for a spawn that mints its own work_items task (no caller
 * `workItemId`). The spawner MUST name the lane (`lanes-named-by-the-spawner`):
 * the work name becomes the task title, and a 'Lane' sentinel is spawn debris an
 * orchestrator cannot attribute — rejected here so a mint never writes it. A
 * caller's explicit windowName wins; otherwise the option's human label (its
 * `window_name`), then its menu label; the bare slug (a machine key) is the last
 * resort, never empty.
 *
 * Pure over injected option fields so the precedence is unit-testable without a
 * DB (the route resolves the option row and feeds its fields in).
 */

export interface SpawnRequestOpts {
	focus: boolean;
	resumeId?: string;
	windowName?: string;
	/**
	 * Override the option's cwd. Used by the fleet dispatch to spawn a Claude
	 * worker tab in the run's workdir (so the transcript JSONL lands at
	 * ~/.claude/projects/<escaped-workdir>/<id>.jsonl, where the tail finds it).
	 * Forwarded to spawnOptionInSession's opts.cwd → spawnTmuxWindow's cwdOverride.
	 */
	cwd?: string;
	/**
	 * Fleet dispatch only: mint the lane's session id rather than resume one, so
	 * the transcript is keyed by the fleet's own run id. Set by the spawn route
	 * after this shape is derived, which is why it is optional here — declaring
	 * it keeps that assignment type-checked instead of silently widening.
	 */
	seedId?: string;
	/**
	 * Caller-supplied idempotency key. A retry carries the same key, and the
	 * daemon returns the existing lane instead of creating a duplicate. Forwarded
	 * to spawnOptionInSession, which performs the live-lane dedup.
	 */
	idempotencyKey?: string;
}

export function deriveSpawnTaskName(args: {
	windowName?: string;
	optionWindowName?: string;
	optionLabel?: string;
	slug: string;
}): string {
	const wn = args.windowName?.trim();
	if (wn && wn.toLowerCase() !== "lane") return wn;
	const name = args.optionWindowName?.trim() || args.optionLabel?.trim();
	return name && name.toLowerCase() !== "lane" ? name : args.slug;
}

export function spawnOptsFromSpawnRequest(
	body: {
		focus?: boolean;
		resumeId?: string;
		windowName?: string;
		cwd?: string;
		idempotencyKey?: string;
	},
	query: {
		focus?: string | null;
		resumeId?: string | null;
		windowName?: string | null;
		cwd?: string | null;
		idempotencyKey?: string | null;
	},
): SpawnRequestOpts {
	return {
		focus: body.focus ?? query.focus === "true",
		resumeId: body.resumeId ?? query.resumeId ?? undefined,
		windowName: body.windowName ?? query.windowName ?? undefined,
		cwd: body.cwd ?? query.cwd ?? undefined,
		idempotencyKey: body.idempotencyKey ?? query.idempotencyKey ?? undefined,
	};
}
