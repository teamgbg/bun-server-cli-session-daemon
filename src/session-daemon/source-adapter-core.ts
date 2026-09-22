/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The shared core of every first-class source adapter (Claude
 * Code hooks, Codex native protocol). Each CLI's TRANSPORT normalizes its raw
 * output into the canonical `SourceEvent` union; this module maps those events
 * to durable DB operations and owns the bidirectional todo↔work_items sync with
 * echo-loop prevention. CLI-agnostic — one consumer for three providers
 * (`no transcript tail / scrape / stop hook / fallback in the normal path`).
 *
 * Pure + side-effect-free: it returns a list of `DbOp` descriptors; the caller
 * (the live adapter) executes them against ORPC. That separation is what makes
 * the mapping + echo guard unit-testable without a database.
 */

// --- Canonical event shape (transports normalize to this) -------------------

/**
 * Map one canonical event to zero or more DB operations. Pure: same event in a
 * context always yields the same ops, so the mapping + the echo guard are
 * verifiable without a live database.
 *
 * Echo guard: only `origin:"local"` todo events become `subtask_upsert`. A
 * `remote`-origin todo is our own push reflected back from the CLI's list; the
 * seam applies those silently and does not re-emit them, and this mapper
 * ignores any that slip through. The `echo_token` is belt-and-suspenders — a
 * caller may drop an event whose token it originated.
 */

export type SourceEvent =
	| { type: "session"; id: string; pid: number; version: string; seam_version: number }
	| { type: "state"; busy: boolean }
	| {
			type: "lifecycle";
			phase: LifecyclePhase;
			provider?: string;
			reset_at?: string;
			retry?: boolean;
	  }
	| { type: "token"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool_call"; name: string; args: unknown; call_id?: string }
	| { type: "tool_result"; name: string; output: string; call_id?: string }
	| { type: "usage"; input: number; output: number; cached: number; cache_creation: number }
	| { type: "todo"; action: TodoAction; item: TodoItem; origin: TodoOrigin; echo_token?: string }
	| { type: "retrying"; attempt: number; max: number }
	| { type: "error"; message: string }
	| { type: "done"; response: string; usage?: UsageStats };

export type LifecyclePhase =
	| "session_start"
	| "session_end"
	| "turn_start"
	| "turn_end"
	| "provider_limited"
	| "provider_recovered";

export type TodoAction = "create" | "update" | "complete" | "delete" | "snapshot";
export type TodoOrigin = "local" | "remote";
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: string;
	label: string;
	status: TodoStatus;
}
export interface UsageStats {
	input: number;
	output: number;
	cached: number;
	cache_creation: number;
}

// --- DB operations the mapper emits (caller executes them) ------------------

export interface AdapterCtx {
	cliSessionId: string;
	workItemId: string;
}

export type DbOp =
	| { kind: "message"; content: string; message_type: string }
	| { kind: "transition"; state: string; metadata?: Record<string, unknown> }
	| { kind: "usage"; stats: UsageStats }
	| {
			kind: "turn_end";
			final_output: string;
			usage?: UsageStats;
			error?: boolean;
	  }
	| { kind: "subtask_upsert"; id: string; label: string; status: TodoStatus }
	| { kind: "subtask_complete"; id: string };

export function mapEvent(_ctx: AdapterCtx, event: SourceEvent): DbOp[] {
	switch (event.type) {
		case "token":
			return [{ kind: "message", content: event.text, message_type: "token" }];
		case "reasoning":
			return [{ kind: "message", content: event.text, message_type: "reasoning" }];
		case "tool_call":
			return [
				{
					kind: "message",
					content: `${event.name} ${safeStringify(event.args)}`,
					message_type: "tool_call",
				},
			];
		case "tool_result":
			return [
				{ kind: "message", content: event.output, message_type: "tool_result" },
			];
		case "usage":
			return [
				{
					kind: "usage",
					stats: {
						input: event.input,
						output: event.output,
						cached: event.cached,
						cache_creation: event.cache_creation,
					},
				},
			];
		case "retrying":
			return [
				{
					kind: "message",
					content: `retry ${event.attempt}/${event.max}`,
					message_type: "retrying",
				},
			];
		case "error":
			// The native terminal event on a failed turn: ONE canonical turn_end
			// op — the executor writes the final output + active→idle transition
			// transactionally, correlated by a single id. Never a duplicate idle.
			return [{ kind: "turn_end", final_output: event.message, error: true }];
		case "lifecycle":
			return lifecycleOps(event);
		case "done":
			// The native terminal/end-of-turn event: ONE canonical turn_end op
			// carrying the final agent output + usage. The executor ingests it as
			// the provider-authored terminal message. cli_session_liveness derives
			// idleness from that row; no second lifecycle write exists.
			return [
				{
					kind: "turn_end",
					final_output: event.response,
					usage: event.usage,
				},
			];
		case "todo":
			return todoOps(event);
		case "session":
		case "state":
		default:
			return [];
	}
}

function lifecycleOps(event: Extract<SourceEvent, { type: "lifecycle" }>): DbOp[] {
	switch (event.phase) {
		case "turn_start":
			return [{ kind: "transition", state: "active" }];
		case "turn_end":
			// No-op: the canonical active→idle transition comes from the native
			// terminal event (`done`/`error`), ingested as one turn_end op. Emitting
			// a second idle here would duplicate state, so this is intentionally empty.
			return [];
		case "session_end":
			// session_end → CLOSED is distinct from turn_end → idle. A closed
			// session is terminal; an idle session accepts a new comment → active.
			return [{ kind: "transition", state: "closed" }];
		case "provider_limited":
			return [];
		case "provider_recovered":
			return [];
		default:
			return [];
	}
}

function todoOps(event: Extract<SourceEvent, { type: "todo" }>): DbOp[] {
	// Echo guard: remote-origin todos are our own reflection; never upsert.
	if (event.origin === "remote") return [];
	if (event.action === "complete") {
		return [{ kind: "subtask_complete", id: event.item.id }];
	}
	if (event.action === "delete") return [];
	return [
		{
			kind: "subtask_upsert",
			id: event.item.id,
			label: event.item.label,
			status: event.item.status,
		},
	];
}

function safeStringify(v: unknown): string {
	try {
		return typeof v === "string" ? v : JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/**
 * Whether a todo push from PM→CLI should be suppressed to break an echo loop.
 * The caller tags each outbound push with an echo_token; if the SAME token
 * comes back on a local-origin event, it is our reflection and is dropped.
 */
export function isEchoReflection(
	outboundTokens: Set<string>,
	event: SourceEvent,
): boolean {
	if (event.type !== "todo") return false;
	const token = event.echo_token;
	return typeof token === "string" && outboundTokens.has(token);
}

/**
 * Map a work_items subtask change (PM→CLI direction) to a canonical todo event
 * the transport sends to the CLI. Returns null when the change is not a todo
 * projection (e.g. a status the CLI list cannot express).
 */
export function subtaskToTodoEvent(
	subtask: { id: string; title: string; status: string },
	echoToken: string,
): SourceEvent | null {
	const status = normalizeSubtaskStatus(subtask.status);
	if (!status) return null;
	return {
		type: "todo",
		action: status === "completed" ? "complete" : "update",
		item: { id: subtask.id, label: subtask.title, status },
		origin: "remote",
		echo_token: echoToken,
	};
}

function normalizeSubtaskStatus(s: string): TodoStatus | null {
	switch (s) {
		case "pending":
		case "todo":
		case "open":
			return "pending";
		case "in_progress":
		case "in-progress":
		case "active":
			return "in_progress";
		case "completed":
		case "done":
		case "closed":
			return "completed";
		default:
			return null;
	}
}
