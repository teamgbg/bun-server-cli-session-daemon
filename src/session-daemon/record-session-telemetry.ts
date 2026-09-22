/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Runtime telemetry sink for provider transcript tails. Human conversation
 * remains in comments; provider events belong to cli_session_messages and are
 * never sent through the retired fleet ingest HTTP surface.
 */
import { getServerClient } from "@teamscala/orpc/server-client-registry";

export type SessionTelemetryClient = {
	cli_sessions: {
		findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
	};
	cli_session_messages: {
		findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<{ sequence: number } | null>;
		create(args: { data: Record<string, unknown> }): Promise<unknown>;
	};
};

export interface SessionTelemetryEvent {
	eventType: string;
	payload: Record<string, unknown>;
}

/** Persist one tail batch against the registered native session. */
export async function recordSessionTelemetry(
	sessionID: string,
	events: SessionTelemetryEvent[],
	clientOverride?: SessionTelemetryClient,
): Promise<number> {
	if (events.length === 0) return 0;
	const client = clientOverride ?? (await getServerClient()) as unknown as SessionTelemetryClient;
	const session = await client.cli_sessions.findFirst({
		where: { provider_native_session_id: sessionID, closed_at: null },
	});
	if (!session) return 0;
	const prior = await client.cli_session_messages.findFirst({
		where: { session_id: session.id },
		orderBy: { sequence: "desc" },
	});
	let sequence = (prior?.sequence ?? 0) + 1;
	for (const event of events) {
		const sourceEventId = typeof event.payload.source_event_id === "string"
			? event.payload.source_event_id
			: `${sessionID}:${sequence}`;
		await client.cli_session_messages.create({
			data: {
				session_id: session.id,
				idempotency_key: sourceEventId,
				source: "provider-transcript-tail",
				role: "system",
				message_type: event.eventType,
				content_text: null,
				content_json: event.payload,
				sequence,
			},
		});
		sequence += 1;
	}
	return events.length;
}
