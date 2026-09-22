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
	loadTailableSessionState,
	reportTailRestoreOutcome,
	type EmitEvent,
	type SessionStateLoader,
} from "./restore-fleet-tail-state.ts";
import type { SessionStateConfig } from "@teamscala/db-validation/registry-schemas/session-state";

const emitted: Parameters<EmitEvent>[0][] = [];
const spyEmit: EmitEvent = (e) => {
	emitted.push(e);
};
const reset = (): void => {
	emitted.length = 0;
};

const throwingLoad: SessionStateLoader = async () => {
	throw new Error("connection terminated");
};
const emptyState: SessionStateConfig = { tabs: [] };
const fakeLoad = (state: SessionStateConfig): SessionStateLoader => async () => state;

test("a load failure EMITS the session + real error and returns null (not swallowed)", async () => {
	reset();
	const out = await loadTailableSessionState("work", "pi", {
		load: throwingLoad,
		emit: spyEmit,
	});
	expect(out).toBeNull();
	expect(emitted).toHaveLength(1);
	expect(emitted[0].kind).toBe("cli-session.restore-fleet-tails.load-failed");
	expect(emitted[0].payload).toMatchObject({
		kind: "pi",
		session: "work",
		error: "connection terminated",
	});
});

test("a load failure carries the real error string, never a bare/null reason", async () => {
	reset();
	await loadTailableSessionState("fleet", "codex", {
		load: async () => {
			throw "non-Error throw";
		},
		emit: spyEmit,
	});
	expect(emitted[0].payload).toMatchObject({
		session: "fleet",
		error: "non-Error throw",
	});
});

test("a successful load does NOT emit (a missing row is {tabs:[]}, not a failure)", async () => {
	reset();
	const out = await loadTailableSessionState("work", "pi", {
		load: fakeLoad(emptyState),
		emit: spyEmit,
	});
	expect(out).toEqual({ tabs: [] });
	expect(emitted).toHaveLength(0);
});

test("reportTailRestoreOutcome emits a shortfall naming restored vs skipped on a partial pass", () => {
	reset();
	reportTailRestoreOutcome("pi", 3, 2, { emit: spyEmit });
	expect(emitted).toHaveLength(1);
	expect(emitted[0].kind).toBe("cli-session.restore-fleet-tails.shortfall");
	expect(emitted[0].payload).toMatchObject({ kind: "pi", restored: 3, sessionsSkipped: 2 });
});

test("reportTailRestoreOutcome does NOT emit a shortfall on a clean pass (no skips)", () => {
	reset();
	reportTailRestoreOutcome("codex", 5, 0, { emit: spyEmit });
	expect(emitted).toHaveLength(0);
});

test("reportTailRestoreOutcome does NOT emit on a no-op (nothing restored, nothing skipped)", () => {
	reset();
	reportTailRestoreOutcome("pi", 0, 0, { emit: spyEmit });
	expect(emitted).toHaveLength(0);
});
