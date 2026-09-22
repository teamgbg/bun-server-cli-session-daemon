/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Tail a JSONL transcript file with event-driven fs watch (no polling).
 * Watches the PARENT projects dir (~/.claude/projects/) because Claude writes
 * to a subdir based on its cwd at launch, which may differ from the fleet
 * workdir. Uses readFile (not FileHandle) to avoid GC-collected handle crashes.
 */

// `statSync` was USED below and never imported. The call sat inside a bare
// empty catch block, so the ReferenceError it threw on every scan was swallowed
// whole: `scanForFile` could not find a transcript under any circumstances,
// and the only symptom was the 60s timeout. A bare catch around a call to an
// unbound identifier turns a crash into a permanent silent no-op — the exact
// shape of `a-component-may-not-report-a-state-it-has-not-verified`.
		// WATCH EVERY SUBDIRECTORY, not just the parent. Claude writes to `<projectsDir>/<cwd-slug>/<uuid>.jsonl` — one level DOWN — and a watch
		// on the parent alone never fires for writes inside an existing subdir. The parent watch is still needed, but only for the case it can
		// actually see: a NEW cwd-slug directory appearing.
		//
		// This was the whole defect. The watcher armed, the transcript was appended to continuously, and no event ever arrived: the initial
		// `scanForFile()` found nothing (no file had an mtime past startTime yet), the parent never changed again because its subdir already
		// existed, and the scan was never re-entered. Every lane died on the 60s timeout with "transcript file did not appear" while sitting next
		// to an actively-growing file.
		//
		// Measured 2026-08-06 against a live session whose transcript was 5.8 MB and being written that second: parent-only watch failed at exactly
		// 60000ms, and `{ recursive: true }` did NOT fix it — this runtime does not honour the flag on Linux, so the portable shape is explicit
		// per-subdir watches. That failure is why every Claude Code lane stayed `lifecycle_state = 'registering'` and was therefore invisible to
		// `send_orchestrator_message`, which gates delivery on `active`.

import { readdir } from "node:fs/promises";
import { watch as watchFs } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@teamscala/logger/creator";

const logger = createLogger({ service: "cli-session" });

export interface TranscriptWatcherHandle {
	stop(): void;
}

/**
 * Wait for a JSONL file to appear under `projectsDir` (scanning ALL subdirs),
 * then tail it. Resolves once the file is found + the first line is read.
 * Calls `onLine` for each subsequent parsed JSON line.
 */
export function watchTranscript(
	projectsDir: string,
	matches: (filepath: string) => boolean,
	onLine: (line: unknown, raw: string, isBacklog: boolean) => void,
	timeoutMs = 60_000,
	startTime = Date.now(),
): Promise<{ sessionId: string; handle: TranscriptWatcherHandle }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let dirWatcher: ReturnType<typeof watchFs> | null = null;
		let fileWatcher: ReturnType<typeof watchFs> | null = null;
		let targetPath: string | null = null;
		let readBytes = 0;
		const subdirWatchers = new Map<string, ReturnType<typeof watchFs>>();
		let resolvedSessionId: string | null = null;
		// Lines already in the file when the watcher arms are HISTORY, not live
		// events. The first drain must read from byte 0 (the session id only
		// exists inside the content), so without this flag a restart
		// re-announces every past turn as if it were happening now. A stable
		// idempotency key makes a replay idempotent, but the FIRST post-fix
		// replay still writes one row per historical turn — and a lifecycle
		// transition is a claim about NOW, so backfill must not assert one.
		let backfillComplete = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(new Error(`transcript file did not appear within ${timeoutMs}ms`));
			}
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			for (const w of subdirWatchers.values()) w.close();
			subdirWatchers.clear();
			dirWatcher?.close();
			fileWatcher?.close();
		}

		function handleLine(raw: string): void {
			try {
				const parsed = JSON.parse(raw);
				if (!resolvedSessionId && typeof parsed.sessionId === "string") {
					resolvedSessionId = parsed.sessionId;
				}
				onLine(parsed, raw, !backfillComplete);
			} catch (error) {
				logger.debug("[transcript-watcher] unparseable/partial transcript line skipped", error);
			}
		}

		async function drain(): Promise<void> {
			if (!targetPath || !await Bun.file(targetPath).exists()) return;
			const buf = readFileSync(targetPath);
			if (buf.length <= readBytes) return;
			const newChunk = buf.subarray(readBytes).toString("utf8");
			readBytes = buf.length;
			let leftover = newChunk;
			let idx: number;
			while ((idx = leftover.indexOf("\n")) >= 0) {
				const line = leftover.slice(0, idx);
				leftover = leftover.slice(idx + 1);
				if (!line.trim()) continue;
				handleLine(line);
			}
			// Everything read above was already on disk when this drain began.
			// Anything arriving after this point is a live append.
			backfillComplete = true;
			if (!settled && resolvedSessionId) {
				settled = true;
				resolve({ sessionId: resolvedSessionId, handle: { stop: cleanup } });
			}
		}

		async function scanForFile(): Promise<void> {
			if (settled || targetPath) return;
			try {
				for (const subdir of await readdir(projectsDir)) {
					const dir = join(projectsDir, subdir);
					try {
						for (const name of await readdir(dir)) {
							const fp = join(dir, name);
							const stat = statSync(fp);
							if (matches(fp) && stat.mtimeMs > startTime) {
								targetPath = fp;
								dirWatcher?.close();
								dirWatcher = null;
								drain();
								if (!settled) {
									fileWatcher = watchFs(targetPath, () => drain());
								}
								return;
							}
						}
					} catch (error) {
						logger.warn("[transcript-watcher] inner transcript scan failed; continuing", error);
					}
				}
			} catch (error) {
				logger.warn("[transcript-watcher] transcript directory scan failed; continuing", error);
			}
		}
		async function armSubdirWatches(): Promise<void> {
			try {
				for (const subdir of await readdir(projectsDir)) {
					const dir = join(projectsDir, subdir);
					if (subdirWatchers.has(dir)) continue;
					try {
						if (!statSync(dir).isDirectory()) continue;
						subdirWatchers.set(dir, watchFs(dir, () => scanForFile()));
					} catch (error) {
						logger.warn("[transcript-watcher] subdir watch registration failed; continuing", error);
					}
				}
			} catch (error) {
				logger.warn("[transcript-watcher] projects dir unreadable; retrying next window", error);
			}
		}

		// A new cwd-slug dir is the one thing the parent watch CAN see; arm the
		// new subdir's own watcher when it appears, then rescan.
		dirWatcher = watchFs(projectsDir, () => {
			armSubdirWatches();
			scanForFile();
		});
		armSubdirWatches();
		scanForFile();
	});
}
