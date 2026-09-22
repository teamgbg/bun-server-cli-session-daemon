/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: patchTab, annotateClosedTab, writeCapturedSessionId.
 */

export async function patchTab(
	tmuxSession: string,
	windowName: string,
	patch: {
		optionSlug?: string;
		command?: string;
		cwd?: string;
		sessionId?: string | null;
		tabId?: string;
		/** WHO asked for this tab. Persisted onto the row so ownership is
		 *  queryable from session-state, not only reconstructable from an
		 *  event_log join. */
		requestedBy?: string;
		/** HOW this tab's run ended, stamped by closeTabByName when a deliberate
		 *  close is initiated so the subsequent reconcile carries it into the
		 *  archive instead of the 'orphaned' default. */
		disposition?: string;
	},
): Promise<{ created: boolean; updated: boolean }> {
	const state = await loadSessionState(tmuxSession);
	let tab = state.tabs.find((t) => t.windowName === windowName);
	let createdTab = false;
	if (!tab) {
		tab = {
			tabId: patch.tabId ?? createTabId(),
			optionSlug: patch.optionSlug ?? "",
			windowName,
			command: patch.command,
			cwd: patch.cwd,
			sessionId: patch.sessionId ?? null,
			requestedBy: patch.requestedBy,
			disposition: patch.disposition,
		} as SessionTab;
		state.tabs.push(tab);
		createdTab = true;
	} else {
		if (patch.tabId !== undefined) (tab as SessionTab).tabId = patch.tabId;
		if (patch.optionSlug !== undefined) tab.optionSlug = patch.optionSlug;
		if (patch.command !== undefined) tab.command = patch.command;
		if (patch.cwd !== undefined) tab.cwd = patch.cwd;
		if (patch.sessionId !== undefined) tab.sessionId = patch.sessionId;
		// Only set when supplied: a reconcile pass that does not know the
		// requester must not blank an attribution recorded at spawn.
		if (patch.requestedBy !== undefined) tab.requestedBy = patch.requestedBy;
		if (patch.disposition !== undefined)
			(tab as SessionTab).disposition = patch.disposition;
	}
	await saveSessionState(tmuxSession, { tabs: normaliseTabs(state.tabs) });
	return { created: createdTab, updated: !createdTab };
}

/**
 * Patch a CLOSED-tab archive entry — the back-write surface for a fact resolved
 * AFTER the archive entry was born (close_agent_tab resolves the bound
 * work_items task only once the daemon's close returns the lane's sessionId).
 * Best-effort: a missed write leaves a self-describing 'orphaned' entry, never
 * a silent one. Returns found:false when no entry matches — never throws.
 */
export async function annotateClosedTab(
	tmuxSession: string,
	windowName: string,
	patch: { taskId?: string },
): Promise<{ found: boolean; updated: boolean }> {
	if (patch.taskId === undefined) return { found: false, updated: false };
	const state = await loadSessionState(tmuxSession);
	const closedTabs = state.closedTabs ?? [];
	const entry = closedTabs.find((c) => c.windowName === windowName);
	if (!entry) return { found: false, updated: false };
	if (entry.taskId === patch.taskId) return { found: true, updated: false };
	entry.taskId = patch.taskId;
	await saveSessionState(tmuxSession, {
		tabs: state.tabs,
		closedTabs,
		archived: state.archived,
	});
	return { found: true, updated: true };
}

export async function writeCapturedSessionId(
	tmuxSession: string,
	windowName: string,
	sessionId: string,
	tabId?: string,
): Promise<void> {
	const state = await loadSessionState(tmuxSession);
	if (state.tabs.length === 0) return;
	const tabs = normaliseTabs(state.tabs);
	const tab = tabs.find((candidate) =>
		tabId ? candidate.tabId === tabId : candidate.windowName === windowName,
	);
	if (!tab || tab.sessionId === sessionId) return;
	tab.sessionId = sessionId;
	await saveSessionState(tmuxSession, { tabs });
}

/** Update a tab's mutable label, matched by stable window id. */
async function setTabLabel(
	tmuxSession: string,
	windowId: string,
	label: string,
): Promise<void> {
	const state = await loadSessionState(tmuxSession);
	const tabs = normaliseTabs(state.tabs);
	const tab = tabs.find((t) => t.windowId === windowId);
	if (!tab) return; // not yet recorded — the reconcile id-match will adopt it
	if (tab.windowName === label) return;
	tab.windowName = label;
	await saveSessionState(tmuxSession, { tabs, closedTabs: state.closedTabs });
}

