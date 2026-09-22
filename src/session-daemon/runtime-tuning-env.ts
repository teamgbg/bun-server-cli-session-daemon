/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Apply the host-wide Bun/JSC runtime tuning to every spawned CLI lane, from
 * the SAME registry row that already tunes every PM2 service.
 *
 * WHY THIS EXISTS. `config/bun-runtime-tuning` was introduced so a JSC knob is
 * stated once for the host rather than copied per service — the ecosystem
 * transform reads it and injects it into every PM2 app. But an agent lane is a
 * Bun process too, and nothing applied it there, so the fix stopped at the
 * service boundary and nobody could see that it had.
 *
 * The cost was the largest single idle-power item on the host. Measured
 * 2026-07-28 with `scala-tools wakeups`: five pi lanes were drawing 1,165-2,136
 * wakeups/sec EACH — about 7,700 of the platform's 10,472 total, 73% — entirely
 * in JSC HeapHelper threads. PM2 services carried `JSC_numberOfGCMarkers=1` and
 * ran ZERO HeapHelper threads; the lanes carried no JSC env and ran FIVE apiece.
 * Confirmed in isolation on a throwaway allocating process: 5 helpers and 2,108
 * wakeups/sec by default, 0 helpers and 157 wakeups/sec with the marker count
 * pinned — a 13.4x reduction from one environment variable.
 *
 * That is invisible in behaviour, which is precisely why it survived: a lane
 * with seven GC threads works perfectly and simply costs power
 * (`idle-costs-nothing`). It only became findable once there was a tool that
 * attributes wakeups per thread.
 *
 * The row stays the single source. This module does NOT restate any value —
 * adding a knob is a `registry_edit` on `bun-runtime-tuning`, and both the
 * services and the lanes pick it up with no code change, which is the whole
 * point of having the row (`prevention-over-detection`: a fact maintained in
 * two places is a fact that will disagree).
 */

import { loadRegistryConfig } from "@teamscala/db/registry/load-config";
import * as v from "valibot";

/**
 * The row's shape. `env` is a flat string map so it can be rendered into any
 * launcher — a PM2 `env` block or, here, a shell prefix.
 */
const RuntimeTuningSchema = v.object({
	env: v.optional(v.record(v.string(), v.string()), {}),
	rationale: v.optional(v.record(v.string(), v.string())),
});

/**
 * Single-quote a value for POSIX sh.
 *
 * The spawned command is a shell string, so an unescaped value could end the
 * quoting and run arbitrary commands in the lane. These values come from the
 * registry rather than a user, but a launcher that is only safe because of who
 * writes its input is one registry edit away from not being safe — and the
 * escape is one line.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Render an env map as a shell `export` prefix, or "" when there is nothing to
 * apply.
 *
 * Exported for the co-located test: the empty case matters as much as the
 * populated one, because returning a bare `export ;` would break every spawn on
 * a host whose row is absent.
 */
export function renderEnvPrefix(env: Record<string, string>): string {
	const entries = Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
	if (entries.length === 0) return "";
	return `${entries.map(([k, val]) => `export ${k}=${shellQuote(val)};`).join(" ")} `;
}

/**
 * Load the host-wide tuning as a shell prefix for a lane's command.
 *
 * Fails SOFT, deliberately. A missing or malformed row must never stop a lane
 * from spawning: the tuning is a power optimisation, and trading the operator's
 * ability to open a terminal for it would be a catastrophic exchange
 * (`infrastructure-outranks-application-durability`). An unavailable row costs
 * exactly what the situation cost before this module existed.
 */
export async function runtimeTuningPrefix(): Promise<string> {
	try {
		const cfg = await loadRegistryConfig(
			"config",
			"bun-runtime-tuning",
			RuntimeTuningSchema,
		);
		return renderEnvPrefix(cfg?.env ?? {});
	} catch {
		return "";
	}
}
