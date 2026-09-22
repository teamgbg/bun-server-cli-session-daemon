/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Daemon-rendered session pick-screen — the daemon-only equivalent of the old
 * in-terminal pick TUI, per `session-picker-is-one-surface`. The daemon paints
 * it by driving `tmux display-menu` (same mechanism as the `+` spawn menu in
 * `show-menu.ts`), so there is NO in-terminal session-picker binary.
 *
 * Flow (per apps/session-picker.md "How interaction works WITHOUT a CLI"):
 *   login → bashrc enters tmux (so a client is attached) → bashrc curls
 *   POST /rpc/pick → this presents `tmux display-menu -c <client>` listing live
 *   sessions; each item `attach-session`s to it, plus a "new session" action.
 *
 * Why attach-session (not switch-client): `switch-client` re-points a client
 * already inside tmux, but only works for that single client. `attach-session`
 * attaches the calling client to the target session — this works for BOTH
 * already-attached clients (switching between sessions) AND fresh devices
 * connecting for the first time (e.g. tablet SSH), enabling session sharing.
 *
 * Why a client is required: a headless daemon cannot paint a bare pre-tmux
 * terminal, but bashrc enters tmux first, so by the time /rpc/pick fires there
 * is an attached client and `display-menu -c` works.
 */

import { run } from "@teamscala/tmux-session/command-runner";
import { displayMenu } from "@teamscala/tmux-session/interact";
import { formatClientsCompact, parseClients, type AttachedClient } from "./picker-data.ts";

interface LiveSession {
	name: string;
	attached: boolean;
	/** Compact device summary for the menu label (e.g. "pts/0 105x87"). */
	devices: string;
}

/** Attached clients grouped by session — the devices viewing each live session. */
function listAttachedClients(): Map<string, AttachedClient[]> {
	const r = run([
		"list-clients",
		"-F",
		"#{client_session}|#{client_name}|#{client_tty}|#{client_width}|#{client_height}|#{client_activity}",
	]);
	if (r.exitCode !== 0) return new Map();
	return parseClients(r.stdout.toString());
}

/**
 * Live tmux sessions ordered NEWEST-CREATED FIRST. tmux's own `list-sessions`
 * returns rows alphabetically, which scatters sessions by name; sorting by
 * `#{session_created}` (creation epoch) descending lists them in the order they
 * were created with the most recent at the top — what the operator expects when
 * logging in from a phone/tablet. Each attached session carries its device
 * summary so the `+` menu shows WHICH device is attached, not just that one is.
 */
function listLiveSessions(): LiveSession[] {
	const r = run(["list-sessions", "-F", "#{session_created}|#{session_name}|#{session_attached}"]);
	if (r.exitCode !== 0) return [];
	const clientsBySession = listAttachedClients();
	return r.stdout
		.toString()
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [created, name, attached] = line.split("|");
			const sessionName = (name ?? "").trim();
			const clients = clientsBySession.get(sessionName) ?? [];
			return {
				created: Number(created ?? 0),
				name: sessionName,
				attached: Number(attached ?? 0) > 0,
				devices: formatClientsCompact(clients),
			};
		})
		.filter((s) => s.name.length > 0)
		.sort((a, b) => b.created - a.created)
		.map(({ name, attached, devices }) => ({ name, attached, devices }));
}

export interface ShowPickerResult {
	ok: boolean;
	error?: string;
	itemCount?: number;
}

/**
 * Present the session pick-screen in the given tmux client. Returns ok:false
 * (never throws) so the route surfaces a clean error; a failed pick-screen must
 * never take down the daemon — the user still has a working tmux session.
 */
export async function showSessionPicker(client?: string): Promise<ShowPickerResult> {
	const live = listLiveSessions();

	// `-c <client>` targets a specific client; when bashrc triggers the picker
	// right after attaching it can't reliably know the client name, so it omits
	// it and tmux targets the current (most-recently-active) client — which is
	// the just-attached login client.
	const args: string[] = ["display-menu"];
	if (client) args.push("-c", client);
	args.push("-T", "#[align=centre] Sessions ", "-x", "C", "-y", "C");

	// One item per live session (most-recently-active first), attaching the
	// calling client to it. tmux assigns numeric mnemonics 1-9 then 0; sessions
	// past 10 have no key (mouse-select). The attached session is labelled so the
	// operator can see which one they are already in.
	live.forEach((s, i) => {
		const key = i < 10 ? String((i + 1) % 10) : "";
		const label = s.attached ? `${s.name} (attached${s.devices ? ` ${s.devices}` : ""})` : s.name;
		// session name single-quoted for tmux's command parser; attach-session
		// works for both already-attached clients AND fresh device connections.
		args.push(label, key, `attach-session -t '${s.name}'`);
	});

	// Separator + create-new (prompts for a name, then creates and switches to it).
	args.push("", "", "");
	args.push("+ New session", "n", `command-prompt -p "new session name:" "new-session -s '%%'"`);

	// Kill-a-session lives behind its own submenu so the destructive action is
	// never one mis-tap away on a touchscreen — and each kill still requires a
	// confirm-before prompt. The currently-attached session is excluded so the
	// operator cannot disconnect themselves from the picker. Omitted entirely
	// when there is nothing safe to kill.
	const killable = live.filter((s) => !s.attached);
	if (killable.length > 0) {
		const killMenu: string[] = ["display-menu", "-T", "#[align=centre] Kill a session ", "-x", "C", "-y", "C"];
		killable.forEach((s, i) => {
			const key = i < 10 ? String((i + 1) % 10) : "";
			killMenu.push(s.name, key, `confirm-before -p "kill '${s.name}'? (y/n)" "kill-session -t '${s.name}'"`);
		});
		// The submenu command string is embedded as one menu-item command; tmux
		// re-parses it, so its inner arguments are single-quoted.
		const killCmd = killMenu.map((a) => (a === "display-menu" ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
		args.push("✕ Kill a session…", "k", killCmd);
	}

	const r = displayMenu(args);
	if (r.exitCode !== 0) {
		return { ok: false, error: r.stderr.toString().trim() || "tmux display-menu failed" };
	}
	return { ok: true, itemCount: live.length };
}
