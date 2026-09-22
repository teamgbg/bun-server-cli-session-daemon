// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { turnEventKey } from "./turn-event-key";

/**
 * The defect this file exists to prevent: the key was `Bun.randomUUIDv7()`, so
 * it was unique per CALL rather than per EVENT. Every assertion below fails
 * against that implementation, and every one of them passes trivially against
 * any implementation that never replays — which is why the bug shipped.
 */

const endTurnRecord = {
	type: "assistant",
	uuid: "53d0f77e-529b-4ad2-970b-586ba0e7bbc0",
	sessionId: "019fd9cf-5210-7a01-91af-ef67afba0140",
	message: { id: "msg_011CdnX48oUrUEtPDa9VxrXs", stop_reason: "end_turn" },
};

describe("turnEventKey", () => {
	test("is stable across repeated reads of the same record", () => {
		const raw = JSON.stringify(endTurnRecord);
		expect(turnEventKey(endTurnRecord, raw)).toBe(turnEventKey(endTurnRecord, raw));
	});

	test("prefers the record uuid", () => {
		expect(turnEventKey(endTurnRecord, JSON.stringify(endTurnRecord))).toBe(
			"turn_end:53d0f77e-529b-4ad2-970b-586ba0e7bbc0",
		);
	});

	test("falls back to message.id when the record carries no uuid", () => {
		const { uuid: _dropped, ...noUuid } = endTurnRecord;
		expect(turnEventKey(noUuid, JSON.stringify(noUuid))).toBe(
			"turn_end:msg_011CdnX48oUrUEtPDa9VxrXs",
		);
	});

	test("falls back to a deterministic content hash when the record carries neither", () => {
		const bare = { type: "assistant", message: { stop_reason: "end_turn" } };
		const raw = JSON.stringify(bare);
		const first = turnEventKey(bare, raw);
		expect(first).toBe(turnEventKey(bare, raw));
		expect(first).toStartWith("turn_end:fnv-");
	});

	test("distinguishes different turns", () => {
		const other = { ...endTurnRecord, uuid: "11111111-2222-3333-4444-555555555555" };
		expect(turnEventKey(endTurnRecord, JSON.stringify(endTurnRecord))).not.toBe(
			turnEventKey(other, JSON.stringify(other)),
		);
	});

	/**
	 * THE REGRESSION GATE. A sidecar start replays the transcript from byte 0,
	 * so the same N records are processed again. Keys from the replay must be
	 * SET-IDENTICAL to the first pass — that is what lets the existing
	 * `ON CONFLICT (session_id, idempotency_key) DO NOTHING` collapse a replay
	 * to zero new transitions instead of N fabricated idle events.
	 */
	test("a full transcript replay yields no new keys", () => {
		const transcript = [
			{ ...endTurnRecord, uuid: "aaaaaaaa-0000-0000-0000-000000000001" },
			{ ...endTurnRecord, uuid: "aaaaaaaa-0000-0000-0000-000000000002" },
			{ ...endTurnRecord, uuid: "aaaaaaaa-0000-0000-0000-000000000003" },
		];

		const firstPass = transcript.map((r) => turnEventKey(r, JSON.stringify(r)));
		const replay = transcript.map((r) => turnEventKey(r, JSON.stringify(r)));

		expect(new Set(firstPass).size).toBe(3);
		expect(replay).toEqual(firstPass);
		expect(new Set([...firstPass, ...replay]).size).toBe(3);
	});
});
