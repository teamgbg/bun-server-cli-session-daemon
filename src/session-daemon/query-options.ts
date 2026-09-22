/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Extracted from state-file.ts as a single-purpose sibling: queryPickerConfigOverride, queryActiveOptions.
 */

export interface MenuOption {
	slug: string;
	label: string;
	sortOrder: number;
	family: CliFamily | null;
	config: SessionPickerOptionConfig;
}

// The picker's chrome (title + labels + layout) is db-driven: this returns the
// raw `config:session-picker-config` row JSONB (or null) — the VIEW merges it
// over its baked defaults, so changing the row re-renders the picker with no
// code change. Loose by design: unknown/missing keys fall back to defaults.
export async function queryPickerConfigOverride(): Promise<Record<string, unknown> | null> {
	const row = await getPrisma().registry_entries.findFirst({
		where: { type: "config", slug: "session-picker-config", is_active: true },
		select: { config: true },
	});
	const cfg = row?.config;
	return cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : null;
}

function titleCaseCliSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

export async function queryActiveOptions(): Promise<MenuOption[]> {
	// The CLI family resolves through the `cli_id` FOREIGN KEY, not a config
	// string — the same join the Rust readers (picker TUI, launch option) use,
	// so both languages derive one family from one key. The Prisma model does
	// not yet carry the column, so the join is read raw here.
	const rows = await getPrisma().$queryRaw<{
		slug: string;
		label: string | null;
		sort_order: number | null;
		config: unknown;
		cli_slug: string | null;
		cli_display: string | null;
	}[]>`
		SELECT o.slug, o.label, o.sort_order, o.config,
			       c.slug AS cli_slug,
			       c.config ->> 'display_name' AS cli_display
		  FROM registry_entries o
		  LEFT JOIN registry_entries c
		    ON c.id = o.cli_id
		 WHERE o.type = 'session_picker_option' AND o.is_active = true`;
	if (rows.length === 0) {
		throw new Error(
			"no session_picker_option rows in registry_entries — seed via scala-dev-mcp registry_edit",
		);
	}
	const options: MenuOption[] = rows.map((row) => {
		const config = v.parse(SessionPickerOptionConfigSchema, row.config);
		return {
			slug: row.slug,
			label: row.label ?? row.slug,
			sortOrder: row.sort_order ?? 0,
			family: row.cli_slug
				? {
						key: config.menu_scope ?? row.cli_slug,
						name: row.cli_display ?? titleCaseCliSlug(row.cli_slug),
					}
				: null,
			config,
		};
	});
	options.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));

	return options;
}

function unwrapLoginShell(startCommand: string): string {
	const stripQuotes = (s: string): string => {
		if (s.length >= 2) {
			const first = s[0];
			const last = s[s.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				return s.slice(1, -1);
			}
		}
		return s;
	};
	let s = stripQuotes(startCommand.trim());
	const prefixes = ["bash -lc ", "/bin/bash -lc "];
	for (const p of prefixes) {
		if (s.startsWith(p)) {
			s = stripQuotes(s.slice(p.length).trim());
			break;
		}
	}
	return s;
}

function extractSessionIdFromCommand(innerCommand: string): string | null {
	const re =
		/(?:--session-id|--session|--resume|resume)\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/;
	const m = re.exec(innerCommand);
	return m?.[1] ?? null;
}

function inferOptionSlugFromCommand(innerCommand: string, options: MenuOption[]): string | null {
	let best: { slug: string; len: number } | null = null;
	for (const opt of options) {
		if (opt.config.action_type !== "tmux_window") continue;
		const optCmd = opt.config.command;
		if (!optCmd) continue;
		if (innerCommand.startsWith(optCmd) && (!best || optCmd.length > best.len)) {
			best = { slug: opt.slug, len: optCmd.length };
		}
	}
	return best?.slug ?? null;
}

function nextAvailableWindowName(baseName: string, used: Set<string>): string {
	for (let i = 2; i < 1000; i += 1) {
		const candidate = `${baseName}-${i}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${baseName}-${Date.now()}`;
}

function normaliseLiveWindows(_tmuxSession: string, windows: TmuxWindow[]): TmuxWindow[] {
	const used = new Set<string>();
	return windows.map((window) => {
		if (!used.has(window.name)) {
			used.add(window.name);
			return window;
		}
		const nextName = nextAvailableWindowName(window.name, used);
		const renamed = window.id ? renameWindow(window.id, nextName) : false;
		const name = renamed ? nextName : window.name;
		used.add(name);
		return { ...window, name };
	});
}

