/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: reconcileSessionState.
 */

export async function reconcileSessionState(
	tmuxSession: string,
	liveWindowsOrNames: Array<string | TmuxWindow>,
): Promise<{ added: number; removed: number; skipped: string[] }> {
	const existingState = await loadSessionState(tmuxSession);
	const existingTabs = normaliseTabs(existingState.tabs);
	const liveWindows = normaliseLiveWindows(
		tmuxSession,
		liveWindowsOrNames.map((windowOrName) =>
			typeof windowOrName === "string"
				? ({ id: "", index: 0, name: windowOrName, active: false, panes: 1 } satisfies TmuxWindow)
				: windowOrName,
		),
	);
	const live = new Set(liveWindows.map((w) => w.name));

	if (liveWindows.length <= 1 && existingTabs.length > 1) {
		return { added: 0, removed: 0, skipped: ["skipped: would prune all tabs"] };
	}

	// Durability guard (record-clobber prevention): a live read fully disjoint
	// from a multi-tab record is socket churn (a replaced/dead tmux server), not
	// real closes — preserve the record instead of wiping it. Detail + the
	// 2026-06-14 moss incident: ./reconcile-guard.ts.
	if (isSuspectedTmuxChurn(existingTabs, live)) {
		return {
			added: 0,
			removed: 0,
			skipped: ["skipped: live windows disjoint from record (suspected tmux churn)"],
		};
	}

	// Id-anchored matching (pure, unit-tested in state-tabs.test.ts): a renamed
	// window (same id, new name) stays the SAME tab with its label refreshed,
	// instead of being closed-and-readopted — the rename-blindness fix.
	const { kept, closedNow, missing, mutatedKept } = matchTabsToLive(
		existingTabs,
		liveWindows,
	);
	const removed = closedNow.length;
	// Archive pruned tabs (window gone) into closedTabs[] with a close
	// timestamp instead of dropping them — this is the open/close log and the
	// source for one-command restore (a closed tab keeps its resume id, so
	// reopening it resumed is a lookup, not a transcript dig). Dedup by
	// windowName, newest wins; the cap is applied in saveSessionState.
	const nowIso = new Date().toISOString();
	const priorClosed = (existingState.closedTabs ?? []).filter(
		(c) => !closedNow.some((t) => t.windowName === c.windowName),
	);
	const newlyClosed: SessionClosedTab[] = closedNow.map((t) =>
		buildClosedTabEntry(t, nowIso),
	);
	const nextClosedTabs = [...priorClosed, ...newlyClosed];

	const skipped: string[] = [];
	const adoptedTabs: SessionTab[] = [];
	if (missing.length > 0) {
		const options = await queryActiveOptions().catch(() => [] as MenuOption[]);
		for (const window of missing) {
			const info = inspectLiveWindow(tmuxSession, window.id || window.name);
			if (!info) {
				skipped.push(`${window.name}: tmux inspect failed`);
				continue;
			}
			const innerCommand = unwrapLoginShell(info.startCommand);
			const slug = info.optionSlugMarker ?? inferOptionSlugFromCommand(innerCommand, options);
			if (!slug) {
				skipped.push(`${window.name}: no matching option (cmd=${innerCommand.slice(0, 60)})`);
				continue;
			}
			setOptionSlugMarker(tmuxSession, window.id || window.name, slug);
			const opt = options.find((o) => o.slug === slug);
			const sessionId = extractSessionIdFromCommand(innerCommand);
			const tabId = createTabId();
			adoptedTabs.push({
				tabId,
				optionSlug: slug,
				windowId: window.id || undefined,
				paneId: window.id ? (firstPaneIdForWindow(window.id) ?? undefined) : undefined,
				windowName: window.name,
				// Store the option's COMMAND TEMPLATE, not the live pane's
				// materialised start command. The latter has resolved `secret_env`
				// values baked in (export SECRET='literal'), which would leak via
				// /rpc/closed-tabs; the template never holds a credential
				// (credentials-only-in-secret-rows). Replay uses `sessionId` below.
				command: opt?.config.command,
				cwd: info.currentPath || undefined,
				sessionId,
			});
			if (!sessionId && info.currentPath) {
				// capture path removed — source-adapter bridge replaces adoption
			}
		}
	}

	const added = adoptedTabs.length;
	const normalisedExisting = existingTabs.length !== existingState.tabs.length;
	// `mutatedKept` covers the rename-in-place case (a kept tab's label/windowId
	// changed) — without it a pure rename would be a no-op write and the label
	// would never persist.
	if (added === 0 && removed === 0 && !mutatedKept && !normalisedExisting)
		return { added, removed, skipped };

	const nextTabs = [...kept, ...adoptedTabs];
	// Preserve the operator-set archived flag across reconcile writes — a row
	// that was hidden stays hidden if its session is briefly reopened then closed
	// again (the flag is only flipped via /rpc/{un,}archive-session).
	await saveSessionState(tmuxSession, {
		tabs: nextTabs,
		closedTabs: nextClosedTabs,
		archived: existingState.archived,
	});
	return { added, removed, skipped };
}

/**
 * The row key for a tmux session's session-state state. A session owned by a
 * developer-seat project keys on the IMMUTABLE project id (developer-seat-map:
 * a slug derived from the name being renamed could not survive the rename —
 * the defect that orphaned Anna/Valencia); any other session keeps its legacy
 * name key. Both shapes share one prefix, so wildcard scans are unchanged.
 */
async function sessionStateRowKey(tmuxSession: string): Promise<string> {
	const projectId = await projectIdForTmuxSession(tmuxSession);
	return `session-state-${projectId ?? tmuxSession}`;
}

