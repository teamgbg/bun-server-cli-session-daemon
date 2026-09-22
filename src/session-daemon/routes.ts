/**
 * @system cli-session
 * @status handwritten @indivisible-unit owner=finish-session-rekey reason="cohesive route surface; the split it needs is a separate refactor not bundled with a column retirement"
 * @edit edit directly
 *
 * Daemon RPC routes — the HTTP surface the terminal clients call. Mounted
 * onto the daemon's Hono app at boot via mount.ts. This is the single
 * source of truth: every spawn, reconcile, and state read flows through
 * these handlers, so escaping, capture wiring, and state writes can only
 * be wrong in one place.
 *
 * Routes (all under /rpc):
 *   GET  /rpc/options              → active session_picker_option rows
 *   GET  /rpc/sessions             → archived session names
 *   GET  /rpc/picker-data          → live + archived + options for the rich TUI
 *   POST /rpc/spawn        {slug,session,focus?} → authenticated operator spawn
 *   POST /rpc/fleet-spawn  {slug,...}           → fleet-policy-bound spawn
 *   POST /rpc/restore {session,windowName?} → sole restore path; ensures shell + reopens tabs (picker session-select trigger)
 *   POST /rpc/rename {paneId,label}        → safe self-rename (resolves caller's window by id)
 *   GET  /rpc/whoami {paneId}              → the caller's tab identity
 *   GET  /rpc/resolve-session {sessionId}  → tab identity for a seeded AI-CLI session id (fleet lane-visibility hook)
 *   POST /rpc/patch-tab {session,windowName,patch} → repair one tab's state
 *   POST /rpc/mutate-session {session,op}  → archive | unarchive | delete a stored row
 *   POST /rpc/menu {session,client}        → daemon presents the spawn display-menu
 *   POST /rpc/pick {client}                → daemon presents the session pick-screen
 */

import { getAppLogger } from "@teamscala/logger/app-loggers";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mutateSessionRow, queryArchivedSessions, resolveTabBySessionId } from "./resolve-and-query.ts";
import { patchTab } from "./tab-mutation.ts";
import { whoamiForPane } from "./whoami.ts";
import { gatherPickerData, getCachedActiveOptions, invalidatePickerCaches } from "./picker-data.ts";
import { showSpawnMenu } from "./show-menu.ts";
import { showSessionPicker } from "./show-session-picker.ts";
import { emitRenameCommand, emitSwitchModelCommand } from "./picker-command-producer.ts";
import { readCommandOutcome } from "./command-outcome.ts";
import { pickerEvents } from "./picker-events.ts";
import { handleSpawn, OPERATOR_SPAWN_TOKEN } from "./spawn-route-handler.ts";
import { registerClosedTabRoutes } from "./closed-tab-routes.ts";

import { recordEvent } from "@teamscala/event-log/record-event";

let routesRegistered = false;

export function registerDaemonRoutes(app: Hono): void {
	if (routesRegistered) {
		return; // Idempotent: skip if already registered
	}
	routesRegistered = true;
	const logger = getAppLogger();

	app.get("/rpc/options", async (c) => {
		// Through the shared 30s cache — never a per-request DB hit
		// (session-picker-rpc-is-cheap). Uncached, this was the poll-storm fuel.
		const options = await getCachedActiveOptions();
		return c.json({ options });
	});

	app.get("/rpc/sessions", async (c) => {
		const sessions = await queryArchivedSessions(365);
		return c.json({ sessions });
	});

	// Typed durable command readback for CLI/UI faces. The picker daemon owns
	// the DB connection; callers poll this small surface rather than opening a
	// second Prisma/raw-SQL connection or guessing completion from tmux state.
	app.get("/rpc/command", async (c) => {
		const id = c.req.query("id");
		if (!id) return c.json({ ok: false, error: "id is required" }, 400);
		const outcome = await readCommandOutcome(id);
		if (!outcome) return c.json({ ok: false, error: "command not found" }, 404);
		return c.json({ ok: true, id, ...outcome });
	});

	// Single read for the rich picker TUI (live + archived + options). The TUI
	// is a stateless view; this is its only data source (no direct tmux/DB).
	app.get("/rpc/picker-data", async (c) => {
		const data = await gatherPickerData();
		return c.json(data);
	});

	// Database-driven picker refresh. The initial event closes the race between
	// the view's first snapshot and subscription establishment; subsequent
	// events are emitted only when Postgres reports a registry write.
	app.get("/rpc/events", (c) =>
		streamSSE(c, async (stream) => {
			let writes = Promise.resolve();
			const unsubscribe = pickerEvents.on("picker.changed", (event) => {
				writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
			});
			await stream.writeSSE({
				data: JSON.stringify({ type: "picker.changed", source: "connected", slug: "" }),
			});
			try {
				await new Promise<void>((resolve) => stream.onAbort(resolve));
			} finally {
				unsubscribe();
				await writes.catch(() => {});
			}
		}),
	);

	// Durable login telemetry: the stateless picker POSTs here (it has no DB /
	// bootloader), the daemon records via its configured event-log. Fire-and-
	// forget on both legs — a failed/missing event never blocks login.
	app.post("/rpc/record-event", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			kind?: string;
			payload?: unknown;
			occurredAt?: string;
		};
		if (typeof body.kind === "string" && body.kind.length > 0) {
			recordEvent({
				kind: body.kind,
				payload: (body.payload ?? null) as Record<string, unknown> | unknown[] | null,
				...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
			});
		}
		return c.json({ ok: true });
	});

	app.post("/rpc/spawn", (c) => handleSpawn("operator", c));
	app.post("/rpc/fleet-spawn", (c) => handleSpawn("fleet", c));

	app.post("/rpc/menu", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			client?: string;
			submenu?: string;
		};
		const session = body.session ?? c.req.query("session");
		const client = body.client ?? c.req.query("client");
		const submenu = body.submenu ?? c.req.query("submenu");
		if (!session || !client) {
			return c.json({ ok: false, error: "session and client are required" }, 400);
		}
		const result = await showSpawnMenu(session, client, submenu, OPERATOR_SPAWN_TOKEN);
		return c.json(result, result.ok ? 200 : 500);
	});

	// Daemon-rendered session pick-screen (per session-picker-is-one-surface):
	// bashrc enters tmux then curls this; the daemon paints a display-menu of
	// live sessions to switch to (plus "new session"). No in-terminal binary.
	app.post("/rpc/pick", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { client?: string };
		// client is optional: bashrc's post-attach trigger omits it and the daemon
		// targets the current client (see show-session-picker.ts).
		const client = body.client ?? c.req.query("client") ?? undefined;
		const result = await showSessionPicker(client);
		return c.json(result, result.ok ? 200 : 500);
	});

	// The tab lifecycle — list, restore, close, annotate. One family, one file.
	registerClosedTabRoutes(app);

	// Move live lanes to a different option (a different model) carrying their
	// conversations. The daemon owns it for the same reason it owns spawn: the
	// switch IS a close-then-respawn, and doing it caller-side would mean
	// building the tmux argv `single-spawn-surface-is-the-daemon` forbids and
	// re-deriving the resumability and CLI-family checks the planner makes
	// structural. `prompt` is the continuation instruction each resumed lane is
	// handed so it picks its work back up instead of idling on a restored
	// transcript; it travels WITH the spawn (a message sent after loses the race
	// with CLI startup). Pass `dryRun` to see the plan without touching a window.
	app.post("/rpc/switch-model", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			to?: string;
			from?: string[];
			windowNames?: string[];
			prompt?: string | null;
			dryRun?: boolean;
			force?: boolean;
		};
		const session = body.session ?? c.req.query("session");
		const to = body.to ?? c.req.query("to");
		if (!session || !to) {
			return c.json({ ok: false, error: "session and to are required" }, 400);
		}
		try {
			const windowNames = body.windowNames ?? [];
			const requestedBy = c.req.header("x-requested-by") ?? c.req.header("x-lane-pane") ?? "unknown";
			const commandIds: string[] = [];
			for (const wn of windowNames) {
				const { command_id } = await emitSwitchModelCommand({
					windowName: wn,
					tmuxSession: session,
					targetSlug: to,
					requestedBy,
				});
				commandIds.push(command_id);
			}
			return c.json({ ok: true, command_ids: commandIds, status: "pending" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("rpc/switch-model failed", { session, to, error: msg });
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	// Operator-managed visibility of STORED session rows, data-driven: the `op`
	// (archive | unarchive | delete) is DATA and mutateSessionRow is the single
	// executor (it owns the live-guard — never interrupt a running session — and
	// the row mutation). Archive = hide (row kept, restorable); delete = remove
	// permanently. The stateless picker POSTs {session, op}; the daemon mediates
	// because the view must not touch the DB (session-picker-is-one-surface).
	app.post("/rpc/mutate-session", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { session?: string; op?: string };
		const session = body.session ?? c.req.query("session");
		const op = body.op ?? c.req.query("op");
		if (!session) return c.json({ ok: false, error: "session is required" }, 400);
		if (op !== "archive" && op !== "unarchive" && op !== "delete") {
			return c.json({ ok: false, error: "op must be one of: archive, unarchive, delete" }, 400);
		}
		const result = await mutateSessionRow(session, { op });
		if (result.ok) invalidatePickerCaches();
		return c.json({ session, ...result }, result.ok ? 200 : 400);
	});

	// The single safe rename surface. The caller passes its OWN pane id
	// ($TMUX_PANE); the daemon resolves that pane's window and renames BY ID, so
	// "rename me" can never hit another pane. `scala-tools session rename` is the
	// only sanctioned caller (raw `tmux rename-window` is guard-blocked).
	app.post("/rpc/rename", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			paneId?: string;
			label?: string;
		};
		const paneId = body.paneId ?? c.req.query("paneId");
		const label = body.label ?? c.req.query("label");
		if (!paneId || !label) {
			return c.json({ ok: false, error: "paneId and label are required" }, 400);
		}
		const { command_id } = await emitRenameCommand({
			windowId: paneId,
			newName: label,
			tmuxSession: "",
		});
		return c.json({ ok: true, command_id, status: "pending" });
	});

	// Whole-session renames have NO verb: a session's name IS its developer
	// project's work_items.title (migration 542), and the host-command-bus
	// reconciler (`session_names.rs`) converges tmux on every title change —
	// boot + background pass + the developer_session_renamed fast path.

	// "What am I" — the caller's tab identity, resolved from its own pane id.
	app.get("/rpc/whoami", async (c) => {
		const paneId = c.req.query("paneId");
		if (!paneId) return c.json({ ok: false, error: "paneId is required" }, 400);
		return c.json(await whoamiForPane(paneId));
	});

	// Resolve a Claude/AI-CLI session id (the seeded --session-id) to its live
	// tab identity — the work-name the fleet lane-visibility hook handler needs
	// at event time (lanes-named-by-the-spawner: fresh resolve, never baked).
	app.get("/rpc/resolve-session", async (c) => {
		const sessionId = c.req.query("sessionId");
		if (!sessionId) return c.json({ ok: false, error: "sessionId is required" }, 400);
		return c.json(await resolveTabBySessionId(sessionId));
	});

	app.post("/rpc/patch-tab", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			session?: string;
			windowName?: string;
			patch?: Record<string, unknown>;
		};
		if (!body.session || !body.windowName || !body.patch) {
			return c.json({ ok: false, error: "session, windowName, and patch are required" }, 400);
		}
		try {
			await patchTab(body.session, body.windowName, body.patch);
			return c.json({ ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("rpc/patch-tab failed", {
				session: body.session,
				windowName: body.windowName,
				error: msg,
			});
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	logger.info(
		"daemon: RPC routes registered (/rpc/options, /rpc/sessions, /rpc/spawn, /rpc/close, /rpc/annotate-closed-tab, /rpc/switch-model, /rpc/rename, /rpc/whoami, /rpc/resolve-session, /rpc/closed-tabs, /rpc/restore, /rpc/patch-tab, /rpc/mutate-session, /rpc/menu, /rpc/pick)",
	);
}
