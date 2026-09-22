// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import {
	mintLaneTask,
	OPERATOR_LANE_BRIEF,
	renameLaneTaskTitle,
	type TaskSyncClient,
} from "./task-sync-client";

test("direct picker launches identify the task-bound worker role", () => {
	expect(OPERATOR_LANE_BRIEF).toContain("worker agent");
	expect(OPERATOR_LANE_BRIEF).not.toContain("orchestrator lane");
	expect(OPERATOR_LANE_BRIEF).toContain("assigned task");
});

test("mints the task and first comment through the in-process ORPC client", async () => {
	const client: TaskSyncClient = {
		fn: {
			taskSync: {
				createBriefTask: async (input) => {
					expect(input).toEqual({
						name: "Fleet Bootstrap E2E",
						description: "Prove one round trip",
						parent_id: "project-1",
					});
					return { work_item_id: "task-1", comment_id: "comment-1" };
				},
				renameLaneTask: async () => ({ updated: false }),
			},
		},
	};
	expect(
		await mintLaneTask(
			{
				name: "Fleet Bootstrap E2E",
				description: "Prove one round trip",
				parentId: "project-1",
			},
			client,
		),
	).toEqual({ workItemId: "task-1", launchCommentId: "comment-1" });
});

test("renames through the same in-process ORPC client", async () => {
	const client: TaskSyncClient = {
		fn: {
			taskSync: {
				createBriefTask: async () => ({ work_item_id: "task-1", comment_id: "comment-1" }),
				renameLaneTask: async (input) => {
					expect(input).toEqual({ lane_session: "session-1", title: "New title" });
					return { updated: true };
				},
			},
		},
	};
	expect(
		await renameLaneTaskTitle({ session: "session-1", title: "New title" }, client),
	).toBe(true);
});
