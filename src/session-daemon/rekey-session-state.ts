/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Boot rekey: fold legacy `session-state-<tmux-name>` rows into the immutable
 * project-id keying. The slug layer resolves project-owned sessions through
 * developer-seat-map.ts from the moment this module's consumer loads; rows
 * WRITTEN under the old scheme stay stranded until this pass moves them, so it
 * runs at daemon boot (idempotent, convergent — a seat that is down retries on
 * the next boot) beside scrubStoredCommandSecrets.
 *
 * REGISTRY-WRITE SHAPE. Bulk UPDATE against registry_entries is refused by the
 * migration DDL guard (registry-write-contract-is-the-schema), so every move
 * here goes one-row-at-a-time through the audited Prisma client — create-new,
 * READ THE NEW ROW BACK, delete-legacy, read its ABSENCE back — never trusting
 * a write that merely returned.
 */

import { getPrisma } from "@teamscala/db/prisma-registry";
import {
	SessionStateConfigSchema,
} from "@teamscala/db-validation/registry-schemas/session-state";
import * as v from "valibot";
import { isProjectKeyedSuffix, loadDeveloperSeatMap } from "./developer-seat-map.ts";

export interface RekeyPlanEntry {
	legacySlug: string;
	legacySuffix: string;
	newSlug: string;
	projectTitle: string;
}

/** Pure: pair every legacy name-keyed row with the live seat owning its exact
 * current tmux name. An unmatched row stays untouched — guessing an owner from
 * a similar-looking title is shape inference, the failure this keying exists to
 * retire; such a row waits for a boot where its seat IS live. */
export function planRekey(
	rows: Array<{ slug: string; config: unknown }>,
	seats: Array<{ projectId: string; title: string; liveSession: string | null }>,
): RekeyPlanEntry[] {
	const plan: RekeyPlanEntry[] = [];
	for (const row of rows) {
		if (!row.slug.startsWith("session-state-")) continue;
		const suffix = row.slug.slice("session-state-".length);
		if (isProjectKeyedSuffix(suffix)) continue;
		const seat = seats.find((e) => e.liveSession === suffix);
		if (!seat) continue;
		plan.push({
			legacySlug: row.slug,
			legacySuffix: suffix,
			newSlug: `session-state-${seat.projectId}`,
			projectTitle: seat.title,
		});
	}
	return plan;
}

export async function rekeySessionStateRows(): Promise<{ rekeyed: number }> {
	const [rows, seats] = await Promise.all([
		getPrisma().registry_entries.findMany({
			where: { type: "config", slug: { startsWith: "session-state-" } },
			select: { slug: true, config: true },
		}),
		loadDeveloperSeatMap(),
	]);
	const plan = planRekey(rows as Array<{ slug: string; config: unknown }>, seats);
	if (plan.length === 0) return { rekeyed: 0 };

	let rekeyed = 0;
	for (const step of plan) {
		const parsed = v.safeParse(
			SessionStateConfigSchema,
			(rows.find((r) => r.slug === step.legacySlug) as { config: unknown }).config,
		);
		if (!parsed.success) continue;
		const state = parsed.output;
		await getPrisma().registry_entries.upsert({
			where: { type_slug: { type: "config", slug: step.newSlug } },
			create: {
				type: "config",
				slug: step.newSlug,
				label: `Session state for ${step.projectTitle}`,
				config: state as never,
				is_active: true,
			},
			update: {},
		});
		const readback = await getPrisma().registry_entries.findFirst({
			where: { type: "config", slug: step.newSlug },
			select: { id: true },
		});
		if (!readback) continue;
		await getPrisma().registry_entries.deleteMany({
			where: { type: "config", slug: step.legacySlug },
		});
		const gone = await getPrisma().registry_entries.findFirst({
			where: { type: "config", slug: step.legacySlug },
			select: { id: true },
		});
		if (gone) continue;
		rekeyed += 1;
	}
	return { rekeyed };
}
