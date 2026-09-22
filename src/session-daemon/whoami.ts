/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: whoamiForPane, laneSessionForPane.
 */

export interface WhoamiResult {
	ok: boolean;
	paneId?: string;
	windowId?: string;
	sessionName?: string;
	label?: string;
	tabId?: string;
	optionSlug?: string;
}

/** "What am I" — the caller's tab identity, resolved from its own pane id. */
export async function whoamiForPane(paneId: string): Promise<WhoamiResult> {
	const info = resolvePaneWindow(paneId);
	if (!info?.windowId) return { ok: false };
	const tabs = normaliseTabs((await loadSessionState(info.sessionName)).tabs);
	const tab =
		tabs.find((t) => t.windowId === info.windowId) ??
		tabs.find((t) => t.windowName === info.windowName);
	return {
		ok: true,
		paneId,
		windowId: info.windowId,
		sessionName: info.sessionName,
		label: info.windowName,
		tabId: tab?.tabId,
		optionSlug: tab?.optionSlug,
	};
}

/**
 * The CLI session id bound to a pane's tab — the stable identity a tab rename
 * resolves to (`lane-identity-is-cli-session-id`). The daemon's `/rpc/rename`
 * uses this to back-write the new window name to the bound work_items task's
 * title BY SESSION (never pane: a pane outlives the session inside it, so a
 * pane-keyed update would let a dead session's task answer for a live lane).
 * Returns null when the pane resolves to no tab or the tab carries no session.
 */
export async function laneSessionForPane(paneId: string): Promise<string | null> {
	const info = resolvePaneWindow(paneId);
	if (!info?.windowId) return null;
	try {
		const tabs = normaliseTabs((await loadSessionState(info.sessionName)).tabs);
		const tab =
			tabs.find((t) => t.windowId === info.windowId) ??
			tabs.find((t) => t.windowName === info.windowName);
		return tab?.sessionId ?? null;
	} catch {
		return null;
	}
}

