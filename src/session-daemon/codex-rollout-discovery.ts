/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Select the Codex rollout created for one preallocated lane. Older rollout
 * files belong to other lanes and must never be claimed as this lane's native
 * identity.
 */

export interface RolloutCandidate {
	name: string;
	modifiedAtMs: number;
}

const FULL_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function selectCodexRollout(
	candidates: RolloutCandidate[],
	laneCreatedAtMs: number,
): { name: string; nativeSessionId: string } | null {
	const eligible = candidates
		.filter(({ name, modifiedAtMs }) =>
			name.startsWith("rollout-")
			&& name.endsWith(".jsonl")
			&& modifiedAtMs >= laneCreatedAtMs,
		)
		.map((candidate) => ({ ...candidate, match: candidate.name.match(FULL_UUID) }))
		.filter((candidate): candidate is RolloutCandidate & { match: RegExpMatchArray } =>
			candidate.match !== null,
		)
		.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
	const selected = eligible[0];
	return selected
		? { name: selected.name, nativeSessionId: selected.match[1]! }
		: null;
}
