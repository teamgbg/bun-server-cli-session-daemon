/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Spawn preflight — verify an option's launch binaries exist BEFORE opening a
 * tmux window for it.
 *
 * Why this exists: every other test around the picker verifies the spawn command
 * is BUILT correctly; none verified it could RUN. So when `~/.local/bin/claude`
 * became a dangling symlink (a native auto-update removed 2.1.219 and left a
 * 0-byte 2.1.220), the daemon happily created a window, the exec failed inside
 * tmux, and the operator saw a pane flash and die with the real reason buried in
 * daemon logs (`Failed to find executable ...: No such file or directory`). The
 * picker looked broken; it wasn't — it was faithfully launching a binary that no
 * longer existed. 2026-07-25.
 *
 * This turns that into a loud, actionable refusal at the point of the request.
 */

/**
 * Absolute executable paths referenced by a spawn command.
 *
 * Deliberately conservative — we only extract UNAMBIGUOUS absolute paths
 * (`/...`), which is where the real failure lives: an option that names its
 * interpreter by full path. Bare command names (`bun`, `tmux`) are left alone
 * because resolving them means replicating the spawned shell's PATH, and a
 * wrong guess there would refuse a perfectly good spawn — strictly worse than
 * the current failure mode.
 *
 * `${HOME}` / `$HOME` are substituted per `host-literals-via-substitution`; a
 * row stores the placeholder and the on-disk artifact must carry the real path.
 */

import { createSafeFallback } from "@teamscala/safe-fallback/create-safe-fallback";

export function extractLaunchPaths(command: string, home: string): string[] {
	if (!command) return [];
	const substituted = command
		.replaceAll("${HOME}", home)
		.replaceAll("$HOME/", `${home}/`);

	const out = new Set<string>();
	// An absolute path token: starts with `/`, runs to whitespace or a shell
	// metacharacter that cannot appear inside a path we care about.
	for (const m of substituted.matchAll(/(?<![\w$])(\/[A-Za-z0-9._\-/+]+)/g)) {
		const path = m[1];
		if (!path) continue;
		// Skip obvious non-executables: directory-ish trailing slash, and the
		// device/proc/sys trees a command may legitimately reference.
		if (path.endsWith("/")) continue;
		if (/^\/(proc|sys|dev)\//.test(path)) continue;
		out.add(path);
	}
	return [...out];
}

/** A launch path that is referenced but not executable on this host. */
export interface MissingBinary {
	path: string;
	reason: "missing" | "not-executable";
}

/**
 * Of the extracted paths, those that look like they were MEANT to be executables
 * and are not usable.
 *
 * A path is only reported when it is referenced as a command AND absent/
 * non-executable. A referenced path that exists but is a plain data file (a
 * config, a socket) is not our business — only the launch failure class is.
 */
export async function findMissingBinaries(
	paths: string[],
	probe: (p: string) => Promise<{ exists: boolean; executable: boolean }> = defaultProbe,
): Promise<MissingBinary[]> {
	const out: MissingBinary[] = [];
	for (const path of paths) {
		// Only paths under a bin-ish location are treated as launch targets;
		// otherwise a command referencing e.g. a log path would be flagged.
		if (!/\/(bin|sbin|versions)\//.test(path)) continue;
		const { exists, executable } = await probe(path);
		if (!exists) out.push({ path, reason: "missing" });
		else if (!executable) out.push({ path, reason: "not-executable" });
	}
	return out;
}

// The stat probe is a protective layer: a stat failure after exists()
// succeeded is a race (file deleted between the two calls) and must read as
// not-executable — the preflight REFUSES spawn on that answer, so the
// fallback is fail-closed. Routed through createSafeFallback per
// protective-layers-fail-explicitly (inline try/catch fallbacks are
// blocked by the inline-try-catch-return-fallback gate).
const _statProbe = createSafeFallback<{ exists: boolean; executable: boolean }>({
	name: "cli-session:spawn-preflight-stat",
	onFailure: "fail-closed-warn",
	degradedResult: { exists: false, executable: false },
});

async function defaultProbe(p: string): Promise<{ exists: boolean; executable: boolean }> {
	// Bun.file().exists() follows symlinks, so a DANGLING symlink correctly
	// reports false — that is exactly the claude failure this guard was built
	// for (2026-07-25: a native claude auto-update left ~/.local/bin/claude
	// dangling).
	if (!(await Bun.file(p).exists())) return { exists: false, executable: false };
	return _statProbe.call(async () => {
		const st = await Bun.file(p).stat();
		return { exists: true, executable: st.isFile() && (st.mode & 0o111) !== 0 };
	});
}

/**
 * Human-facing refusal text. Names the exact path and what to do, so the
 * operator never has to go read daemon logs to learn a binary vanished.
 */
export function formatPreflightError(slug: string, missing: MissingBinary[]): string {
	const lines = missing.map(
		(m) =>
			`  ${m.path} — ${m.reason === "missing" ? "missing (or dangling symlink)" : "not executable"}`,
	);
	return [
		`spawn refused for "${slug}": its launch binary is not usable on this host.`,
		...lines,
		`Reinstall it (see infra-config/server/packages/cli-installers.txt), then retry.`,
	].join("\n");
}
