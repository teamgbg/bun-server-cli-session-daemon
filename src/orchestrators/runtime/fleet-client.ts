/**
 * @system cli-session
 * @status handwritten @indivisible-unit owner=finish-session-rekey reason="one supplier transport per pane; over budget by 14 lines from the import sweep it also carries"
 * @edit edit directly
 *
 * Owns one supplier transport inside its visible picker pane and activates the
 * exact cli_sessions identity allocated by the Rust host before pane creation.
 */

import type { ExtendedPrismaClient } from "@teamscala/db/create-db-client";
import {
	resolveAcpSessionServer,
	type AcpHttpServer,
} from "@teamscala/mcp-client-pool/resolve-acp-session-server";
import type {
	ParsedEvent,
	StdioAcpConfig,
	StdioAppServerConfig,
	TransportHandle,
} from "@teamscala/session-contracts/types";
import { createStdioAcpTransport } from "@teamscala/cli-protocol/transports/stdio-acp";
import { createStdioAppServerTransport } from "@teamscala/cli-protocol/transports/stdio-app-server";
import {
	startVisibleFleetControl,
	type AssignmentComment,
	type VisibleFleetControlInput,
} from "./visible-fleet-control";

export interface VisibleFleetClientInput {
	cliSessionId: string;
	workItemId: string;
	commandId: string;
	runtimeSlug: string;
	provider: string;
	windowName: string;
	workdir: string;
	model?: string;
	organisationId?: string;
	pickerOptionSlug: string;
}

export type CliSessionDb = Pick<
	ExtendedPrismaClient,
	| "cli_sessions"
	| "cli_session_messages"
	| "cli_session_transitions"
	| "comments"
	| "host_commands"
>;

export type VisibleFleetTransport = StdioAcpConfig | StdioAppServerConfig;

export async function recordVisibleFleetStartupFailure(
	input: VisibleFleetClientInput,
	cliDb: CliSessionDb,
	failure: unknown,
): Promise<void> {
	const existing = (await cliDb.cli_sessions.findUnique({
		where: { id: input.cliSessionId },
	})) as SessionRecord | null;
	if (!existing || existing.work_item_id !== input.workItemId || existing.closed_at) return;

	const message = failure instanceof Error ? failure.message : String(failure);
	const metadata = metadataRecord(existing.adapter_metadata);
	const fleet = metadataRecord(metadata.fleet);
	const lastMessage = await cliDb.cli_session_messages.findFirst({
		where: { session_id: input.cliSessionId },
		orderBy: { sequence: "desc" },
	});
	const nextSequence = (lastMessage?.sequence ?? 0) + 1;

	// NEVER CLOSE A LIVE CLI. An adapter exception proves only that ADAPTER REGISTRATION failed — never that the CLI process/pane ended. Closing a
	// visibly-live CLI violates `a-component-may-not-report-a-state-it-has-not- verified` (it reports `closed` for a process it did not verify dead) and
	// `crash-isolation` (one package's failure claims the host's lifecycle). The incident this closes (019fd255-865a): the control handshake
	// SUCCEEDED, activation threw on a Prisma `$transaction` array-form fault, the entry catch called this function, and the LIVE pane was closed one
	// second after spawn. The reconciler that can retry a registering lane cannot retry a closed one.
	//
	// So this function NEVER sets lifecycle_state=closed and NEVER writes a closed transition — for a pre-activation failure OR a post-activation one.
	// It records the failure as an observable message + stamps adapter_metadata.fleet.registration = "failed" (the loud signal the
	// reconciler reads to retry), and leaves the session in its current NON-TERMINAL state. Closing a session is the reconciler's job, once it has
	// verified the CLI ended — never an adapter exception's.
	const isPostActivation = Boolean(existing.adapter_ready_at);
	await cliDb.cli_session_messages.create({
		data: {
			session_id: input.cliSessionId,
			idempotency_key: `${isPostActivation ? "post-activation-error" : "startup-failed"}:${input.commandId}`,
			source: input.runtimeSlug,
			role: "system",
			message_type: isPostActivation ? "post_activation_error" : "startup_error",
			content_text: message,
			content_json: { error: message } as never,
			sequence: nextSequence,
		},
	});
	await cliDb.cli_sessions.update({
		where: { id: input.cliSessionId },
		data: {
			adapter_metadata: {
				...metadata,
				fleet: { ...fleet, registration: "failed", failure: message },
			} as never,
		},
	});
}

type SessionRecord = {
	id: string;
	work_item_id: string | null;
	lifecycle_state: string;
	closed_at: Date | null;
	provider_native_session_id: string | null;
	adapter_ready_at: Date | null;
	adapter_metadata: unknown;
};

type VisibleFleetClientDeps = {
	createTransport: (
		transport: VisibleFleetTransport,
		input: VisibleFleetClientInput,
		mcpServers: AcpHttpServer[],
		onEvent: (event: ParsedEvent) => void,
	) => TransportHandle;
	resolveMcpServers: (input: VisibleFleetClientInput) => Promise<AcpHttpServer[]>;
	startControl: (input: VisibleFleetControlInput) => Promise<() => Promise<void>>;
};

function metadataRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function assistantText(event: ParsedEvent): string {
	if (event.type !== "assistant") return "";
	return event.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The picker capability is the source of the supplier transport. */
export function getVisibleFleetTransportFromEnvironment(): VisibleFleetTransport {
	const kind = process.env.SCALA_FLEET_AGENT_TRANSPORT;
	const binary = process.env.SCALA_FLEET_AGENT_BINARY?.trim();
	const encodedArgs = process.env.SCALA_FLEET_AGENT_ARGS_JSON;
	if ((kind !== "stdio-acp" && kind !== "stdio-app-server") || !binary || !encodedArgs) {
		throw new Error("visible fleet client requires a typed platform agent transport");
	}
	let args: unknown;
	try {
		args = JSON.parse(encodedArgs);
	} catch {
		throw new Error("platform agent transport args are not valid JSON");
	}
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new Error("platform agent transport args must be a string array");
	}
	return { kind, binary, args } as VisibleFleetTransport;
}

function createVisibleFleetTransport(
	transport: VisibleFleetTransport,
	input: VisibleFleetClientInput,
	mcpServers: AcpHttpServer[],
	onEvent: (event: ParsedEvent) => void,
): TransportHandle {
	const shared = {
		workdir: input.workdir,
		model: input.model,
		extraEnv: { SCALA_FLEET_CLI_SESSION_ID: input.cliSessionId },
		onEvent,
	};
	return transport.kind === "stdio-acp"
		? createStdioAcpTransport({ ...shared, spec: transport, mcpServers })
		: createStdioAppServerTransport({ ...shared, spec: transport });
}

async function resolveVisibleFleetMcpServers(
	input: VisibleFleetClientInput,
): Promise<AcpHttpServer[]> {
	const orchestratorSessionId = process.env.SCALA_ORCH_SESSION_ID?.trim();
	const organisationId = input.organisationId?.trim();
	if (!orchestratorSessionId || !organisationId) {
		throw new Error(
			"visible ACP fleet client requires orchestrator-session and organisation identity",
		);
	}
	return [
		await resolveAcpSessionServer("scala-mcp", {
			orchestratorSessionId,
			organisationId,
			userId: process.env.SCALA_FLEET_USER_ID?.trim() || "system",
		}),
	];
}

export async function startVisibleFleetClient(
	input: VisibleFleetClientInput,
	cliDb: CliSessionDb,
	overrides: Partial<VisibleFleetClientDeps> = {},
): Promise<{ sessionId: string; nativeSessionId: string }> {
	const deps: VisibleFleetClientDeps = {
		createTransport: createVisibleFleetTransport,
		resolveMcpServers: resolveVisibleFleetMcpServers,
		startControl: startVisibleFleetControl,
		...overrides,
	};
	const existing = (await cliDb.cli_sessions.findUnique({
		where: { id: input.cliSessionId },
	})) as SessionRecord | null;
	if (!existing || existing.work_item_id !== input.workItemId || existing.closed_at) {
		throw new Error("visible fleet client identity does not match its preallocated cli_sessions row");
	}
	if (existing.lifecycle_state !== "registering" && existing.lifecycle_state !== "ready") {
		throw new Error(`visible fleet client cannot start from ${existing.lifecycle_state}`);
	}

	const prior = await cliDb.cli_session_messages.findFirst({
		where: { session_id: input.cliSessionId },
		orderBy: { sequence: "desc" },
	});
	let sequence = (prior?.sequence ?? 0) + 1;
	let latestAssistantText = "";
	let latestAssistantId = "";
	let renderedAssistantText = "";
	let eventQueue = Promise.resolve();
	let resolveNativeSession!: (nativeSessionId: string) => void;
	let rejectNativeSession!: (error: unknown) => void;
	const nativeSession = new Promise<string>((resolve, reject) => {
		resolveNativeSession = resolve;
		rejectNativeSession = reject;
	});

	const fleetMetadata = metadataRecord(metadataRecord(existing.adapter_metadata).fleet);
	const updateMetadata = async (patch: Record<string, unknown>): Promise<void> => {
		Object.assign(fleetMetadata, patch);
		await cliDb.cli_sessions.update({
			where: { id: input.cliSessionId },
			data: {
				adapter_metadata: {
					...metadataRecord(existing.adapter_metadata),
					fleet: { ...fleetMetadata },
				} as never,
			},
		});
	};
	const recordMessage = async (
		idempotencyKey: string,
		role: string,
		messageType: string,
		contentText: string | null,
		contentJson: unknown,
	): Promise<void> => {
		await cliDb.cli_session_messages.create({
			data: {
				session_id: input.cliSessionId,
				idempotency_key: idempotencyKey,
				source: input.runtimeSlug,
				role,
				message_type: messageType,
				content_text: contentText,
				content_json: contentJson as never,
				sequence,
			},
		});
		sequence += 1;
	};
	const recordEvent = async (event: ParsedEvent): Promise<void> => {
		const eventSequence = sequence;
		await recordMessage(
			`${input.cliSessionId}:event:${eventSequence}`,
			event.type === "assistant" ? "assistant" : event.type === "user" ? "user" : "system",
			event.type,
			event.type === "result" ? (event.result ?? null) : null,
			event,
		);
		if (event.type === "init") {
			Object.assign(fleetMetadata, {
				command_id: input.commandId,
				work_item_id: input.workItemId,
				runtime_slug: input.runtimeSlug,
				registration: "ready",
				native_session_id: event.session_id,
				visible: true,
			});
			await cliDb.cli_sessions.update({
				where: { id: input.cliSessionId },
				data: {
					provider_native_session_id: event.session_id,
					lifecycle_state: "ready",
					adapter_ready_at: new Date(),
					adapter_metadata: {
						...metadataRecord(existing.adapter_metadata),
						fleet: { ...fleetMetadata },
					} as never,
				},
			});
			resolveNativeSession(event.session_id);
			return;
		}
		if (
			event.type === "result" &&
			event.is_error &&
			fleetMetadata.registration !== "ready"
		) {
			throw new Error(event.result || "provider transport failed before registration");
		}
		if (event.type === "assistant") {
			const text = assistantText(event);
			const delta = text.startsWith(renderedAssistantText)
				? text.slice(renderedAssistantText.length)
				: `\n${text}`;
			if (delta) process.stdout.write(delta);
			renderedAssistantText = text;
			latestAssistantText = text;
			latestAssistantId = event.id;
			return;
		}
		if (event.type === "result" && latestAssistantText) {
			process.stdout.write("\n");
			await cliDb.comments.create({
				data: {
					work_item_id: input.workItemId,
					content: latestAssistantText,
					source_cli_session_id: input.cliSessionId,
					sender_role: "agent",
					sender_name: input.windowName,
					system_key: `fleet-reply:${input.cliSessionId}:${latestAssistantId}`,
				} as never,
			});
			latestAssistantText = "";
			latestAssistantId = "";
			renderedAssistantText = "";
		}
	};

	const transportSpec = getVisibleFleetTransportFromEnvironment();
	const mcpServers =
		transportSpec.kind === "stdio-acp" ? await deps.resolveMcpServers(input) : [];
	if (transportSpec.kind === "stdio-acp" && mcpServers.length === 0) {
		throw new Error("visible ACP fleet client requires its canonical MCP connection");
	}
	const transport = deps.createTransport(
		transportSpec,
		input,
		mcpServers,
		(event) => {
			eventQueue = eventQueue.then(() => recordEvent(event)).catch(rejectNativeSession);
		},
	);
	let nativeSessionId = existing.provider_native_session_id;
	if (!nativeSessionId) {
		try {
			nativeSessionId = await nativeSession;
		} catch (error) {
			transport.close();
			throw error;
		}
	}
	const lastDeliveredCommentId =
		typeof fleetMetadata.last_comment_id === "string" ? fleetMetadata.last_comment_id : null;
	await deps.startControl({
		workItemId: input.workItemId,
		lastDeliveredCommentId,
		listComments: () =>
			cliDb.comments.findMany({
				where: {
					work_item_id: input.workItemId,
					agent_id: null,
					source_cli_session_id: null,
				},
				orderBy: { created_at: "asc" },
			}),
		handleCommand: async (commandId) => {
			const command = await cliDb.host_commands.findUnique({ where: { id: commandId } });
			const payload = metadataRecord(command?.payload);
			if (
				command?.command !== "close_agent_tab" ||
				payload.sessionId !== input.cliSessionId
			) {
				return "ignored";
			}
			transport.close();
			return "closed";
		},
		send: (prompt) => transport.send(prompt),
		recordDelivered: async (comment: AssignmentComment) => {
			eventQueue = eventQueue.then(async () => {
				await recordMessage(
					`comment:${comment.id}`,
					"user",
					"prompt",
					comment.content,
					{ comment_id: comment.id },
				);
				await updateMetadata({
					last_comment_id: comment.id,
					comment_delivery_status: "delivered",
				});
			});
			await eventQueue;
		},
	});
	return { sessionId: input.cliSessionId, nativeSessionId };
}
