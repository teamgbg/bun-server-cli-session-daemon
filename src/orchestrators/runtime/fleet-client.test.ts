// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, it } from "bun:test";
import type { ParsedEvent, TransportHandle } from "@teamscala/session-contracts/types";
import {
	getVisibleFleetTransportFromEnvironment,
	recordVisibleFleetStartupFailure,
	startVisibleFleetClient,
	type VisibleFleetClientInput,
} from "./fleet-client";

function withTransportEnvironment(run: () => void | Promise<void>): Promise<void> {
	const previous = {
		kind: process.env.SCALA_FLEET_AGENT_TRANSPORT,
		binary: process.env.SCALA_FLEET_AGENT_BINARY,
		args: process.env.SCALA_FLEET_AGENT_ARGS_JSON,
	};
	process.env.SCALA_FLEET_AGENT_TRANSPORT = "stdio-acp";
	process.env.SCALA_FLEET_AGENT_BINARY = "/usr/local/bin/agent-code";
	process.env.SCALA_FLEET_AGENT_ARGS_JSON = '["--acp","--provider","zai","--model","glm-5.2"]';
	return Promise.resolve(run()).finally(() => {
		for (const [name, value] of Object.entries({
			SCALA_FLEET_AGENT_TRANSPORT: previous.kind,
			SCALA_FLEET_AGENT_BINARY: previous.binary,
			SCALA_FLEET_AGENT_ARGS_JSON: previous.args,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

const input: VisibleFleetClientInput = {
	cliSessionId: "019fcd11-0000-7000-8000-000000000001",
	workItemId: "019fcd11-0000-7000-8000-000000000002",
	commandId: "019fcd11-0000-7000-8000-000000000003",
	runtimeSlug: "agent-code-acp",
	provider: "zai",
	windowName: "Fleet Bootstrap E2E",
	workdir: "/home/joe-bellissimo/workspace",
	model: "glm-5.2",
	pickerOptionSlug: "agent-code-acp-client",
};

describe("visible fleet client registration contract", () => {
	it("an ADAPTER failure NEVER closes a registering (pre-activation) session", async () => {
		// state-must-be-verified + crash-isolation: an adapter exception proves
		// only that adapter registration failed — never that the CLI process/pane
		// ended. Closing a live CLI makes it unreachable by the canonical channel
		// and unretryable by the reconciler. The session MUST stay non-terminal
		// with loud failure metadata so the reconciler can retry.
		const sessionUpdates: Array<Record<string, unknown>> = [];
		const transitions: Array<Record<string, unknown>> = [];
		const messages: Array<Record<string, unknown>> = [];
		const db = {
			cli_sessions: {
				findUnique: async () => ({
					id: input.cliSessionId,
					work_item_id: input.workItemId,
					lifecycle_state: "registering",
					closed_at: null,
					provider_native_session_id: null,
					adapter_ready_at: null,
					adapter_metadata: { fleet: { registration: "pending" } },
				}),
				update: async ({ data }: { data: Record<string, unknown> }) => {
					sessionUpdates.push(data);
					return {};
				},
			},
			cli_session_messages: {
				findFirst: async () => ({ sequence: 4 }),
				create: async ({ data }: { data: Record<string, unknown> }) => {
					messages.push(data);
					return {};
				},
			},
			cli_session_transitions: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					transitions.push(data);
					return {};
				},
			},
			comments: {},
			host_commands: {},
		};

		await recordVisibleFleetStartupFailure(input, db as never, new Error("adapter bridge fault"));

		// The error is recorded as an observable message...
		expect(messages[0]).toMatchObject({
			message_type: "startup_error",
			content_text: "adapter bridge fault",
			sequence: 5,
		});
		// ...the session is stamped with failure metadata (the loud signal)...
		expect(sessionUpdates[0]?.adapter_metadata).toMatchObject({
			fleet: { registration: "failed", failure: "adapter bridge fault" },
		});
		// ...but it is NEVER closed: no lifecycle_state=closed, no closed_at, no closed transition.
		expect(sessionUpdates[0]?.lifecycle_state).toBeUndefined();
		expect(sessionUpdates[0]?.closed_at).toBeUndefined();
		expect(transitions).toEqual([]);
	});

	it("an ADAPTER failure NEVER closes an already-activated (post-activation) session", async () => {
		// Regression for incident 019fd255-865a: the control handshake SUCCEEDED
		// (adapter_ready_at set, registering->active landed), then activation threw
		// on a Prisma $transaction fault, the entry catch routed it here, and the
		// LIVE pane was closed one second after spawn. An adapter exception is
		// operational, not a death signal — and the pre/post distinction does not
		// matter: neither path may close, because neither has verified the CLI ended.
		const sessionUpdates: Array<Record<string, unknown>> = [];
		const transitions: Array<Record<string, unknown>> = [];
		const messages: Array<Record<string, unknown>> = [];
		const db = {
			cli_sessions: {
				findUnique: async () => ({
					id: input.cliSessionId,
					work_item_id: input.workItemId,
					lifecycle_state: "active",
					closed_at: null,
					provider_native_session_id: input.cliSessionId,
					adapter_ready_at: new Date("2026-08-05T14:30:50.031Z"),
					adapter_metadata: { fleet: { registration: "ready" } },
				}),
				update: async ({ data }: { data: Record<string, unknown> }) => {
					sessionUpdates.push(data);
					return {};
				},
			},
			cli_session_messages: {
				findFirst: async () => ({ sequence: 4 }),
				create: async ({ data }: { data: Record<string, unknown> }) => {
					messages.push(data);
					return {};
				},
			},
			cli_session_transitions: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					transitions.push(data);
					return {};
				},
			},
			comments: {},
			host_commands: {},
		};

		await recordVisibleFleetStartupFailure(
			input,
			db as never,
			new Error("All elements of the array need to be Prisma Client promises"),
		);

		// The error is recorded as a post_activation_error message...
		expect(messages[0]).toMatchObject({
			message_type: "post_activation_error",
			content_text: "All elements of the array need to be Prisma Client promises",
			sequence: 5,
		});
		// ...failure metadata is stamped (so it is observable)...
		expect(sessionUpdates[0]?.adapter_metadata).toMatchObject({
			fleet: { registration: "failed" },
		});
		// ...but NEVER closed: no lifecycle_state, no closed_at, no closed transition.
		expect(sessionUpdates[0]?.lifecycle_state).toBeUndefined();
		expect(sessionUpdates[0]?.closed_at).toBeUndefined();
		expect(transitions).toEqual([]);
	});
	it("uses the declared platform ACP transport", async () => {
		await withTransportEnvironment(() => {
			expect(getVisibleFleetTransportFromEnvironment()).toEqual({
				kind: "stdio-acp",
				binary: "/usr/local/bin/agent-code",
				args: ["--acp", "--provider", "zai", "--model", "glm-5.2"],
			});
		});
	});

	it("rejects and closes a provider transport that fails before registration", async () => {
		await withTransportEnvironment(async () => {
			let transportClosed = false;
			const db = {
				cli_sessions: {
					findUnique: async () => ({
						id: input.cliSessionId,
						work_item_id: input.workItemId,
						lifecycle_state: "registering",
						closed_at: null,
						provider_native_session_id: null,
						adapter_metadata: { fleet: { registration: "pending" } },
					}),
					update: async () => ({}),
				},
				cli_session_messages: {
					findFirst: async () => null,
					create: async () => ({}),
				},
				cli_session_transitions: { create: async () => ({}) },
				comments: {},
				host_commands: {},
			};
			const started = startVisibleFleetClient(input, db as never, {
				resolveMcpServers: async () => [
					{
						type: "http",
						name: "scala-mcp",
						url: "https://mcp.scala.business/mcp",
						headers: [],
					},
				],
				createTransport: (_transport, _input, _servers, onEvent) => {
					queueMicrotask(() =>
						onEvent({
							type: "result",
							is_error: true,
							result: "ACP initialization failed",
						}),
					);
					return {
						sessionId: "provider-startup-failure",
						send: async () => {},
						onEvent: () => () => {},
						close: () => {
							transportClosed = true;
						},
						interrupt: async () => {},
						compact: async () => {},
					};
				},
				startControl: async () => async () => {},
			});

			expect(started).rejects.toThrow("ACP initialization failed");
			await started.catch(() => undefined);
			expect(transportClosed).toBe(true);
		});
	});

	it("activates the exact host-preallocated cli_sessions row without creating another identity", async () => {
		await withTransportEnvironment(async () => {
			const sessionUpdates: Array<Record<string, unknown>> = [];
			const transitions: Array<Record<string, unknown>> = [];
			const messages: Array<Record<string, unknown>> = [];
			const commentReads: Array<Record<string, unknown>> = [];
			let transportClosed = false;
			let onEvent: ((event: ParsedEvent) => void) | undefined;
			const fakeHandle: TransportHandle = {
				send: async () => {},
				onEvent: () => () => {},
				close: () => {
					transportClosed = true;
				},
				interrupt: async () => {},
				compact: async () => {},
				sessionId: "native-zs-1",
			};
			const db = {
				cli_sessions: {
					findUnique: async () => ({
						id: input.cliSessionId,
						work_item_id: input.workItemId,
						lifecycle_state: "registering",
						closed_at: null,
						provider_native_session_id: null,
						adapter_metadata: { fleet: { registration: "pending" } },
					}),
					update: async ({ data }: { data: Record<string, unknown> }) => {
						sessionUpdates.push(data);
						return {};
					},
				},
				cli_session_messages: {
					findFirst: async () => null,
					create: async ({ data }: { data: Record<string, unknown> }) => {
						messages.push(data);
						return {};
					},
				},
				cli_session_transitions: {
					create: async ({ data }: { data: Record<string, unknown> }) => {
						transitions.push(data);
						return {};
					},
				},
				comments: {
					findMany: async (query: Record<string, unknown>) => {
						commentReads.push(query);
						return [];
					},
					create: async () => ({}),
				},
				host_commands: {
					findUnique: async () => ({
						command: "close_agent_tab",
						payload: { sessionId: input.cliSessionId, disposition: "completed" },
					}),
				},
			};
			const started = startVisibleFleetClient(input, db as never, {
				resolveMcpServers: async () => [
					{
						type: "http",
						name: "scala-mcp",
						url: "https://mcp.scala.business/mcp",
						headers: [],
					},
				],
				createTransport: (_transport, _input, mcpServers, handler) => {
					expect(mcpServers.map((server) => server.name)).toEqual(["scala-mcp"]);
					onEvent = handler;
					queueMicrotask(() => onEvent?.({ type: "init", session_id: "native-zs-1" }));
					return fakeHandle;
				},
				startControl: async (control) => {
					await control.listComments();
					await control.recordDelivered({
						id: "launch-comment",
						content: "brief",
						agent_id: null,
					});
					await control.handleCommand("close-command");
					return async () => {};
				},
			});

			expect(await started).toEqual({
				sessionId: input.cliSessionId,
				nativeSessionId: "native-zs-1",
			});
			expect(sessionUpdates.some((data) => data.provider_native_session_id === "native-zs-1")).toBe(true);
			expect(transitions).toHaveLength(0);
			expect(messages[0]?.session_id).toBe(input.cliSessionId);
			const deliveryMetadata = sessionUpdates
				.map((update) => update.adapter_metadata as {
					fleet?: { registration?: string; last_comment_id?: string };
				})
				.find((metadata) => metadata.fleet?.last_comment_id === "launch-comment");
			expect(deliveryMetadata?.fleet?.registration).toBe("ready");
			expect(commentReads[0]).toMatchObject({
				where: {
					work_item_id: input.workItemId,
					source_cli_session_id: null,
				},
			});
			expect(transportClosed).toBe(true);
			expect("create" in db.cli_sessions).toBe(false);
		});
	});

	it("records a prompt deadline after registration without closing the session", async () => {
		await withTransportEnvironment(async () => {
			const sessionUpdates: Array<Record<string, unknown>> = [];
			const transitions: Array<Record<string, unknown>> = [];
			const messages: Array<Record<string, unknown>> = [];
			let onEvent: ((event: ParsedEvent) => void) | undefined;
			let transportClosed = false;
			let resolveDeadlineRecorded!: () => void;
			const deadlineRecorded = new Promise<void>((resolve) => {
				resolveDeadlineRecorded = resolve;
			});
			const db = {
				cli_sessions: {
					findUnique: async () => ({
						id: input.cliSessionId,
						work_item_id: input.workItemId,
						lifecycle_state: "registering",
						closed_at: null,
						provider_native_session_id: null,
						adapter_metadata: { fleet: { registration: "pending" } },
					}),
					update: async ({ data }: { data: Record<string, unknown> }) => {
						sessionUpdates.push(data);
						return {};
					},
				},
				cli_session_messages: {
					findFirst: async () => null,
					create: async ({ data }: { data: Record<string, unknown> }) => {
						messages.push(data);
						if (data.message_type === "result") resolveDeadlineRecorded();
						return {};
					},
				},
				cli_session_transitions: {
					create: async ({ data }: { data: Record<string, unknown> }) => {
						transitions.push(data);
						return {};
					},
				},
				comments: { findMany: async () => [] },
				host_commands: { findUnique: async () => null },
			};
			const handle: TransportHandle = {
				send: async () => {},
				onEvent: () => () => {},
				close: () => {
					transportClosed = true;
				},
				interrupt: async () => {},
				compact: async () => {},
				sessionId: "native-zs-deadline",
			};

			await startVisibleFleetClient(input, db as never, {
				resolveMcpServers: async () => [
					{
						type: "http",
						name: "scala-mcp",
						url: "https://mcp.scala.business/mcp",
						headers: [],
					},
				],
				createTransport: (_transport, _input, _servers, handler) => {
					onEvent = handler;
					queueMicrotask(() =>
						onEvent?.({ type: "init", session_id: "native-zs-deadline" }),
					);
					return handle;
				},
				startControl: async () => async () => {},
			});

			onEvent?.({
				type: "result",
				is_error: true,
				result: "RPC timed out after 120000ms",
			});
			await deadlineRecorded;

			expect(messages.at(-1)).toMatchObject({
				message_type: "result",
				content_text: "RPC timed out after 120000ms",
			});
			expect(sessionUpdates.some((data) => data.lifecycle_state === "closed")).toBe(false);
			expect(transitions).toHaveLength(0);
			expect(transportClosed).toBe(false);
		});
	});
});
