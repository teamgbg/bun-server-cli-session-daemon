/**
 * @system cli-session
 * @status handwritten
 * @edit the spawn route body — policy, task minting, and the emit
 *
 * /rpc/spawn and /rpc/fleet-spawn are the same handler under two policies, and
 * that handler owns a whole story of its own: authenticate the caller, resolve
 * the session, mint the task/comment pair an operator launch does not bring,
 * then emit. It lived as an 89-line closure inside registerDaemonRoutes, which
 * made the route table unreadable and the file unsplittable.
 *
 * The operator token and the two canonical-id validators come with it: nothing
 * else uses them.
 */
import { getAppLogger } from "@teamscala/logger/app-loggers";
import {
	OPERATOR_TOKEN_HEADER,
	mintOperatorToken,
} from "@teamscala/session-contracts/operator-spawn-token";
import type { Context } from "hono";

import { emitSpawnCommand } from "./picker-command-producer.ts";
import { getCachedActiveOptions } from "./picker-data.ts";
import { parseSpawnRequest } from "./spawn-request-schema.ts";
import { spawnOptsFromSpawnRequest } from "./spawn-request.ts";
import { resolveSpawnRoutePolicy, type SpawnRouteKind } from "./spawn-route-policy.ts";
import {
	defaultOperatorProjectId,
	mintLaneTask,
	OPERATOR_LANE_BRIEF,
} from "./task-sync-client.ts";

/**
 * The operator-picker token for THIS daemon process.
 *
 * Minted once at module load and held in memory, so the daemon never re-reads
 * its own file — a tampered file cannot change what it expects, and the value
 * dies with the process rather than granting a previous boot's privileges.
 */
export const OPERATOR_SPAWN_TOKEN: string | null = await mintOperatorToken().catch(() => {
	// Could not write the token: the operator route refuses authentication.
	// The fleet route remains independently available and policy-bound.
	return null;
});

export function validateCanonicalWorkItem(
	workItemId: string | undefined,
): { ok: true; workItemId: string } | { ok: false; error: string } {
	if (!workItemId?.trim()) return { ok: false, error: "spawn requires a canonical workItemId" };
	return { ok: true, workItemId };
}

export function validateLaunchCommentId(
	launchCommentId: string | undefined,
): { ok: true; launchCommentId: string } | { ok: false; error: string } {
	if (!launchCommentId?.trim())
		return { ok: false, error: "spawn requires a canonical launchCommentId" };
	return { ok: true, launchCommentId };
}

/** Serve one spawn request under the policy its route selects. */
export async function handleSpawn(kind: SpawnRouteKind, c: Context) {
	const logger = getAppLogger();
	const parsedRequest = parseSpawnRequest(kind, await c.req.json().catch(() => ({})));
	if (!parsedRequest.ok) {
		return c.json({ ok: false, error: parsedRequest.error }, 400);
	}
	const request = parsedRequest.request;
	const body = request.body;
	const slug = body.slug ?? c.req.query("slug");
	const routePolicy = resolveSpawnRoutePolicy(
		kind,
		{
			operatorToken: c.req.header(OPERATOR_TOKEN_HEADER),
			requestedBy: c.req.header("x-requested-by"),
			lanePane: c.req.header("x-lane-pane"),
		},
		OPERATOR_SPAWN_TOKEN,
	);
	if (!routePolicy.ok) {
		return c.json({ ok: false, error: routePolicy.error }, routePolicy.status);
	}
	const { enforceRuntimePolicy, requestedBy } = routePolicy;
	const fleetRequest = request.kind === "fleet" ? request.body : null;
	const freshFleetLane = fleetRequest?.mode === "fresh";
	let session = body.session ?? c.req.query("session");
	// Fleet dispatch: resolve the daemon's own session (the fleet doesn't know it).
	if (!session && fleetRequest) {
		const { resolvePrimaryTmuxSession } = await import("./resolve-primary-tmux-session.ts");
		session = (await resolvePrimaryTmuxSession()) ?? undefined;
	}
	if (!slug || !session) {
		return c.json({ ok: false, error: "slug and session are required" }, 400);
	}
	try {
		// Body wins, query falls back; windowName optional → pre-name.
		const opts = spawnOptsFromSpawnRequest(body, c.req.query());
		// Fleet dispatch: seed the session-id (not resume) so the lane's
		// transcript is keyed by the fleet's own run id whatever the CLI.
		if (freshFleetLane && fleetRequest?.sessionID) {
			opts.seedId = fleetRequest.sessionID;
		}
		// Route authentication above makes attribution and policy immutable. A
		// fleet launch arrives with its task + first comment already committed. An
		// operator picker launch deliberately has neither, so mint the same atomic
		// task/comment pair here before emitting the host command. This preserves
		// direct operator spawning while making an orphan CLI unconstructible.
		const suppliedWorkItemId =
			fleetRequest?.workItemId ?? (body as { workItemId?: string }).workItemId;
		const suppliedLaunchCommentId =
			fleetRequest?.launchCommentId ?? (body as { launchCommentId?: string }).launchCommentId;
		const minted =
			kind === "operator" && (!suppliedWorkItemId || !suppliedLaunchCommentId)
				? await mintLaneTask({
						name:
							(await getCachedActiveOptions()).find((option) => option.slug === slug)?.label ??
							`Operator ${slug}`,
						description: OPERATOR_LANE_BRIEF,
						parentId: await defaultOperatorProjectId(),
					})
				: null;
		const assignment = validateCanonicalWorkItem(minted?.workItemId ?? suppliedWorkItemId);
		if (!assignment.ok) return c.json({ ok: false, error: assignment.error }, 400);
		const launchComment = validateLaunchCommentId(
			minted?.launchCommentId ?? suppliedLaunchCommentId,
		);
		if (!launchComment.ok) return c.json({ ok: false, error: launchComment.error }, 400);
		const workItemId = assignment.workItemId;
		const { command_id } = await emitSpawnCommand({
			slug,
			tmuxSession: session,
			focus: opts.focus,
			resumeId: opts.resumeId,
			windowName: opts.windowName,
			seedId: opts.seedId,
			cwd: opts.cwd,
			requestedBy,
			workItemId,
			launchCommentId: launchComment.launchCommentId,
			idempotencyKey: opts.idempotencyKey,
			freshSession: freshFleetLane,
		});
		return c.json({ ok: true, command_id, status: "pending" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`${kind} spawn failed`, { slug, session, error: msg });
		return c.json({ ok: false, error: msg }, 500);
	}
}
