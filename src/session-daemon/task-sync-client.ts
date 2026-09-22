/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The session-picker's in-process client for the canonical task-sync ORPC —
 * the two task operations a spawn/rename needs: minting a lane's task
 * (createBriefTask) and back-writing a tab rename to its title (renameLaneTask).
 *
 * WHY HERE. `/rpc/spawn` is the SINGLE spawn surface: the operator's own `+`
 * menu AND the fleet's `spawn_agent_tab` both reach it. The fleet path mints its
 * brief into a task BEFORE calling `/rpc/spawn` and carries the `workItemId`;
 * a caller WITHOUT one (the operator opening a tab from the picker) mints HERE
 * so every tab comes into existence with a work_items task — the orphan state is
 * unreachable by construction rather than swept up afterwards
 * (`prevention-over-detection`). The mint calls the SAME createBriefTask the
 * fleet uses, so there is ONE task-creation path, not two
 * (`the-severe-bugs-live-at-seams`).
 *
 * The rename calls renameLaneTask BY SESSION (never pane): a pane outlives the
 * session inside it, so a pane-keyed update would let a dead session's task
 * answer for a live lane (`lane-identity-is-cli-session-id`).
 *
 * No UI or remote service participates: the generated server client executes
 * against the same database-backed procedure catalogue in this process.
 */

import { loadOptionalRegistryConfig } from "@teamscala/db/registry/load-config";
import { getAppLogger } from "@teamscala/logger/app-loggers";
import { getServerClient } from "@teamscala/orpc/server-client-registry";
import * as v from "valibot";

const log = getAppLogger();

/**
 * The standing brief for a lane opened DIRECTLY from the picker (no dispatch
 * brief). It is a truthful, non-empty description — createBriefTask requires one
 * (the brief IS the task's first comment) — so the lane has a durable task from
 * birth rather than an orphan "Lane" row. The operator directs the lane verbally
 * afterwards; the `+` menu spawns with no turn trigger, so this brief lands as
 * context, not as an instruction to "begin work".
 */
export const OPERATOR_LANE_BRIEF =
	"Opened directly from the session picker by the operator. You are a task-bound worker agent — read your workspace context and await the operator's assigned task. Do not delegate, create projects, or assume the orchestrator role. Rename your tab to describe your work when it begins, execute the assigned task through completion, and report through this task's comments.";

/** The config row naming the default project operator-initiated tabs land under. */
const OPERATOR_LANES_PROJECT_SCHEMA = v.object({
	project_id: v.pipe(v.string(), v.minLength(1)),
});

/**
 * The default project for a tab opened with no specific project — resolves the
 * `config/operator-lanes-project` row. A lane with no project is exactly what
 * produced unattributable "Lane" rows, so an operator tab with no chosen project
 * lands here rather than free-floating. Null when the row is absent (the spawn
 * then mints under no parent, best-effort — the row is durable once set).
 */
export async function defaultOperatorProjectId(): Promise<string> {
	try {
		const cfg = await loadOptionalRegistryConfig(
			"config",
			"operator-lanes-project",
			OPERATOR_LANES_PROJECT_SCHEMA,
		);
		if (!cfg?.project_id) {
			throw new Error("config/operator-lanes-project is required");
		}
		return cfg.project_id;
	} catch (err) {
		throw new Error(
			`operator picker task parent resolve failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}


/**
 * Mint a lane's task through the in-process `fn.taskSync.createBriefTask` — the
 * `name` becomes the task title, the `description` becomes the task's first
 * comment (the brief), and both returned identities ride the spawn emission.
 *
 * THROWS on any failure: a procedure error or missing identity refuses spawn
 * — a lane that cannot be given a durable task must not start, never an orphan
 * left behind (`protective-layers-fail-explicitly`). Returns the work_item_id
 * that rides the spawn as `workItemId`.
 */
export interface MintedLaneTask {
	workItemId: string;
	launchCommentId: string;
}

export type TaskSyncClient = {
	fn: {
		taskSync: {
			createBriefTask(input: {
				name: string;
				description: string;
				parent_id: string;
			}): Promise<{ work_item_id: string; comment_id: string }>;
			renameLaneTask(input: {
				lane_session: string;
				title: string;
			}): Promise<{ updated: boolean }>;
		};
	};
};

export async function mintLaneTask(args: {
	name: string;
	description: string;
	parentId: string;
}, clientOverride?: TaskSyncClient): Promise<MintedLaneTask> {
	const client = clientOverride ?? (await getServerClient()) as unknown as TaskSyncClient;
	const created = await client.fn.taskSync.createBriefTask({
		name: args.name,
		description: args.description,
		parent_id: args.parentId,
	});
	const workItemId = created.work_item_id;
	const launchCommentId = created.comment_id;
	if (!workItemId || !launchCommentId) {
		throw new Error("task-sync did not return the task and first-comment identities");
	}
	return { workItemId, launchCommentId };
}

/**
 * Back-write a tab rename to its bound task's title through the in-process
 * `fn.taskSync.renameLaneTask`, by CLI SESSION id (never pane). Fire-and-forget
 * semantics: the tmux window was already renamed by the caller, so a DB miss
 * never fails the rename — it logs and the title converges on the next rename.
 * Returns whether the task title was confirmed updated.
 */
export async function renameLaneTaskTitle(args: {
	session: string;
	title: string;
}, clientOverride?: TaskSyncClient): Promise<boolean> {
	try {
		const client = clientOverride ?? (await getServerClient()) as unknown as TaskSyncClient;
		const outcome = await client.fn.taskSync.renameLaneTask({
			lane_session: args.session,
			title: args.title,
		});
		return outcome.updated === true;
	} catch (error) {
		log.warn("[task-sync-client] rename was not confirmed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
