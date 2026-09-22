/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * The picker's OWN version — the installed @teamscala/cli-session it runs from.
 * Read fresh so the picker footer can show it next to the daemon's reported
 * version; a mismatch means the daemon is running stale code (restart it).
 */
import { join } from "node:path";

// Read ONCE at module load (picker boot), never per-paint: the footer calls
// this on every redraw, and the version cannot change mid-process. TLA keeps
// the sync call out of the paint path entirely.
const CLIENT_VERSION: string = await Bun.file(join(import.meta.dir, "../../package.json"))
	.json()
	.then((pkg: { version?: string }) => pkg.version ?? "unknown")
	.catch(() => "unknown");

export function getClientVersion(): string {
	return CLIENT_VERSION;
}
