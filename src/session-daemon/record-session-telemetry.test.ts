// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { recordSessionTelemetry, type SessionTelemetryClient } from "./record-session-telemetry";

test("records provider telemetry against the registered cli session with monotonic idempotency", async () => {
	const created: Record<string, unknown>[] = [];
	const client: SessionTelemetryClient = {
		cli_sessions: { findFirst: async () => ({ id: "cli-1" }) },
		cli_session_messages: {
			findFirst: async () => ({ sequence: 4 }),
			create: async ({ data }) => { created.push(data); return data; },
		},
	};
	const count = await recordSessionTelemetry("native-1", [
		{ eventType: "message.updated", payload: { source_event_id: "evt-1", text: "reply" } },
		{ eventType: "usage.updated", payload: { source_event_id: "evt-2", tokens: 3 } },
	], client);
	expect(count).toBe(2);
	expect(created.map((row) => row.sequence)).toEqual([5, 6]);
	expect(created.map((row) => row.idempotency_key)).toEqual(["evt-1", "evt-2"]);
	expect(created.every((row) => row.session_id === "cli-1")).toBe(true);
});

test("does not invent a runtime row when the native session is unregistered", async () => {
	let writes = 0;
	const client: SessionTelemetryClient = {
		cli_sessions: { findFirst: async () => null },
		cli_session_messages: {
			findFirst: async () => null,
			create: async () => { writes += 1; return {}; },
		},
	};
	expect(await recordSessionTelemetry("missing", [{ eventType: "usage.updated", payload: {} }], client)).toBe(0);
	expect(writes).toBe(0);
});
