/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Delivers the work-item comment stream to one visible native transport.
 * Delivery progress is restored from the canonical cli_sessions row by the
 * caller; LISTEN/NOTIFY only wakes the drain and never owns state.
 */

import { createNotifyListener } from "@teamscala/db/notify-listener/index";

export type AssignmentComment = {
	id: string;
	content: string;
	agent_id: string | null;
};

type ControlDeps = {
	listen: (channel: string, handler: (payload: string) => void) => Promise<void>;
	stop: () => Promise<void>;
};

export interface VisibleFleetControlInput {
	workItemId: string;
	lastDeliveredCommentId: string | null;
	listComments: () => Promise<AssignmentComment[]>;
	handleCommand: (commandId: string) => Promise<"closed" | "ignored">;
	send: (prompt: string) => Promise<void>;
	recordDelivered: (comment: AssignmentComment) => Promise<void>;
}

export async function startVisibleFleetControl(
	input: VisibleFleetControlInput,
	overrides: Partial<ControlDeps> = {},
): Promise<() => Promise<void>> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("visible fleet control requires DATABASE_URL");
	const listener = createNotifyListener(databaseUrl);
	const deps: ControlDeps = {
		listen: (channel, handler) => listener.listen(channel, handler),
		stop: () => listener.stop(),
		...overrides,
	};
	let lastDeliveredCommentId = input.lastDeliveredCommentId;
	let draining = false;
	let redrainRequested = false;

	const drain = async (): Promise<void> => {
		if (draining) {
			redrainRequested = true;
			return;
		}
		draining = true;
		try {
			do {
				redrainRequested = false;
				const comments = await input.listComments();
				const lastIndex = lastDeliveredCommentId
					? comments.findIndex((comment) => comment.id === lastDeliveredCommentId)
					: -1;
				for (const comment of comments.slice(lastIndex + 1)) {
					await input.send(comment.content);
					await input.recordDelivered(comment);
					lastDeliveredCommentId = comment.id;
				}
			} while (redrainRequested);
		} finally {
			draining = false;
		}
	};

	await deps.listen("data_change", (payload) => {
		try {
			const event = JSON.parse(payload) as { table?: string; command_id?: string };
			if (event.table === "comments") void drain();
			if (event.table === "host_commands" && event.command_id) {
				void input.handleCommand(event.command_id).then(async (outcome) => {
					if (outcome === "closed") await deps.stop();
				});
			}
		} catch {
			// Notifications for other writers are not control commands.
		}
	});
	await drain();
	return deps.stop;
}
