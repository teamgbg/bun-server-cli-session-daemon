// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { selectCodexRollout } from "./codex-rollout-discovery";

describe("selectCodexRollout", () => {
	test("never claims an older lane's rollout", () => {
		const oldId = "019fe30a-bfe2-72d3-98fa-d519b2db86af";
		const currentId = "019fe368-cf97-7282-a73a-3608fc6f7504";
		const selected = selectCodexRollout([
			{ name: `rollout-old-${oldId}.jsonl`, modifiedAtMs: 1_000 },
			{ name: `rollout-current-${currentId}.jsonl`, modifiedAtMs: 2_100 },
		], 2_000);
		expect(selected).toEqual({
			name: `rollout-current-${currentId}.jsonl`,
			nativeSessionId: currentId,
		});
	});

	test("returns no identity when only pre-existing rollouts exist", () => {
		const oldId = "019fe30a-bfe2-72d3-98fa-d519b2db86af";
		expect(selectCodexRollout([
			{ name: `rollout-old-${oldId}.jsonl`, modifiedAtMs: 1_000 },
		], 2_000)).toBeNull();
	});
});
