// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { decodeSseFrames } from "./picker-rpc.ts";

describe("picker event stream", () => {
	test("keeps an incomplete frame across chunk boundaries", () => {
		const first = decodeSseFrames('data: {"type":"picker.');
		expect(first.data).toEqual([]);
		const second = decodeSseFrames(`${first.rest}changed"}\n\n`);
		expect(second.data).toEqual(['{"type":"picker.changed"}']);
		expect(second.rest).toBe("");
	});

	test("decodes multiple CRLF frames without treating comments as data", () => {
		const result = decodeSseFrames(
			': connected\r\ndata: {"type":"picker.changed","slug":"a"}\r\n\r\ndata: two\r\ndata: lines\r\n\r\n',
		);
		expect(result.data).toEqual(['{"type":"picker.changed","slug":"a"}', "two\nlines"]);
	});
});
