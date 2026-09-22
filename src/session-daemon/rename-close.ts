/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: renameWindowForPane, closeWindowForPane (incl. results).
 */

export interface RenameResult {
	ok: boolean;
	windowId?: string;
	sessionName?: string;
	oldName?: string;
	newName?: string;
	error?: string;
}

/**
 * The single safe rename surface (`single-spawn-surface-is-the-daemon`): resolve
 * the window from the CALLER'S OWN pane id ($TMUX_PANE) — never the server's
 * active window — rename it BY ID, pin the label (automatic-rename off), and
 * persist the new label onto the same tab. Refuses a name that collides with
 * another live window in the session (restore can't target duplicate names).
 */
export async function renameWindowForPane(
	paneId: string,
	label: string,
): Promise<RenameResult> {
	const trimmed = label.trim();
	if (!trimmed) return { ok: false, error: "label is required" };
	const info = resolvePaneWindow(paneId);
	if (!info?.windowId) return { ok: false, error: `pane ${paneId} not found` };
	const { sessionName, windowId, windowName: oldName } = info;
	if (oldName === trimmed) {
		return { ok: true, windowId, sessionName, oldName, newName: trimmed };
	}
	const collision = listWindows(sessionName).some(
		(w) => w.id !== windowId && w.name === trimmed,
	);
	if (collision) {
		return {
			ok: false,
			error: `a window named "${trimmed}" already exists in session ${sessionName}`,
		};
	}
	try {
		renameWindow(windowId, trimmed);
	} catch {
		return { ok: false, error: "tmux rename-window failed" };
	}
	setAutomaticRename(windowId, false);
	await setTabLabel(sessionName, windowId, trimmed);
	return { ok: true, windowId, sessionName, oldName, newName: trimmed };
}

export interface CloseWindowResult {
	ok: boolean;
	/** Live tmux window id (`@N`) that was targeted — present when the pane resolved. */
	windowId?: string;
	/** The session-state row's captured Claude/AI-CLI sessionId for the tab, so the
	 *  caller can stop the transcript tail keyed under it. Undefined when the tab
	 *  predates sessionId capture (a capture-only row written before seeding). */
	sessionId?: string;
	sessionName?: string;
	error?: string;
}

/**
 * The single safe close-window surface for a fleet lane (`single-spawn-surface-
 * is-the-daemon`): resolve the window from the lane's PANE id and KILL BY ID —
 * names repeat, indices renumber; either other key can kill the WRONG lane
 * (2026-06-18 wrong-tab-rename class). Tmux-runtime half of
 * `closed-run-leaves-no-session` via `/rpc/close-by-pane`. ALSO terminates the
 * lane's systemd scope — the CLI is a child of the USER MANAGER
 * (`systemd-run --user --scope`), not of the pane, so killing the window alone
 * CANNOT stop it. `ok:false` on unknown/failed — the route records a leak event.
 */
export async function closeWindowForPane(
	paneId: string,
): Promise<CloseWindowResult> {
	// Normalise at this boundary: the picker speaks raw tmux ("%10"), the fleet +
	// channel speak the prefixed identity ("tmux:%10"). resolvePaneWindow targets
	// tmux with the pane id and needs the raw form; a prefixed id is not a valid
	// tmux target. Match the full `tmux:%<N>` identity form and strip the prefix
	// to the raw `%<N>` tmux expects; anything else is passed through unchanged.
	const identity = /^tmux:(%\d+)$/.exec(paneId);
	const rawPane = identity ? identity[1] : paneId;
	const info = resolvePaneWindow(rawPane);
	if (!info?.windowId) {
		return { ok: false, error: `pane ${paneId} not found` };
	}
	const { sessionName, windowId } = info;
	// Surface the tab's captured sessionId so the caller stops the right tail.
	let sessionId: string | undefined;
	try {
		const tabs = normaliseTabs((await loadSessionState(sessionName)).tabs);
		const tab =
			tabs.find((t) => t.windowId === windowId) ??
			tabs.find((t) => t.windowName === info.windowName);
		sessionId = tab?.sessionId ?? undefined;
	} catch {
		// A failed state read must not block the kill — the window can still die,
		// the tail just won't be stopped by-id here (it reaps on daemon restart).
	}

	// Kill the systemd scope wrapping the lane's process BEFORE killing the tmux
	// window. The scope is resolved from the pane's PID: every lane launches via
	// `systemd-run --user --scope`, so the CLI is a child of the USER MANAGER and
	// survives the window being killed. Killing the scope sends SIGTERM to the
	// cgroup, which terminates the CLI and all its children.
	const pid = panePid(rawPane);
	if (pid) {
		const scopeGone = await killScopeForPid(pid);
		if (!scopeGone) {
			// Report the unit that was ACTUALLY resolved, never a reconstructed
			// guess. This message previously interpolated `run-p${pid}.scope` — a
			// name the kill path does not use and which, for a pane in any other
			// scope, does not exist. It sent two separate investigations after a
			// "stubborn process" that was never signalled, because the message
			// described a unit nobody had touched.
			const unit = (await scopeUnitForPid(pid)) ?? "no scope resolved from /proc";
			return {
				ok: false,
				windowId,
				sessionName,
				sessionId,
				error: `scope ${unit} (pid ${pid}) refused SIGTERM and SIGKILL — process still alive`,
			};
		}
	}

	// The scope kill terminates the lane's process group, which takes the tmux
	// window down WITH it — so by here the window is OFTEN already gone, and a
	// `kill-window` would find nothing left to kill. Treating that as failure
	// reports a state we never verified: the close SUCCEEDED
	// (`a-component-may-not-report-a-state-it-has-not-verified`, honour-or-refuse
	// success). `killWindow`'s boolean is only "killed THIS call" — it is not the
	// end state — so verify the window's ACTUAL state and return THAT. Both
	// directions are the same defect: a close that left the window live must not
	// report ok:true either.
	if (!windowExists(windowId)) {
		// Already gone — the scope kill took the window (or it was closed
		// out-of-band). The END STATE is verified; the close succeeded.
		return { ok: true, windowId, sessionName, sessionId };
	}

	// Still present (the scope did not take it — e.g. remain-on-exit kept a dead
	// pane, or the process detached from the window). Kill it explicitly BY ID,
	// then verify again rather than trusting the boolean.
	killWindow(windowId);
	if (!windowExists(windowId)) {
		return { ok: true, windowId, sessionName, sessionId };
	}

	// The scope terminated but the window survived an explicit kill — a genuine
	// half-failure. Report the verified end state honestly instead of ok:true;
	// the window-unlinked hook will not fire for a window that never closed, so
	// the tab record is left for the operator to inspect.
	return {
		ok: false,
		windowId,
		sessionName,
		sessionId,
		error: `scope terminated pid ${pid ?? "?"} but window ${windowId} is still live in session ${sessionName} after kill-window`,
	};
}

