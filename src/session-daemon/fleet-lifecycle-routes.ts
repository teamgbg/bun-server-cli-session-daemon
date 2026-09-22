/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The fleet-worker close-by-pane lifecycle route (used by fleet-procedures).
 */

import type { Hono } from "hono";
import { closeWindowForPane } from "./rename-close.ts";

interface CloseByPaneBody {
	paneId: string;
}

/** Register the close-by-pane route onto the daemon's Hono app. */
export function registerFleetLifecycleRoutes(app: Hono): void {
	// Close a fleet-worker tab BY PANE ID — the tmux-runtime half of close_run.
	// The daemon resolves the pane to its window id and kills it (never name/index).
	app.post("/rpc/close-by-pane", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Partial<CloseByPaneBody>;
		const paneId = body.paneId ?? c.req.query("paneId");
		if (!paneId) {
			return c.json({ ok: false, error: "paneId is required" }, 400);
		}
		const result = await closeWindowForPane(paneId);
		return c.json(result, result.ok ? 200 : 400);
	});
}
