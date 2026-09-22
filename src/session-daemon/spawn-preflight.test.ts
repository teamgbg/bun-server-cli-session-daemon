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
	extractLaunchPaths,
	findMissingBinaries,
	formatPreflightError,
} from "./spawn-preflight.ts";

const HOME = "/home/joe-bellissimo";

// The real cc-opus48 command, trimmed to its structure.
const CLAUDE_CMD =
	'P=$TMUX_PANE; (for i in $(seq 1 200); do sleep 0.2; done) & systemd-run --user --quiet --slice=ai-cli.slice --scope -- ${HOME}/.local/bin/claude --model opus --dangerously-skip-permissions';

describe("extractLaunchPaths", () => {
	test("substitutes ${HOME} and finds the launch binary", async () => {
		expect(extractLaunchPaths(CLAUDE_CMD, HOME)).toContain(`${HOME}/.local/bin/claude`);
	});

	test("substitutes bare $HOME/ too", async () => {
		expect(extractLaunchPaths("$HOME/.local/bin/opencode --version", HOME)).toContain(
			`${HOME}/.local/bin/opencode`,
		);
	});

	test("ignores /proc, /sys, /dev references", async () => {
		const got = extractLaunchPaths("cat /proc/self/environ; ls /sys/class; /usr/bin/tmux", HOME);
		expect(got).toContain("/usr/bin/tmux");
		expect(got.some((p) => p.startsWith("/proc/"))).toBe(false);
		expect(got.some((p) => p.startsWith("/sys/"))).toBe(false);
	});

	test("an empty command yields nothing", async () => {
		expect(extractLaunchPaths("", HOME)).toEqual([]);
	});
});

describe("findMissingBinaries", () => {
	const probe =
		(table: Record<string, { exists: boolean; executable: boolean }>) => async (p: string) =>
			table[p] ?? { exists: false, executable: false };

	test("a dangling symlink IS reported — the real claude failure", async () => {
		// existsSync follows symlinks, so a link to a deleted target reads as absent.
		const missing = await await findMissingBinaries(
			[`${HOME}/.local/bin/claude`],
			probe({ [`${HOME}/.local/bin/claude`]: { exists: false, executable: false } }),
		);
		expect(missing).toEqual([{ path: `${HOME}/.local/bin/claude`, reason: "missing" }]);
	});

	test("a present executable is NOT reported", async () => {
		expect(
			await findMissingBinaries(
				[`${HOME}/.local/bin/opencode`],
				probe({ [`${HOME}/.local/bin/opencode`]: { exists: true, executable: true } }),
			),
		).toEqual([]);
	});

	test("a present but non-executable file IS reported", async () => {
		// The 0-byte 2.1.220 case: the file exists, it just cannot run.
		const p = `${HOME}/.local/share/claude/versions/2.1.220`;
		expect(await findMissingBinaries([p], probe({ [p]: { exists: true, executable: false } }))).toEqual([
			{ path: p, reason: "not-executable" },
		]);
	});

	test("non-bin paths are ignored, so a log or config path never blocks a spawn", async () => {
		expect(
			await findMissingBinaries(
				[`${HOME}/.claude/settings.json`, "/var/log/thing.log"],
				probe({}),
			),
		).toEqual([]);
	});
});

describe("formatPreflightError", () => {
	test("names the slug, the path, and what to do", async () => {
		const msg = formatPreflightError("cc-opus48", [
			{ path: `${HOME}/.local/bin/claude`, reason: "missing" },
		]);
		expect(msg).toContain("cc-opus48");
		expect(msg).toContain(`${HOME}/.local/bin/claude`);
		expect(msg).toContain("cli-installers.txt");
	});
});
