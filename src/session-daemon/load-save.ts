/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: loadSessionState, saveSessionState, saveSessionStateForKey.
 */

export async function loadSessionState(tmuxSession: string): Promise<SessionStateConfig> {
	const row = await getPrisma().registry_entries.findFirst({
		where: { type: "config", slug: await sessionStateRowKey(tmuxSession) },
		select: { config: true },
	});
	if (!row?.config) return { tabs: [] };
	const parsed = v.safeParse(SessionStateConfigSchema, row.config);
	if (!parsed.success) return { tabs: [] };
	return parsed.output;
}

export async function saveSessionState(
	tmuxSession: string,
	state: SessionStateConfig,
): Promise<void> {
	const slug = await sessionStateRowKey(tmuxSession);
	await saveSessionStateForKey(slug, tmuxSession, state);
}

/** The slug-resolved write: one upsert keyed by an EXACT row slug (the scrub
 * pass holds the row's own slug and must never round-trip it through a name). */
export async function saveSessionStateForKey(
	slug: string,
	labelSource: string,
	state: SessionStateConfig,
): Promise<void> {
	// Load the existing row ONLY when the caller omitted a durable field, so the
	// merge in `buildSessionStateConfig` can inherit it. A caller that supplies
	// both fields (reconcile / restore / spawn) skips the read entirely.
	const inherited =
		state.closedTabs === undefined || state.archived === undefined
			? await loadSessionStateByKey(slug)
			: null;
	const normalisedState = buildSessionStateConfig(state, inherited);
	await getPrisma().registry_entries.upsert({
		where: { type_slug: { type: "config", slug } },
		create: {
			type: "config",
			slug,
			label: `Session state for tmux session "${labelSource}"`,
			config: normalisedState as never,
			is_active: true,
		},
		update: { config: normalisedState as never },
	});
}

async function loadSessionStateByKey(slug: string): Promise<SessionStateConfig> {
	const row = await getPrisma().registry_entries.findFirst({
		where: { type: "config", slug },
		select: { config: true },
	});
	if (!row?.config) return { tabs: [] };
	const parsed = v.safeParse(SessionStateConfigSchema, row.config);
	if (!parsed.success) return { tabs: [] };
	return parsed.output;
}

