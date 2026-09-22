/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Closed request schemas for the independent operator and fleet spawn routes.
 * No request field can switch one authority surface into the other.
 */

import * as v from "valibot";

const NonEmptyString = v.pipe(v.string(), v.minLength(1));

const CommonSpawnShape = {
	slug: v.optional(NonEmptyString),
	session: v.optional(NonEmptyString),
	focus: v.optional(v.boolean()),
	windowName: v.optional(NonEmptyString),
	cwd: v.optional(NonEmptyString),
	idempotencyKey: v.optional(NonEmptyString),
};

/** Operator selection and restore. Fleet assignment fields cannot be parsed. */
export const OperatorSpawnRequestSchema = v.strictObject({
	...CommonSpawnShape,
	resumeId: v.optional(NonEmptyString),
});

/** A new fleet lane. Freshness is a discriminant, never a boolean toggle. */
const FreshFleetSpawnRequestSchema = v.strictObject({
	...CommonSpawnShape,
	mode: v.literal("fresh"),
	initialPrompt: v.optional(v.string()),
	workItemId: v.optional(NonEmptyString),
	sessionID: v.optional(NonEmptyString),
	fleetClaude: v.optional(v.boolean()),
	ingestBaseUrl: v.optional(NonEmptyString),
});

/** A fleet-requested resume. It cannot carry fresh-lane session seeding. */
const ResumeFleetSpawnRequestSchema = v.strictObject({
	...CommonSpawnShape,
	mode: v.literal("resume"),
	resumeId: NonEmptyString,
	initialPrompt: v.optional(v.string()),
	workItemId: v.optional(NonEmptyString),
	fleetClaude: v.optional(v.boolean()),
	ingestBaseUrl: v.optional(NonEmptyString),
});

export const FleetSpawnRequestSchema = v.variant("mode", [
	FreshFleetSpawnRequestSchema,
	ResumeFleetSpawnRequestSchema,
]);

export type OperatorSpawnRequest = v.InferOutput<typeof OperatorSpawnRequestSchema>;
export type FleetSpawnRequest = v.InferOutput<typeof FleetSpawnRequestSchema>;

export type ParsedSpawnRequest =
	| { kind: "operator"; body: OperatorSpawnRequest }
	| { kind: "fleet"; body: FleetSpawnRequest };

export type SpawnRequestParseResult =
	| { ok: true; request: ParsedSpawnRequest }
	| { ok: false; error: string };

/** Parse at the route wall and preserve the route/body discriminant together. */
export function parseSpawnRequest(
	kind: "operator" | "fleet",
	input: unknown,
): SpawnRequestParseResult {
	if (kind === "operator") {
		const parsed = v.safeParse(OperatorSpawnRequestSchema, input);
		if (parsed.success) return { ok: true, request: { kind, body: parsed.output } };
		return { ok: false, error: parsed.issues[0]?.message ?? "invalid operator spawn request" };
	}
	const parsed = v.safeParse(FleetSpawnRequestSchema, input);
	if (parsed.success) return { ok: true, request: { kind, body: parsed.output } };
	return { ok: false, error: parsed.issues[0]?.message ?? "invalid fleet spawn request" };
}
