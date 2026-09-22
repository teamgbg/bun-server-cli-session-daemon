// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { detectClampingClients } from "./sizing.ts";
import type { AttachedClient } from "./picker-data.ts";

const c = (tty: string, w: number, h: number, activity: number): AttachedClient => ({
	name: tty,
	tty,
	width: w,
	height: h,
	activity,
});

describe("detectClampingClients", () => {
	test("the live bug: a stale shorter client clamps the taller active device", () => {
		// desktop 87 rows + active; stale 49-row tablet halves every window.
		const clients = [c("/dev/pts/0", 105, 87, 1000), c("/dev/pts/3", 100, 49, 500)];
		expect(detectClampingClients(clients)).toEqual([clients[1]]);
	});

	test("a single attached client never clamps", () => {
		expect(detectClampingClients([c("/dev/pts/0", 80, 12, 1000)])).toEqual([]);
		expect(detectClampingClients([])).toEqual([]);
	});

	test("same-height clients do not clamp each other", () => {
		const clients = [c("/dev/pts/0", 105, 87, 1000), c("/dev/pts/3", 217, 87, 500)];
		expect(detectClampingClients(clients)).toEqual([]);
	});

	test("the active device is never flagged, even when it is the small one", () => {
		// operator actively on the 24-row tablet; the big desktop is stale.
		const clients = [c("/dev/pts/3", 80, 24, 2000), c("/dev/pts/0", 105, 87, 500)];
		expect(detectClampingClients(clients)).toEqual([]);
	});

	test("flags every stale shorter client when one big active device is present", () => {
		const clients = [
			c("/dev/pts/0", 105, 87, 2000), // active desktop
			c("/dev/pts/3", 100, 49, 500), // stale tablet
			c("/dev/pts/4", 80, 24, 100), // stale phone
		];
		expect(detectClampingClients(clients)).toEqual([clients[1], clients[2]]);
	});
});
