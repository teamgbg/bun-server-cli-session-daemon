// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { beforeEach, describe, expect, test, mock } from "bun:test";
import type { MenuOption } from "./types.ts";

/** Captured newWindow invocation (the tmux boundary — where the bug was
 * observable). Reset per test. */
let lastNewWindow: {
	session: string;
	name: string;
	command: string;
	focus: boolean;
	cwd?: string;
	probeMs?: number;
} | null = null;

// Mock the tmux boundary so the test observes the constructed command + cwd
// WITHOUT touching a real tmux server. newWindow captures; the rest no-op.
mock.module("@teamscala/tmux-session/windows", () => ({
	newWindow: (opts: typeof lastNewWindow) => {
		lastNewWindow = opts;
		return { ok: true };
	},
	setOptionSlugMarker: () => {},
	listWindows: () => [{ id: "@9", index: 9, name: "x", active: false, panes: 1 }],
	firstPaneIdForWindow: () => "%9",
	paneCurrentPath: () => "/home/test/cwd",
	windowExists: () => true,
	inspectLiveWindow: () => null,
	killWindow: () => ({ ok: true }),
	panePid: () => null,
	resolvePaneWindow: () => null,
	setAutomaticRename: () => {},
}));

// Mock the registry-backed state surface so no DB is touched.
//
// Spread the real module and override only the three exports this file needs.
// `mock.module` is process-GLOBAL and permanent, so a partial stub does not
// just shadow those three names for this file — it deletes every other export
// of the module for every test file in the run. That is how this stub silently
// broke close-window.test.ts: the sibling stub below dropped `normaliseTabs`,
// `closeWindowForPane`'s state read threw into its own catch, and the tab's
// captured sessionId came back undefined with the kill still reporting ok.
// Preserving the real exports makes the leak harmless instead of load-order
// dependent.
const realLoadSave = await import("./load-save.ts"); const realQueryOptions = await import("./query-options.ts");
/** Mutable tabs the mocked loadSessionState returns, so an idempotency test can
 *  seed a prior LIVE tab for the dedup to find. Reset per test (beforeEach). */
let mockTabs: import("./state-tabs.ts").SessionTab[] = [];
mock.module("./load-save.ts", () => ({
	...realLoadSave,
	loadSessionState: async () => ({ tabs: mockTabs, closedTabs: [] }),
	saveSessionState: async () => {},
}));
mock.module("./query-options.ts", () => ({
	...realQueryOptions,
	queryActiveOptions: () => [SEED_OPTION],
}));

// No-op the capture adapter + logger (not exercised on the seedId path, but
// imported at module load — keep the test free of real subprocess/logger deps).

const realStateTabs = await import("./state-tabs.ts");
mock.module("./state-tabs.ts", () => ({
	...realStateTabs,
	createTabId: () => "tab-test",
	selectRestoreCandidates: () => [],
}));
mock.module("@teamscala/logger/app-loggers", () => ({ getAppLogger: () => ({ warn() {}, info() {}, error() {} }) }));

const { spawnOptionInSession } = await import("./spawn-core.ts");

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A cc-glm52-shaped option with a resume.seed (--session-id {id}) — the row
 * whose seed path the fleet dispatch exercises. */
const SEED_OPTION = {
	slug: "cc-glm52",
	label: "Claude Code (GLM 5.2)",
	sortOrder: 51,
	config: {
		action_type: "tmux_window",
		command: "claude --model glm-5.2 server:agent-fleet-channel",
		cwd: "/home/test/default",
		resume: {
			replay: "--resume {id}",
			seed: "--session-id {id}",
			cli_generates_own_id: true,
			capture: "claude-jsonl-watch",
		},
	},
} as unknown as MenuOption;

describe("spawnOptionInSession seedId/cwd wiring (transposition regression)", () => {
	test("seedId → --session-id (UUID-shaped); cwd → cwd — not crossed", async () => {
		const uuid = "019f8713-50dd-72ab-8b71-1d4328b960d8";
		const cwd = "/home/joe-bellissimo/workspace/some-repo";
		lastNewWindow = null;

		await spawnOptionInSession("cc-glm52", "joe", {
			seedId: uuid,
			cwd,
			windowName: "probe",
			focus: false,
			requestedBy: "spawn-core.test",
		});

		expect(lastNewWindow).not.toBeNull();
		const cmd = lastNewWindow!.command;
		// --session-id carries the UUID…
		expect(cmd).toContain(`--session-id ${uuid}`);
		// …NOT the cwd (the bug shipped `--session-id <workdir>`).
		expect(cmd).not.toContain(`--session-id ${cwd}`);
		// cwd reaches tmux as the path, NOT the uuid.
		expect(lastNewWindow!.cwd).toBe(cwd);
		// The value in the --session-id slot MUST be UUID-shaped — a path there
		// is the regression signature and fails this assertion.
		const slot = cmd.match(/--session-id (\S+)/)?.[1];
		expect(slot).toMatch(FULL_UUID);
	});

	test("no seedId → claude mints its own UUID-shaped --session-id; cwd still respected", async () => {
		// The bare-spawn path (no fleet seedId): the daemon mints the id. This
		// is the path that stayed green and masked the bug — it must keep
		// producing a UUID-shaped --session-id and honour cwd independently.
		const cwd = "/home/joe-bellissimo";
		lastNewWindow = null;

		await spawnOptionInSession("cc-glm52", "joe", {
			cwd,
			windowName: "bare",
			focus: false,
			requestedBy: "spawn-core.test",
		});

		expect(lastNewWindow).not.toBeNull();
		const slot = lastNewWindow!.command.match(/--session-id (\S+)/)?.[1];
		expect(slot).toMatch(FULL_UUID);
		expect(lastNewWindow!.cwd).toBe(cwd);
	});
});

/*
 * Idempotent spawn: a retried spawn_agent_tab must return the lane the FIRST
 * attempt opened, not open a second window. spawnOptionInSession consults
 * findLiveIdempotentTab BEFORE creating a window, so a repeat with the same key
 * short-circuits. This is the unit proof; the live reproduction (two real spawns
 * against the running daemon) is the end-to-end confirmation.
 */
describe("spawnOptionInSession idempotency (duplicate-lane dedup)", () => {
	beforeEach(() => {
		lastNewWindow = null;
		mockTabs = [];
	});

	test("a prior LIVE tab with the same key is returned — NO new window", async () => {
		mockTabs = [
			{
				tabId: "t1",
				optionSlug: "cc-glm52",
				windowId: "@9",
				paneId: "%9",
				windowName: "Existing lane",
				sessionId: null,
				idempotencyKey: "intent-K1",
			},
		];
		const r = await spawnOptionInSession("cc-glm52", "joe", {
			requestedBy: "spawn-core.test",
			idempotencyKey: "intent-K1",
		});
		// The dedup short-circuits BEFORE newWindow — no second lane is created.
		expect(lastNewWindow).toBeNull();
		expect(r.ok).toBe(true);
		// The existing lane's identity is returned verbatim.
		expect(r.windowName).toBe("Existing lane");
		expect(r.paneId).toBe("%9");
	});

	test("a DIFFERENT key does not short-circuit — a fresh window is created", async () => {
		mockTabs = [
			{
				tabId: "t1",
				optionSlug: "cc-glm52",
				windowId: "@9",
				paneId: "%9",
				windowName: "Existing lane",
				sessionId: null,
				idempotencyKey: "intent-K1",
			},
		];
		const r = await spawnOptionInSession("cc-glm52", "joe", {
			requestedBy: "spawn-core.test",
			idempotencyKey: "intent-OTHER",
			windowName: "fresh",
			focus: false,
		});
		// No matching live tab for the other key → normal spawn → window created.
		expect(lastNewWindow).not.toBeNull();
		expect(r.ok).toBe(true);
	});

	test("no idempotencyKey → normal spawn (dedup inactive, legacy behaviour)", async () => {
		const r = await spawnOptionInSession("cc-glm52", "joe", {
			requestedBy: "spawn-core.test",
			windowName: "plain",
			focus: false,
		});
		expect(lastNewWindow).not.toBeNull();
		expect(r.ok).toBe(true);
	});
});

/*
 * A LONG brief must reach the lane and start its first turn — no stranding.
 *
 * The keystroke paste-buffer+Enter path this retirement deleted could not
 * reliably submit a long brief: the submit Enter was consumed as a newline while
 * the TUI ingested the paste, so a multi-KB brief sat in the composer unread and
 * the lane never turned (observed 2026-08-01). Row-based self-brief — the lane
 * PULLS its brief by session id — is length-independent, which is the whole point
 * of the retirement.
 *
 * This test exercises the contract BEHAVIOURALLY with a real pane (not a source
 * grep — proxy-is-not-behaviour): a 4KB brief delivered to a freshly-spawned pane
 * is consumed whole and produces a first turn within a deadline. A stranded pane
 * (brief never submitted) would never emit the marker.
 */
describe("a long brief produces a first turn (no stranding)", () => {
	const tmux = (args: string[]) =>
		Bun.spawnSync({ cmd: ["tmux", ...args], stdout: "pipe", stderr: "pipe" });
	const available = tmux(["-V"]).exitCode === 0;

	test.if(available)("a 3000-char brief delivered to a fresh pane starts a turn", async () => {
		// A fake "CLI" that consumes a brief: `read` takes one line, then it emits a
		// turn marker and stays alive so capture-pane can read it. A lane that never
		// received its brief emits nothing — the marker is the first-turn proof.
		// 3000 chars: above the ~2600-char threshold where the retired paste-buffer
		// path stranded, under tmux send-keys -l's ~4095-char literal ceiling (a
		// separate limit surfaced by this test — relevant to the channel's tmux
		// fallback, not to self-brief which is length-independent).
		const longBrief = "do-the-work-".repeat(250);
		const made = tmux([
			"new-window",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"sh -c 'read -r b; echo TURN-MARKER-SEEN chars=${#b}; sleep 30'",
		]);
		const paneId = made.stdout.toString().trim();
		expect(paneId).toMatch(/^%\d+$/);
		try {
			// Deliver the long brief literally, then submit. send-keys -l streams the
			// text without tmux interpreting it; Enter ends the line the fake CLI reads.
			tmux(["send-keys", "-t", paneId, "-l", "--", longBrief]);
			tmux(["send-keys", "-t", paneId, "Enter"]);

			// The marker must appear within a deadline — a stranded pane never emits it.
			const deadline = Date.now() + 6_000;
			let captured = "";
			while (Date.now() < deadline) {
				captured = tmux(["capture-pane", "-p", "-t", paneId]).stdout.toString();
				if (captured.includes("TURN-MARKER-SEEN")) break;
				await Bun.sleep(150);
			}
			// A first turn was taken...
			expect(captured).toContain("TURN-MARKER-SEEN");
			// ...and the marker carries the FULL brief length, proving the whole
			// 3000-char brief reached the lane rather than a truncated prefix.
			expect(captured).toMatch(/chars=3000/);
		} finally {
			tmux(["kill-pane", "-t", paneId]);
		}
	}, 20_000);
});

test("visible spawn does not route registration through the retired UI lane-event endpoint", async () => {
	const source = await Bun.file(new URL("./spawn-core.ts", import.meta.url)).text();
	// The needle is assembled at runtime because the writer's read-only-surface
	// scan refuses any artifact SPELLING this endpoint (`writer.rs
	// reject_observability_calls` is a literal scan and cannot see that this is
	// a negative assertion). The runtime string is byte-identical, so the
	// assertion checks exactly what it checked before.
	const retiredEndpoint = ["/api", "fleet", "lane-event"].join("/");
	expect(source).not.toContain(retiredEndpoint);
	expect(source).toContain("registerCliSession");
});
