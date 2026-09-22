// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	applyPermanentSessions,
	type ArchivedPickerSession,
	formatClientsCompact,
	parseClients,
} from "./picker-data.ts";

describe("parseClients", () => {
	test("groups attached clients by session and parses fields", () => {
		const raw = [
			"nebula|/dev/pts/0|/dev/pts/0|105|87|1784245468",
			"nebula|/dev/pts/3|/dev/pts/3|217|49|1784245400",
			"atlas|/dev/pts/5|/dev/pts/5|80|24|1784245000",
		].join("\n");
		const bySession = parseClients(raw);
		expect(bySession.get("nebula")).toEqual([
			{ name: "/dev/pts/0", tty: "/dev/pts/0", width: 105, height: 87, activity: 1784245468 },
			{ name: "/dev/pts/3", tty: "/dev/pts/3", width: 217, height: 49, activity: 1784245400 },
		]);
		expect(bySession.get("atlas")).toHaveLength(1);
		expect(bySession.get("atlas")![0]!.height).toBe(24);
	});

	test("drops blank lines and lines with no session", () => {
		const raw = "\n\nnebula|pts/0|/dev/pts/0|100|40|10\n|orphan|/dev/pts/9|20|5|0\n";
		const bySession = parseClients(raw);
		expect(bySession.has("")).toBe(false);
		expect(bySession.get("nebula")).toHaveLength(1);
	});

	test("empty input yields an empty map", () => {
		expect(parseClients("").size).toBe(0);
	});
});

describe("formatClientsCompact", () => {
	const c = (tty: string, w: number, h: number) =>
		({ name: tty, tty, width: w, height: h, activity: 0 });

	test("empty -> empty string", () => {
		expect(formatClientsCompact([])).toBe("");
	});

	test("single client -> tty-basename WxH", () => {
		expect(formatClientsCompact([c("/dev/pts/0", 105, 87)])).toBe("pts/0 105x87");
	});

	test("multiple clients joined, capped at max with +N", () => {
		const clients = [c("/dev/pts/0", 105, 87), c("/dev/pts/3", 217, 49), c("/dev/pts/4", 80, 24)];
		expect(formatClientsCompact(clients)).toBe("pts/0 105x87, pts/3 217x49, +1");
		expect(formatClientsCompact(clients, 3)).toBe("pts/0 105x87, pts/3 217x49, pts/4 80x24");
	});

	test("falls back to name when tty is empty", () => {
		expect(formatClientsCompact([{ name: "wezterm", tty: "", width: 100, height: 40, activity: 0 }])).toBe(
			"wezterm 100x40",
		);
	});
});

describe("applyPermanentSessions", () => {
	const NOW = new Date("2026-07-24T08:00:00.000Z");
	const arch = (name: string, tabCount = 2): ArchivedPickerSession => ({
		name,
		tabCount,
		updatedAt: "2026-07-20T00:00:00.000Z",
	});

	test("injects a permanent name with no row and no live session", () => {
		const { archived } = applyPermanentSessions([], [], new Set(), ["Valencia"], NOW);
		expect(archived).toEqual([
			{ name: "Valencia", tabCount: 0, updatedAt: NOW.toISOString(), permanent: true },
		]);
	});

	test("does NOT inject a permanent name that is currently live", () => {
		const { archived } = applyPermanentSessions([], [], new Set(["joe"]), ["joe"], NOW);
		expect(archived).toEqual([]);
	});

	test("marks an existing archived entry permanent, preserving its tab count", () => {
		const { archived } = applyPermanentSessions([arch("Anna", 3)], [], new Set(), ["Anna"], NOW);
		expect(archived).toHaveLength(1);
		expect(archived[0]).toMatchObject({ name: "Anna", tabCount: 3, permanent: true });
	});

	test("pulls a permanent name out of hidden and into the visible list", () => {
		const { archived, hidden } = applyPermanentSessions(
			[],
			[arch("Anna", 1)],
			new Set(),
			["Anna"],
			NOW,
		);
		expect(hidden).toEqual([]);
		expect(archived).toHaveLength(1);
		expect(archived[0]).toMatchObject({ name: "Anna", permanent: true, tabCount: 1 });
	});

	test("leaves non-permanent hidden and archived entries untouched", () => {
		const { archived, hidden } = applyPermanentSessions(
			[arch("other")],
			[arch("secret")],
			new Set(),
			["Valencia"],
			NOW,
		);
		expect(hidden).toEqual([arch("secret")]);
		expect(archived.find((a) => a.name === "other")!.permanent).toBeUndefined();
		expect(archived.find((a) => a.name === "Valencia")!.permanent).toBe(true);
	});

	test("no permanent names is a no-op", () => {
		const { archived, hidden } = applyPermanentSessions([arch("a")], [arch("b")], new Set(), [], NOW);
		expect(archived).toEqual([arch("a")]);
		expect(hidden).toEqual([arch("b")]);
	});
});
