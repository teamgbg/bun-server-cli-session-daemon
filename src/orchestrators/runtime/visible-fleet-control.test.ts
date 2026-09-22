// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { startVisibleFleetControl } from "./visible-fleet-control";

test("delivers each work-item comment once and records durable progress", async () => {
	process.env.DATABASE_URL = "postgres://test";
	let notify: ((payload: string) => void) | undefined;
	const sends: string[] = [];
	const delivered: string[] = [];
	const comments = [
		{ id: "comment-1", content: "launch prompt", agent_id: null },
		{ id: "comment-2", content: "follow-up", agent_id: null },
	];
	const stop = await startVisibleFleetControl(
		{
			workItemId: "work-item-row",
			lastDeliveredCommentId: "comment-1",
			listComments: async () => comments,
			handleCommand: async () => "ignored",
			send: async (prompt) => {
				sends.push(prompt);
			},
			recordDelivered: async (comment) => {
				delivered.push(comment.id);
			},
		},
		{
			listen: async (_channel, handler) => {
				notify = handler;
			},
			stop: async () => {},
		},
	);

	await notify?.(JSON.stringify({ table: "comments" }));
	expect(sends).toEqual(["follow-up"]);
	expect(delivered).toEqual(["comment-2"]);
	await stop();
});

test("ignores non-comment database notifications", async () => {
	process.env.DATABASE_URL = "postgres://test";
	let notify: ((payload: string) => void) | undefined;
	let sends = 0;
	const stop = await startVisibleFleetControl(
		{
			workItemId: "work-item-row",
			lastDeliveredCommentId: null,
			listComments: async () => [],
			handleCommand: async () => "ignored",
			send: async () => {
				sends += 1;
			},
			recordDelivered: async () => {},
		},
		{
			listen: async (_channel, handler) => {
				notify = handler;
			},
			stop: async () => {},
		},
	);
	await notify?.(JSON.stringify({ table: "host_commands" }));
	expect(sends).toBe(0);
	await stop();
});

test("acknowledges a claimed close command and releases the listener", async () => {
	process.env.DATABASE_URL = "postgres://test";
	let notify: ((payload: string) => void) | undefined;
	let stopped = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	await startVisibleFleetControl(
		{
			workItemId: "work-item-row",
			lastDeliveredCommentId: null,
			listComments: async () => [],
			handleCommand: async (commandId) => {
				expect(commandId).toBe("close-command");
				return "closed";
			},
			send: async () => {},
			recordDelivered: async () => {},
		},
		{
			listen: async (_channel, handler) => {
				notify = handler;
			},
			stop: async () => {
				stopped = true;
				resolveClosed();
			},
		},
	);
	notify?.(JSON.stringify({ table: "host_commands", command_id: "close-command" }));
	await closed;
	expect(stopped).toBe(true);
});
