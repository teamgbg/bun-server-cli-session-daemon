// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	type AdapterCtx,
	type SourceEvent,
	isEchoReflection,
	mapEvent,
	subtaskToTodoEvent,
} from "./source-adapter-core";

const ctx: AdapterCtx = { cliSessionId: "s1", workItemId: "w1" };

describe("source-adapter-core mapEvent", () => {
	test("token/reasoning/tool_call/tool_result map to message ops", () => {
		expect(mapEvent(ctx, { type: "token", text: "hi" })).toEqual([
			{ kind: "message", content: "hi", message_type: "token" },
		]);
		expect(mapEvent(ctx, { type: "reasoning", text: "think" })).toEqual([
			{ kind: "message", content: "think", message_type: "reasoning" },
		]);
		expect(
			mapEvent(ctx, { type: "tool_call", name: "bash", args: { x: 1 } })[0]?.message_type,
		).toBe("tool_call");
		expect(
			mapEvent(ctx, { type: "tool_result", name: "bash", output: "done" })[0]?.message_type,
		).toBe("tool_result");
	});

	test("usage maps to a usage op carrying all four counters", () => {
		const ops = mapEvent(ctx, {
			type: "usage",
			input: 10,
			output: 20,
			cached: 5,
			cache_creation: 2,
		});
		expect(ops).toEqual([
			{ kind: "usage", stats: { input: 10, output: 20, cached: 5, cache_creation: 2 } },
		]);
	});

	test("turn_start writes the ONE active transition; turn_end is a no-op (the native terminal event owns active→idle)", () => {
		expect(mapEvent(ctx, { type: "lifecycle", phase: "turn_start" })).toEqual([
			{ kind: "transition", state: "active" },
		]);
		expect(mapEvent(ctx, { type: "lifecycle", phase: "turn_end" })).toEqual([]);
	});

	test("session_end → closed (distinct from turn_end → idle)", () => {
		expect(mapEvent(ctx, { type: "lifecycle", phase: "session_end" })).toEqual([
			{ kind: "transition", state: "closed" },
		]);
	});

	test("non-terminal provider signals do not become session lifecycle", () => {
		const ops = mapEvent(ctx, {
			type: "lifecycle",
			phase: "provider_limited",
			provider: "anthropic",
			reset_at: "2026-08-05T00:00:00Z",
			retry: true,
		});
		expect(ops).toEqual([]);
	});

	test("done maps to ONE canonical turn_end op (final output + usage, atomic)", () => {
		const ops = mapEvent(ctx, {
			type: "done",
			response: "all done",
			usage: { input: 1, output: 2, cached: 0, cache_creation: 0 },
		});
		expect(ops).toEqual([
			{
				kind: "turn_end",
				final_output: "all done",
				usage: { input: 1, output: 2, cached: 0, cache_creation: 0 },
			},
		]);
	});

	test("error maps to ONE canonical turn_end op flagged as error", () => {
		expect(mapEvent(ctx, { type: "error", message: "boom" })).toEqual([
			{ kind: "turn_end", final_output: "boom", error: true },
		]);
	});

	test("session/state events map to no ops (handshake only)", () => {
		expect(
			mapEvent(ctx, {
				type: "session",
				id: "s1",
				pid: 1,
				version: "1",
				seam_version: 1,
			}),
		).toEqual([]);
		expect(mapEvent(ctx, { type: "state", busy: false })).toEqual([]);
	});
});

describe("source-adapter-core todo echo guard", () => {
	const item = { id: "tsk-1", label: "x", status: "in_progress" as const };

	test("local-origin todo upserts a subtask", () => {
		const ops = mapEvent(ctx, { type: "todo", action: "update", item, origin: "local" });
		expect(ops).toEqual([{ kind: "subtask_upsert", id: "tsk-1", label: "x", status: "in_progress" }]);
	});

	test("remote-origin todo is suppressed (echo guard)", () => {
		expect(
			mapEvent(ctx, { type: "todo", action: "update", item, origin: "remote" }),
		).toEqual([]);
	});

	test("complete maps to subtask_complete; delete maps to nothing", () => {
		expect(
			mapEvent(ctx, { type: "todo", action: "complete", item, origin: "local" }),
		).toEqual([{ kind: "subtask_complete", id: "tsk-1" }]);
		expect(
			mapEvent(ctx, { type: "todo", action: "delete", item, origin: "local" }),
		).toEqual([]);
	});

	test("isEchoReflection drops an event whose token we originated", () => {
		const tokens = new Set(["pm-1"]);
		const reflected: SourceEvent = {
			type: "todo",
			action: "update",
			item,
			origin: "local",
			echo_token: "pm-1",
		};
		expect(isEchoReflection(tokens, reflected)).toBe(true);
		expect(
			isEchoReflection(tokens, { ...reflected, echo_token: "pm-2" }),
		).toBe(false);
	});
});

describe("source-adapter-core subtask → todo (PM→CLI)", () => {
	test("maps a work_items subtask to a canonical todo event", () => {
		const ev = subtaskToTodoEvent({ id: "w-9", title: "ship it", status: "in_progress" }, "pm-1");
		expect(ev).toEqual({
			type: "todo",
			action: "update",
			item: { id: "w-9", label: "ship it", status: "in_progress" },
			origin: "remote",
			echo_token: "pm-1",
		});
	});

	test("completed status becomes a complete action", () => {
		const ev = subtaskToTodoEvent({ id: "w-9", title: "x", status: "done" }, "pm-2");
		expect(ev?.action).toBe("complete");
		expect(ev?.item.status).toBe("completed");
	});

	test("unknown status maps to null (no projection)", () => {
		expect(subtaskToTodoEvent({ id: "w", title: "x", status: "weird" }, "t")).toBeNull();
	});
});
