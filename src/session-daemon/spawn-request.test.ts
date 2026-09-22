// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { deriveSpawnTaskName, spawnOptsFromSpawnRequest } from "./spawn-request.ts";

describe("deriveSpawnTaskName (every spawn mints a named task — no 'Lane' debris)", () => {
	test("an explicit windowName becomes the task title", () => {
		expect(deriveSpawnTaskName({ windowName: "Picker Task Bind", slug: "cc-opus" })).toBe(
			"Picker Task Bind",
		);
	});

	test("no windowName falls back to the option's human window_name", () => {
		expect(
			deriveSpawnTaskName({ windowName: undefined, optionWindowName: "GLM 5.2", slug: "cc-glm52" }),
		).toBe("GLM 5.2");
	});

	test("no window_name falls back to the option's menu label", () => {
		expect(
			deriveSpawnTaskName({ windowName: undefined, optionLabel: "Claude Opus", slug: "cc-opus" }),
		).toBe("Claude Opus");
	});

	test("nothing resolves to a label → the slug (a machine key, but non-empty and attributable)", () => {
		expect(deriveSpawnTaskName({ slug: "cc-opus" })).toBe("cc-opus");
	});

	test("REFUSES the 'Lane' sentinel — never spawn debris", () => {
		// A windowName of 'Lane' is the generic sentinel; it must not become the title.
		expect(
			deriveSpawnTaskName({ windowName: "Lane", optionWindowName: "GLM 5.2", slug: "cc-glm52" }),
		).toBe("GLM 5.2");
		expect(deriveSpawnTaskName({ windowName: "lane", optionLabel: "Claude Opus", slug: "cc-opus" })).toBe(
			"Claude Opus",
		);
		// And an option whose only label IS 'Lane' falls to the slug rather than write it.
		expect(deriveSpawnTaskName({ optionWindowName: "Lane", slug: "cc-opus" })).toBe("cc-opus");
	});
});

describe("spawnOptsFromSpawnRequest", () => {
	test("windowName from body is forwarded (pre-name path)", () => {
		const opts = spawnOptsFromSpawnRequest(
			{ windowName: "Spawn-Naming" },
			{},
		);
		expect(opts.windowName).toBe("Spawn-Naming");
	});

	test("windowName from query when body omits it", () => {
		const opts = spawnOptsFromSpawnRequest({}, { windowName: "Q-Name" });
		expect(opts.windowName).toBe("Q-Name");
	});

	test("body windowName wins over query", () => {
		const opts = spawnOptsFromSpawnRequest({ windowName: "Body" }, { windowName: "Query" });
		expect(opts.windowName).toBe("Body");
	});

	test("windowName undefined when neither supplies it (no override → spawn-core's default name)", () => {
		const opts = spawnOptsFromSpawnRequest({}, {});
		expect(opts.windowName).toBeUndefined();
	});

	test("focus defaults to false when absent (preserves prior route precedence)", () => {
		// `body.focus ?? (query.focus === "true")` → undefined ?? false → false.
		// spawnOptionInSession's own `?? true` default only applies when a
		// caller omits focus entirely; the route always sends a boolean.
		const opts = spawnOptsFromSpawnRequest({}, {});
		expect(opts.focus).toBe(false);
	});

	test("focus body boolean honoured; query 'true'/'false' string parsed", () => {
		expect(spawnOptsFromSpawnRequest({ focus: false }, {}).focus).toBe(false);
		expect(spawnOptsFromSpawnRequest({}, { focus: "true" }).focus).toBe(true);
		expect(spawnOptsFromSpawnRequest({}, { focus: "false" }).focus).toBe(false);
		expect(spawnOptsFromSpawnRequest({}, { focus: null }).focus).toBe(false);
		// body wins over query
		expect(spawnOptsFromSpawnRequest({ focus: true }, { focus: "false" }).focus).toBe(true);
	});

	test("resumeId forwarded body→query fallback, undefined when absent", () => {
		const id = "019f25ae-1454-7000-aa31-0a14bf7725f9";
		expect(spawnOptsFromSpawnRequest({ resumeId: id }, {}).resumeId).toBe(id);
		expect(spawnOptsFromSpawnRequest({}, { resumeId: id }).resumeId).toBe(id);
		expect(spawnOptsFromSpawnRequest({ resumeId: id }, { resumeId: "stale" }).resumeId).toBe(id);
		expect(spawnOptsFromSpawnRequest({}, {}).resumeId).toBeUndefined();
	});
});
