// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterAll, describe, test, expect, mock } from "bun:test";
import { mockModuleRestorable, restoreMockedModules } from "./mock-module-restore.ts";

// ── Mock the canonical enqueue_host_command function boundary ──

interface CapturedCommand {
	command: string;
	payload: Record<string, unknown>;
	status: string;
	originator: unknown;
}

let captured: CapturedCommand[] = [];

await mockModuleRestorable("@teamscala/db/sql/execute-pg-function", (real) => ({
	...real,
	executePgFunction: (
		name: string,
		args: {
			p_command: string;
			p_payload: string;
			p_originator: string | null;
		},
	): Promise<string> => {
		if (name !== "enqueue_host_command") {
			throw new Error(`unexpected function ${name}`);
		}
		captured.push({
			command: args.p_command,
			payload: JSON.parse(args.p_payload),
			status: "pending",
			originator: args.p_originator ? JSON.parse(args.p_originator) : null,
		});
		return Promise.resolve(`test-${Date.now()}-${captured.length}`);
	},
}));
afterAll(() => restoreMockedModules());

// Import AFTER the mock is set up so the producer uses the mocked DB function.
const {
	emitSpawnCommand,
	emitCloseCommand,
	emitRenameCommand,
	emitSwitchModelCommand,
	emitRestoreSessionCommand,
} = await import("./picker-command-producer.ts");

function lastCaptured(): CapturedCommand {
	const cmd = captured[captured.length - 1];
	if (!cmd) throw new Error("no command was captured");
	return cmd;
}

// ── E2E fixtures ─────────────────────────────────────────────────────────────

describe("picker producer E2E — DB row shape (mocked enqueue function)", () => {
	test("emitSpawnCommand writes a well-formed picker_spawn_tab row", async () => {
		await emitSpawnCommand({
			slug: "test-claude-glm52",
			tmuxSession: "joe",
			focus: true,
			requestedBy: "test-operator",
			windowName: "Test Lane",
			workItemId: "wk-123",
			launchCommentId: "comment-123",
			initialPrompt: "do the thing",
		});
		const cmd = lastCaptured();
		expect(cmd.command).toBe("picker_spawn_tab");
		expect(cmd.status).toBe("pending");
		expect(cmd.originator).toEqual({
			orchestratorSessionId: "test-operator",
		});
		expect(cmd.payload.slug).toBe("test-claude-glm52");
		expect(cmd.payload.tmuxSession).toBe("joe");
		expect(cmd.payload.requestedBy).toBe("test-operator");
		expect(cmd.payload.windowName).toBe("Test Lane");
		expect(cmd.payload.workItemId).toBe("wk-123");
		expect(cmd.payload).not.toHaveProperty("initialPrompt");
		expect(cmd.payload.focus).toBe(true);
	});

	test("emitCloseCommand writes a well-formed picker_close_tab row", async () => {
		await emitCloseCommand({
			windowName: "Stale Lane",
			tmuxSession: "joe",
			requestedBy: "test-operator",
			disposition: "completed",
		});
		const cmd = lastCaptured();
		expect(cmd.command).toBe("picker_close_tab");
		expect(cmd.status).toBe("pending");
		expect(cmd.payload.windowName).toBe("Stale Lane");
		expect(cmd.payload.tmuxSession).toBe("joe");
		expect(cmd.payload.disposition).toBe("completed");
	});

	test("emitRenameCommand writes a well-formed picker_rename_window row", async () => {
		await emitRenameCommand({
			windowId: "%529",
			newName: "New Work Label",
			tmuxSession: "joe",
		});
		const cmd = lastCaptured();
		expect(cmd.command).toBe("picker_rename_window");
		expect(cmd.status).toBe("pending");
		expect(cmd.payload.windowId).toBe("%529");
		expect(cmd.payload.newName).toBe("New Work Label");
	});

	test("emitSwitchModelCommand writes a well-formed picker_switch_model row", async () => {
		await emitSwitchModelCommand({
			windowName: "Old Model Lane",
			tmuxSession: "joe",
			targetSlug: "cc-opus4",
			resumeId: "abc-123-def",
			requestedBy: "test-operator",
		});
		const cmd = lastCaptured();
		expect(cmd.command).toBe("picker_switch_model");
		expect(cmd.status).toBe("pending");
		expect(cmd.payload.targetSlug).toBe("cc-opus4");
		expect(cmd.payload.resumeId).toBe("abc-123-def");
	});

	test("emitRestoreSessionCommand writes a well-formed picker_restore_session row", async () => {
		await emitRestoreSessionCommand({
			tmuxSession: "joe",
			windowName: "DB Theming",
		});
		const cmd = lastCaptured();
		expect(cmd.command).toBe("picker_restore_session");
		expect(cmd.status).toBe("pending");
		expect(cmd.payload.tmuxSession).toBe("joe");
		expect(cmd.payload.windowName).toBe("DB Theming");
	});

	test("every emitted row has status=pending (producer never claims)", async () => {
		captured = []; // reset
		await emitSpawnCommand({ slug: "s", tmuxSession: "t", requestedBy: "r", workItemId: "task-1", launchCommentId: "comment-1" });
		await emitCloseCommand({ windowName: "w", tmuxSession: "t", requestedBy: "r" });
		await emitRenameCommand({ windowId: "p", newName: "n", tmuxSession: "t" });
		await emitSwitchModelCommand({ windowName: "w", tmuxSession: "t", targetSlug: "s", requestedBy: "r" });
		await emitRestoreSessionCommand({ tmuxSession: "t" });
		for (const cmd of captured) {
			expect(cmd.status).toBe("pending");
		}
		expect(captured.length).toBe(5);
	});

	test("spawn writes the operator picker identity as durable originator", async () => {
		captured = [];
		await emitSpawnCommand({ slug: "s", tmuxSession: "t", requestedBy: "r", workItemId: "task-1", launchCommentId: "comment-1" });
		const cmd = lastCaptured();
		expect(cmd.originator).toEqual({ orchestratorSessionId: "r" });
	});
});

/**
 * LIVE E2E belongs to scala-tools daemon_flow.
 *
 * When the Rust bus has compiling, committed, deployed picker handlers, enable
 * these by removing the .skip and ensuring DATABASE_URL is set. The test then
 * verifies the FULL pipeline:
 *
 *   emitSpawnCommand → INSERT host_commands → pg_notify('host_command_bus')
 *   → Rust bus claims (FOR UPDATE SKIP LOCKED) → tmux new-window
 *   → outcome written back → row status = 'completed'
 *
 * This is the real DB row → durable event → pane E2E the operator wants.
 */
describe.skip("picker producer LIVE E2E — DB row → event → pane", () => {
	test("spawn command flows through the full bus to a live pane", async () => {
		// This test requires:
		// 1. A real DATABASE_URL
		// 2. The Rust host-command-bus running with picker handlers
		// 3. A test tmux session + a disposable session_picker_option
		//
		// Steps:
		// - emitSpawnCommand with a test slug + session
		// - Poll the host_commands row until status = 'completed' (timeout 5s)
		// - Assert the result contains { ok: true, windowName, paneId }
		// - Assert a tmux window exists with that name
		// - Clean up: kill the window, archive the tab
		expect(true).toBe(true); // placeholder
	});
});
