/**
 * @system cli-session-daemon
 * @status handwritten
 * @edit edit directly
 *
 * Picker display helpers: relative age, attached-client summary, sizing warning, and the cool-name pool with reserved-name sets.
 */

import { formatClientsCompact } from "../session-daemon/picker-data.ts";
import type { ArchivedSession, AttachedClient, SizingInfo } from "./types.ts";
import type { SessionInfo } from "./row-build.ts";

export function relativeAgo(d: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Compact one-line device summary for an attached session — delegates to the
 * canonical daemon formatter so every surface shows devices identically. */
export function formatClients(clients: AttachedClient[]): string {
	return formatClientsCompact(clients);
}

/** Footer warning for a stale size-clamping client — the operator's active
 * device is protected (window-size=latest), but a stale tiny client is still
 * attached and worth detaching so it stops competing for the active slot. */
export function formatSizingWarning(sizing: SizingInfo): string {
	const clamps = sizing.clampingClients
		.map((c) => `${c.tty.replace(/^\/dev\//, "") || c.name} ${c.width}x${c.height}`)
		.join(", ");
	const singular = sizing.clampingClients.length === 1;
	return `⚠ stale tiny ${singular ? "client" : "clients"} clamping (${clamps}) — detach to free sizing`;
}

// Short, cool, one-word session names.
const COOL_NAMES = [
	"apex",
	"atlas",
	"blaze",
	"cipher",
	"comet",
	"drift",
	"ember",
	"echo",
	"flux",
	"forge",
	"ghost",
	"glyph",
	"halo",
	"haze",
	"helix",
	"hydra",
	"jade",
	"kilo",
	"koi",
	"lark",
	"lynx",
	"mist",
	"moss",
	"nebula",
	"neon",
	"nomad",
	"nova",
	"onyx",
	"orbit",
	"oslo",
	"phoenix",
	"prism",
	"pulse",
	"quasar",
	"quill",
	"raven",
	"rift",
	"rune",
	"sable",
	"shade",
	"spark",
	"tide",
	"titan",
	"torch",
	"vapor",
	"vertex",
	"void",
	"volt",
	"wave",
	"wisp",
	"xenon",
	"yarn",
	"zenith",
	"zephyr",
];

export function pickCoolName(existing: Set<string>): string {
	const shuffled = [...COOL_NAMES].sort(() => Math.random() - 0.5);
	for (const n of shuffled) {
		if (!existing.has(n)) return n;
	}
	const base = COOL_NAMES[Math.floor(Math.random() * COOL_NAMES.length)] ?? "nova";
	let n = 2;
	while (existing.has(`${base}-${n}`)) n += 1;
	return `${base}-${n}`;
}

interface RawArchived extends ArchivedSession {}

export function reservedNames(
	live: SessionInfo[],
	archived: RawArchived[],
	hidden: RawArchived[],
): Set<string> {
	const taken = new Set<string>();
	for (const s of live) taken.add(s.name);
	for (const a of archived) taken.add(a.name);
	for (const h of hidden) taken.add(h.name);
	return taken;
}
