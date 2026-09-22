// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { join } from "node:path";

const daemonSource = await Bun.file(join(import.meta.dir, "daemon.ts")).text();

test("session-picker daemon is emission-only", () => {
	expect(daemonSource).toContain("startPickerEventBridge()");
	expect(daemonSource).not.toContain("createWatchdog");
	expect(daemonSource).not.toContain("RECONCILE_INTERVAL_MS");
	expect(daemonSource).not.toContain("reconcileAll()");
});
