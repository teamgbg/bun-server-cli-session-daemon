/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Daemon-driven `+` menu. The daemon presents the spawn menu itself via
 * `tmux display-menu` — there is no CLI launcher. A tmux `+` button (or any
 * trigger) curls POST /rpc/menu with the calling session + client; the daemon
 * reads the active session_picker_option rows and runs `tmux display-menu -c
 * <client>`, where each item curls POST /rpc/spawn back into the daemon.
 *
 * Menu items target /rpc/spawn via QUERY PARAMS, not a JSON body, specifically
 * to avoid nesting JSON double-quotes inside tmux's command-string parser:
 * `run-shell "curl -s -X POST 'http://…/rpc/spawn?slug=…&session=…'"` quotes
 * cleanly (double for run-shell, single for the URL, no inner doubles).
 */

/**
 * A menu item's spawn curl, carrying the OPERATOR as the caller identity.
 *
 * `/rpc/spawn` requires a caller identity and returns 400 without one, so that
 * an unattributed spawn fails loudly instead of being recorded as a sentinel
 * that looks populated (the `rpc-spawn:caller-unidentified` value that used to
 * flow into the spawn attribution record). That requirement landed on
 * 2026-07-29 and immediately broke this menu, which posts query params and no
 * headers — every `+` menu spawn 400'd, which is the operator's PRIMARY way of
 * opening a CLI.
 *
 * The fix is an identity, not an exemption. A spawn from the tmux menu genuinely
 * IS the operator acting directly — that is a real, meaningful attribution and
 * exactly what the sentinel was not. Restoring a fallback default in the route
 * would reinstate the unattributable value the change existed to remove.
 *
 * Single-quoted inside the double-quoted `run-shell` wrapper, matching how the
 * URL is already quoted, so tmux's own parsing is unaffected.
 */

import { displayMenu } from "@teamscala/tmux-session/interact";
import { queryActiveOptions } from "./query-options.ts";
import type { SessionPickerOptionConfig } from "@teamscala/db-validation/registry-schemas/session-picker-option";
import { getSessionPickerUrl } from "@teamscala/cli-session/session-picker-url";
import { OPERATOR_TOKEN_HEADER } from "@teamscala/session-contracts/operator-spawn-token";

function daemonBase(): string {
	return getSessionPickerUrl();
}

export interface ShowMenuResult {
	ok: boolean;
	error?: string;
	itemCount?: number;
}

function spawnCurl(url: string, operatorToken: string): string {
	return `run-shell "curl -s -m5 -X POST -H 'x-requested-by: operator:tmux-menu' -H '${OPERATOR_TOKEN_HEADER}: ${operatorToken}' '${url}' >/dev/null 2>&1 || true"`;
}

export async function showSpawnMenu(
	session: string,
	client: string,
	submenuId?: string,
	operatorToken?: string | null,
): Promise<ShowMenuResult> {
	if (!operatorToken) {
		return {
			ok: false,
			error:
				"operator spawn token is unavailable; refusing to show a menu whose selections would be misclassified as fleet. Restart session-picker to mint a fresh token.",
		};
	}
	const options = await queryActiveOptions();
	if (options.length === 0) {
		return { ok: false, error: "no active session_picker_option rows" };
	}

	const base = daemonBase();
	const activeSubmenu = submenuId || null;
	const filtered = options.filter((opt) => {
		const cfg = opt.config as SessionPickerOptionConfig;
		const parent = cfg.parent_menu ?? null;
		return parent === activeSubmenu;
	});

	if (filtered.length === 0) {
		return { ok: false, error: `no active options for submenu: ${submenuId}` };
	}

	const title = activeSubmenu
		? `#[align=centre]${activeSubmenu === "opencode-models" ? "OpenCode Models" : activeSubmenu}`
		: "#[align=centre]Spawn Tab";

	const args: string[] = [
		"display-menu",
		"-c",
		client,
		"-T",
		title,
		"-x",
		"R",
		"-y",
		"S",
	];

	if (!activeSubmenu) {
		// Root menu: Group options by category (AI Coding, System)
		const categories = Array.from(
			new Set(filtered.map((opt) => (opt.config as SessionPickerOptionConfig).category)),
		);
		categories.sort((a, b) => {
			if (a === "AI Coding") return -1;
			if (b === "AI Coding") return 1;
			return a.localeCompare(b);
		});

		categories.forEach((cat, catIdx) => {
			if (catIdx > 0) {
				args.push("", "", ""); // Separator between categories
			}
			args.push(`#[align=centre,bold,fg=brightyellow]— ${cat} —`, "", "");

			const catOptions = filtered.filter(
				(opt) => (opt.config as SessionPickerOptionConfig).category === cat,
			);
			catOptions.forEach((opt) => {
				const cfg = opt.config as SessionPickerOptionConfig;
				const key = cfg.key;
				if (cfg.action_type === "submenu") {
					const url =
						`${base}/rpc/menu` +
						`?session=${encodeURIComponent(session)}` +
						`&client=${encodeURIComponent(client)}` +
						`&submenu=${encodeURIComponent(cfg.submenu_id ?? "")}`;
					const command = `run-shell "curl -s -m5 -X POST '${url}' >/dev/null 2>&1 || true"`;
					args.push(`${opt.label} ›`, key, command);
				} else {
					const url =
						`${base}/rpc/spawn` +
						`?slug=${encodeURIComponent(opt.slug)}` +
						`&session=${encodeURIComponent(session)}` +
						`&focus=true`;
					const command = spawnCurl(url, operatorToken);
					args.push(opt.label, key, command);
				}
			});
		});
	} else {
		// Submenu menu: Render header, options, separator, and Back button
		args.push(`#[align=centre,bold,fg=brightyellow]— ${activeSubmenu === "opencode-models" ? "OpenCode Models" : activeSubmenu} —`, "", "");

		filtered.forEach((opt) => {
			const cfg = opt.config as SessionPickerOptionConfig;
			const key = cfg.key;
			const url =
				`${base}/rpc/spawn` +
				`?slug=${encodeURIComponent(opt.slug)}` +
				`&session=${encodeURIComponent(session)}` +
				`&focus=true`;
			const command = spawnCurl(url, operatorToken);
			args.push(opt.label, key, command);
		});

		args.push("", "", ""); // Separator before Back button
		const backUrl =
			`${base}/rpc/menu` +
			`?session=${encodeURIComponent(session)}` +
			`&client=${encodeURIComponent(client)}`;
		const backCommand = `run-shell "curl -s -m5 -X POST '${backUrl}' >/dev/null 2>&1 || true"`;
		args.push("‹ Back", "b", backCommand);
	}

	const r = displayMenu(args);
	if (r.exitCode !== 0) {
		return { ok: false, error: (r.stderr ?? "").toString().trim() || "tmux display-menu failed" };
	}
	return { ok: true, itemCount: filtered.length };
}
