/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Register a visible tab directly against the canonical cli_sessions table.
 * This is the picker-side runtime identity write; fleet lane-event HTTP
 * ingestion is not part of the spawn path.
 *
 * the server — routing through ORPC adds a round-trip through the same process
 * and silently fails when the generated cli_sessions procedures are not
 * registered in this service's ORPC router.
 */

export interface RegisterCliSessionInput {
	/** Injected Prisma client — the daemon owns it, the library receives it. */
	prisma: import("@prisma/client").PrismaClient;
	workItemId: string;
	windowName: string;
	optionSlug: string;
	runtimeSlug?: string;
	provider?: string;
	model?: string;
	paneId?: string;
	nativeSessionId?: string;
	commandId?: string;
}

/** Resolve the runtime role for a work item from the work item itself —
 *  never the mutable title. A title rename must not grant or revoke
 *  orchestrator authority. The orchestrator seat's work item is the
 *  developer-session PROJECT itself (the orchestrator task row no longer
 *  exists); every other assignment is a worker. */
async function resolveRoleForWorkItem(prisma: import("@prisma/client").PrismaClient, workItemId: string): Promise<"orchestrator" | "worker"> {
	const item = await prisma.work_items.findUnique({
		where: { id: workItemId },
		select: { kind: true, kind_data: true },
	});
	if (!item) return "worker";
	const kindData = (item.kind_data ?? {}) as { category?: unknown };
	return item.kind === "project" && kindData.category === "developer_session"
		? "orchestrator"
		: "worker";
}

/** Register or confirm one visible runtime identity for an assigned tab.
 *
 * Role is derived from the work item itself (never the mutable title). The
 * `existing`-lookup reuses a prior session — the Orchestrator pane is ALWAYS
 * pre-registered (the orchestrator-registration path mints a live
 * role='orchestrator' session for its project before its tab opens), so a
 * picker registration for it finds and reuses that row, preserving its
 * 'orchestrator' role. */
export async function registerCliSession(input: RegisterCliSessionInput): Promise<string> {
	const prisma = input.prisma;
	const existing = await prisma.cli_sessions.findFirst({
		where: { work_item_id: input.workItemId, closed_at: null },
		orderBy: { created_at: "desc" },
	});
	if (existing) {
		if (input.nativeSessionId && existing.provider_native_session_id !== input.nativeSessionId) {
			await prisma.cli_sessions.update({
				where: { id: existing.id },
				data: {
					provider_native_session_id: input.nativeSessionId,
					lifecycle_state: "ready",
					adapter_ready_at: new Date(),
				},
			});
		}
		return existing.id;
	}
	const role = await resolveRoleForWorkItem(prisma, input.workItemId);
	const created = await prisma.cli_sessions.create({
		data: {
			authority: "fleet",
			role,
			cli_kind: input.provider ?? "codex",
			picker_option_slug: input.optionSlug,
			runtime_slug: input.runtimeSlug ?? input.optionSlug,
			provider: input.provider ?? "codex",
			model: input.model,
			provider_native_session_id: input.nativeSessionId,
			source_adapter: "session-picker",
			label: input.windowName,
			lifecycle_state: input.nativeSessionId ? "ready" : "registering",
			// The registration writes the launch-derived name, so the provenance
			// stamp travels with it in the same object: the window-name reconciler
			// reads the stamp to know the name is its own output to converge, and
			// never infers that from the shape of the string (2026-08-17).
			host_route: {
				pane_id: input.paneId ?? null,
				window_name: input.windowName,
				window_name_provenance: "derived",
			},
			restore_metadata: {},
			adapter_metadata: { command_id: input.commandId ?? null, visible: true },
			work_item_id: input.workItemId,
			...(input.nativeSessionId ? { adapter_ready_at: new Date() } : {}),
		},
	});
	return created.id;
}
