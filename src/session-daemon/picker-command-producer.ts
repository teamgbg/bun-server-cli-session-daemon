/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The picker's PRODUCER surface for durable DB commands. Each picker RPC
 * action (spawn, close, rename, switch-model) writes a PENDING host_commands
 * row through enqueue_host_command and returns the command_id promptly. The
 * picker NEVER claims, executes, or completes — the Rust host-command-bus is
 * the sole claimant/executor/outcome writer (single ownership, no race).
 *
 * The producer uses the sanctioned typed Postgres-function executor — no raw
 * SQL, no postgres.js, and no second DB connection.
 *
 * Command types use the `picker_` prefix to distinguish from the Rust bus's
 * ACP-transport fleet commands (spawn_agent_tab, close_agent_tab).
 */

import { executePgFunction } from "@teamscala/db/sql/execute-pg-function";
export type EnqueueResult = {
	command_id: string;
	status: "pending";
};

async function enqueue(
	command: string,
	payload: Record<string, unknown>,
	originator?: Record<string, unknown> | null,
): Promise<EnqueueResult> {
	const id = (await executePgFunction("enqueue_host_command", {
		p_command: command,
		p_payload: JSON.stringify(payload),
		p_originator: originator != null ? JSON.stringify(originator) : null,
	})) as unknown as string;
	if (!id) throw new Error("enqueue_host_command returned no id");
	return { command_id: id, status: "pending" };
}

// ── Typed emit functions ────────────────────────────────────────────────────
// Each enqueues a pending command and returns { command_id }.
// The Rust bus claims and executes; the picker reads the outcome from the row.

export interface SpawnCommandPayload {
	slug: string;
	tmuxSession: string;
	focus?: boolean;
	resumeId?: string;
	windowName?: string;
	seedId?: string;
	cwd?: string;
	requestedBy: string;
	workItemId: string;
	launchCommentId: string;
	idempotencyKey?: string;
	freshSession?: boolean;
}

export interface CloseCommandPayload {
	windowName: string;
	tmuxSession: string;
	requestedBy: string;
	disposition?: string;
	callerTarget?: string;
}

export interface RenameCommandPayload {
	windowId: string;
	newName: string;
	tmuxSession: string;
}

export interface SwitchModelPayload {
	windowName: string;
	tmuxSession: string;
	targetSlug: string;
	resumeId?: string;
	requestedBy: string;
}

/** Enqueue a pending picker_spawn_tab command. Returns the command_id. */
export async function emitSpawnCommand(
	payload: SpawnCommandPayload & { initialPrompt?: string },
): Promise<EnqueueResult> {
	if (!payload.workItemId.trim() || !payload.launchCommentId.trim()) {
		throw new Error("picker spawn requires canonical workItemId and launchCommentId");
	}
	const { initialPrompt: _briefNotTransported, ...durablePayload } = payload;
	return enqueue("picker_spawn_tab", durablePayload, {
		orchestratorSessionId: payload.requestedBy,
	});
}

/** Enqueue a pending picker_close_tab command. Returns the command_id. */
export async function emitCloseCommand(
	payload: CloseCommandPayload,
): Promise<EnqueueResult> {
	return enqueue("picker_close_tab", payload);
}

/** Enqueue a pending picker_rename_window command. Returns the command_id. */
export async function emitRenameCommand(
	payload: RenameCommandPayload,
): Promise<EnqueueResult> {
	return enqueue("picker_rename_window", payload);
}

/** Enqueue a pending picker_switch_model command. Returns the command_id. */
export async function emitSwitchModelCommand(
	payload: SwitchModelPayload,
): Promise<EnqueueResult> {
	return enqueue("picker_switch_model", payload);
}

export interface RestoreSessionPayload {
	/** The tmux session name to restore tabs into. */
	tmuxSession: string;
	/** Optional: restore only this specific tab by window name. */
	windowName?: string;
}

/** Enqueue a pending picker_restore_session command. Returns the command_id.
 *  The Rust handler reads stored tabs from session-state, ensures the picker
 *  home window exists, and spawns each non-live tab via tmux. Covers the UI
 *  restart/refresh action (restore-in-place = restart with conversation). */
export async function emitRestoreSessionCommand(
	payload: RestoreSessionPayload,
): Promise<EnqueueResult> {
	return enqueue("picker_restore_session", payload);
}
