/**
 * @system cli-session
 * @status handwritten
 * @edit the tab lifecycle routes — list, restore, close, annotate
 *
 * One family, one file. registerDaemonRoutes registered every RPC in a single
 * 446-line body; these four are the open/close log and its transitions, and
 * they move together because they are the same story: a tab is archived, its
 * archive is listed, one entry is reopened, and a fact resolved after the
 * close is written back onto it.
 */
import { CALLER_HEADERS } from "@teamscala/os/contracts/mcp";
import { getAppLogger } from "@teamscala/logger/app-loggers";
import type { Hono } from "hono";

import { loadSessionState } from "./load-save.ts";
import { annotateClosedTab } from "./tab-mutation.ts";
import { emitCloseCommand, emitRestoreSessionCommand } from "./picker-command-producer.ts";

/** Register the tab lifecycle RPCs on the daemon app. */
export function registerClosedTabRoutes(app: Hono): void {
	const logger = getAppLogger();
	// The open/close log: list the closed (archived) tabs for a session, each
	// with its resume id and close timestamp — the answer to "what tabs were
	// closed and when".
	app.get("/rpc/closed-tabs", async (c) => {
		const session = c.req.query("session");
		if (!session) return c.json({ ok: false, error: "session is required" }, 400);
		try {
			const state = await loadSessionState(session);
			return c.json({ ok: true, session, closedTabs: state.closedTabs ?? [] });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	// The SOLE restore path — boot opens nothing, so nothing is restored
	// automatically (no CLI is ever spawned into a session nobody is attached
	// to). Reopens every tab not currently live — crash-lost OPEN tabs
	// (preserved in tabs[] across a hard reboot) and, with `windowName`, one
	// CLOSED archive tab — resumed to their conversations and KEPT AT THEIR
	// STORED NAME. Ensures the tmux session has its picker home window first, so
	// a restored session is still usable for launching/switching after attach.
	// Idempotent: live tabs are skipped, so restoring a fully-live session is a
	// safe no-op. This is the trigger the rich picker calls on session-select.
	app.post("/rpc/restore", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			windowName?: string;
		};
		const session = body.session ?? c.req.query("session");
		const windowName = body.windowName ?? c.req.query("windowName") ?? undefined;
		if (!session) return c.json({ ok: false, error: "session is required" }, 400);
		try {
			const { command_id } = await emitRestoreSessionCommand({
				tmuxSession: session,
				windowName,
			});
			return c.json({ ok: true, command_id, status: "pending" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("rpc/restore failed", { session, error: msg });
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	// Close one finished lane BY WINDOW NAME — the sanctioned teardown and the
	// counterpart to /rpc/spawn. close_agent_tab (the fleet MCP tool) is the sole
	// sanctioned caller; a raw `tmux kill-window` is guard-blocked because it
	// bypasses the daemon (leaving an orphaned tab record) and a bare form targets
	// the server's active window so it can kill an unrelated lane mid-work. The
	// daemon resolves the name to a window id server-side, refuses self/busy,
	// kills by id, archives the tab, and stops the tail — all in one operation.
	// Returns {ok:false, error} on a refusal (busy/self/not-found) at 200 rather
	// than throwing: the caller is an orchestrator acting on the reason.
	app.post("/rpc/close", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			windowName?: string;
			force?: boolean;
			disposition?: string;
		};
		const session = body.session ?? c.req.query("session");
		const windowName = body.windowName ?? c.req.query("windowName");
		if (!session || !windowName) {
			return c.json({ ok: false, error: "session and windowName are required" }, 400);
		}
		try {
			const { command_id } = await emitCloseCommand({
				windowName,
				tmuxSession: session,
				requestedBy: c.req.header("x-requested-by") ?? c.req.header("x-lane-pane") ?? "unknown",
				disposition: body.disposition,
				callerTarget: c.req.header(CALLER_HEADERS.TMUX_TARGET) ?? null,
			});
			return c.json({ ok: true, command_id, status: "pending" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("rpc/close failed", { session, windowName, error: msg });
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	// Back-write a fact resolved AFTER the close — close_agent_tab resolves the
	// bound work_items task only once /rpc/close returns the lane's sessionId, so
	// the task id lands here on the just-archived entry rather than on the close
	// path. Best-effort: the disposition (born with the entry) is load-bearing;
	// this is the cross-reference pointer.
	app.post("/rpc/annotate-closed-tab", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			windowName?: string;
			taskId?: string;
		};
		const session = body.session ?? c.req.query("session");
		const windowName = body.windowName ?? c.req.query("windowName");
		if (!session || !windowName) {
			return c.json({ ok: false, error: "session and windowName are required" }, 400);
		}
		try {
			const result = await annotateClosedTab(session, windowName, {
				taskId: body.taskId,
			});
			return c.json({ ok: true, ...result });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("rpc/annotate-closed-tab failed", { session, windowName, error: msg });
			return c.json({ ok: false, error: msg }, 500);
		}
	});
}
