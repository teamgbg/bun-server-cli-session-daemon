// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, test, expect } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

/** Recursively collect non-test .ts files under a directory. */
async function listSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir)) {
		const full = join(dir, entry);
		if ((await stat(full)).isDirectory()) {
			if (entry === "node_modules" || entry === ".git") continue;
			await listSourceFiles(full, out);
		} else if (
			extname(entry) === ".ts" &&
			!entry.endsWith(".test.ts") &&
			!entry.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

const DAEMON_SRC = join(import.meta.dir);
const SOURCE_FILES = await listSourceFiles(DAEMON_SRC);

describe("picker daemon — producer-only invariant", () => {
	test("no source file imports raw DB drivers (postgres/pg/bun:sql)", async () => {
		const patterns = [
			/from\s+["']postgres["']/,
			/from\s+["']pg["']/,
			/from\s+["']bun:sql["']/,
		];
		const violations: string[] = [];
		for (const file of SOURCE_FILES) {
			const src = await Bun.file(file).text();
			for (const re of patterns) {
				const m = re.exec(src);
				if (m) violations.push(`${file}: ${m[0]}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("no source file imports the consumer-side command bus", async () => {
		const patterns = [
			/from\s+["']@teamscala\/host-command-bus\/consumer["']/,
			/createHostCommandConsumer/,
			/HostCommandDataAccess/,
		];
		const violations: string[] = [];
		for (const file of SOURCE_FILES) {
			const src = await Bun.file(file).text();
			for (const re of patterns) {
				const m = re.exec(src);
				if (m) violations.push(`${file}: ${m[0]}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("picker-command-producer only enqueues, never invokes or claims", async () => {
		const src = await Bun.file(join(DAEMON_SRC, "picker-command-producer.ts")).text();
		expect(src).toContain("enqueue_host_command");
		expect(src).not.toContain(".invoke(");
		expect(src).not.toContain("claimPending");
		expect(src).not.toContain("claimById");
		expect(src).not.toMatch(/\.complete\(/);
		expect(src).not.toMatch(/\.fail\(/);
	});
});
