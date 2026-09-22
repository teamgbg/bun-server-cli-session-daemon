// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const DAEMON_DIR = join(import.meta.dir);
const ROUTES_SRC = await Bun.file(join(DAEMON_DIR, "routes.ts")).text();
const PRODUCER_SRC = await Bun.file(join(DAEMON_DIR, "picker-command-producer.ts")).text();
const OUTCOME_SRC = await Bun.file(join(DAEMON_DIR, "command-outcome.ts")).text();

/** Strip comments (// ... and /* ... *\/) so pattern checks hit CODE only. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

const ROUTES_CODE = stripComments(ROUTES_SRC);

describe("routes.ts — enqueue-only compliance", () => {
	test("POST /rpc/spawn handler calls emitSpawnCommand", () => {
		expect(ROUTES_CODE).toContain("emitSpawnCommand");
	});

	test("operator picker spawn mints its task and first comment before enqueue", () => {
		expect(ROUTES_CODE).toContain('kind === "operator"');
		expect(ROUTES_CODE).toContain("mintLaneTask({");
		expect(ROUTES_CODE).toContain("minted?.workItemId");
		expect(ROUTES_CODE).toContain("minted?.launchCommentId");
	});

	test("POST /rpc/close handler calls emitCloseCommand", () => {
		expect(ROUTES_CODE).toContain("emitCloseCommand");
	});

	test("POST /rpc/rename handler calls emitRenameCommand", () => {
		expect(ROUTES_CODE).toContain("emitRenameCommand");
	});

	test("POST /rpc/switch-model handler calls emitSwitchModelCommand", () => {
		expect(ROUTES_CODE).toContain("emitSwitchModelCommand");
	});

	test("POST /rpc/restore handler calls emitRestoreSessionCommand", () => {
		expect(ROUTES_CODE).toContain("emitRestoreSessionCommand");
	});

	test("GET /rpc/command reads typed durable outcomes through the producer adapter", () => {
		expect(ROUTES_CODE).toContain('app.get("/rpc/command"');
		expect(ROUTES_CODE).toContain("readCommandOutcome(id)");
		expect(OUTCOME_SRC).toContain("createBunSqlRunner");
	});

	test("no route calls spawnOptionInSession (legacy direct-tmux spawn)", () => {
		expect(ROUTES_CODE).not.toContain("spawnOptionInSession(");
	});

	test("no route calls closeTabByName (legacy direct-tmux close)", () => {
		expect(ROUTES_CODE).not.toContain("closeTabByName(");
	});

	test("no route calls renameWindowForPane (legacy direct-tmux rename)", () => {
		expect(ROUTES_CODE).not.toContain("renameWindowForPane(");
	});

	test("routes.ts does not import raw DB drivers", () => {
		expect(ROUTES_SRC).not.toMatch(/from\s+["']postgres["']/);
		expect(ROUTES_SRC).not.toMatch(/from\s+["']pg["']/);
		expect(ROUTES_SRC).not.toMatch(/from\s+["']bun:sql["']/);
	});

	test("routes.ts does not import the consumer-side command bus", () => {
		expect(ROUTES_SRC).not.toMatch(/from\s+["']@teamscala\/host-command-bus\/consumer["']/);
		expect(ROUTES_SRC).not.toMatch(/createHostCommandConsumer/);
	});

	test("routes.ts does not call $queryRaw or $executeRaw directly (must go through store)", () => {
		expect(ROUTES_CODE).not.toMatch(/\$queryRaw/);
		expect(ROUTES_CODE).not.toMatch(/\$executeRaw/);
	});
});

describe("picker-command-producer.ts — producer-only invariant", () => {
	test("only calls enqueue, never invoke/claim/complete/fail", () => {
		expect(PRODUCER_SRC).toContain('executePgFunction("enqueue_host_command"');
		expect(PRODUCER_SRC).not.toContain(".invoke(");
		expect(PRODUCER_SRC).not.toContain("claimPending");
		expect(PRODUCER_SRC).not.toContain("claimById");
		expect(PRODUCER_SRC).not.toMatch(/\.complete\(/);
		expect(PRODUCER_SRC).not.toMatch(/\.fail\(/);
	});

	test("uses the sanctioned PG-function writer and typed runner", () => {
		expect(PRODUCER_SRC).toContain('executePgFunction("enqueue_host_command"');
		expect(PRODUCER_SRC).toContain("executePgFunction");
		expect(OUTCOME_SRC).toContain("createBunSqlRunner");
		expect(PRODUCER_SRC).not.toMatch(/from\s+["']postgres["']/);
	});

	test("emits picker commands, no rename-session verb", () => {
		expect(PRODUCER_SRC).toContain('"picker_spawn_tab"');
		expect(PRODUCER_SRC).toContain('"picker_close_tab"');
		expect(PRODUCER_SRC).toContain('"picker_rename_window"');
		expect(PRODUCER_SRC).toContain('"picker_switch_model"');
		expect(PRODUCER_SRC).toContain('"picker_restore_session"');
		expect(PRODUCER_SRC).not.toContain('verb: "dev-access"');
		expect(PRODUCER_SRC).not.toContain('"rename-session"');
	});
});

describe("gap closed — restore and rename routes are enqueue-only", () => {
	test("no route calls restoreSession (legacy direct-tmux restore)", () => {
		expect(ROUTES_CODE).not.toContain("restoreSession(");
	});

	test("no route calls renameTmuxSession (legacy direct-tmux rename-session)", () => {
		expect(ROUTES_CODE).not.toContain("renameTmuxSession(");
	});

	test("no route calls ensurePickerHomeWindow (moved to Rust executor)", () => {
		expect(ROUTES_CODE).not.toContain("ensurePickerHomeWindow(");
	});
});
