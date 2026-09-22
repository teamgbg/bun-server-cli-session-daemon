// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { renderEnvPrefix, shellQuote } from "./runtime-tuning-env.ts";

describe("renderEnvPrefix", () => {
	test("renders the tuning the services already use", () => {
		expect(renderEnvPrefix({ JSC_numberOfGCMarkers: "1" })).toBe(
			"export JSC_numberOfGCMarkers='1'; ",
		);
	});

	test("an empty map yields an empty string, not a bare export", () => {
		// A host whose bun-runtime-tuning row is absent must still spawn lanes.
		// Emitting `export ; ` would be a syntax error prefixed onto EVERY lane
		// command — turning a power optimisation into a total spawn outage.
		expect(renderEnvPrefix({})).toBe("");
	});

	test("renders multiple knobs in one prefix", () => {
		const out = renderEnvPrefix({ A: "1", B: "2" });

		expect(out).toContain("export A='1';");
		expect(out).toContain("export B='2';");
		expect(out.endsWith(" ")).toBe(true);
	});

	test("drops a key that is not a valid shell identifier", () => {
		// A key with a space or a dash cannot be exported and would break the
		// whole prefix. Dropping the bad key keeps every good one working, which
		// is the failure mode that costs least.
		expect(renderEnvPrefix({ "not valid": "x", GOOD: "y" })).toBe("export GOOD='y'; ");
	});
});

describe("shellQuote", () => {
	test("wraps a plain value in single quotes", () => {
		expect(shellQuote("1")).toBe("'1'");
	});

	test("neutralises an embedded single quote so a value cannot escape", () => {
		// The command is `sh -c`'d. Without this, a value containing a quote could
		// close the string and run whatever follows in the operator's lane, with
		// the operator's authority. These values come from the registry rather
		// than from a user, but a launcher that is safe only because of who writes
		// its input is one registry edit away from not being safe.
		const quoted = shellQuote("a'; touch /tmp/pwned; echo '");

		expect(quoted.startsWith("'")).toBe(true);
		expect(quoted.endsWith("'")).toBe(true);
		// Every inner quote is escaped, so the string never terminates early.
		expect(quoted).toBe(`'a'\\''; touch /tmp/pwned; echo '\\'''`);
	});

	test("a value with no quotes round-trips unchanged inside the quoting", () => {
		expect(shellQuote("/usr/bin:/bin")).toBe("'/usr/bin:/bin'");
	});
});
