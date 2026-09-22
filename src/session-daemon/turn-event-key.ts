/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Derive the stable idempotency key for one transcript turn-end event.
 * The key MUST be a function of the EVENT, never of the moment it was read:
 * the transcript is replayed from byte 0 whenever a sidecar (re)starts, so a
 * key minted per call makes every replayed turn a brand new row.
 */

/**
 * FNV-1a over the record text. Not a security hash — it exists so a record that
 * carries no id of its own still collapses onto one row when replayed. Mirrors
 * the same fallback the Rust `record_turn` writer uses for the same reason.
 */
/**
 * Resolve the event-stable key for a transcript line.
 *
 * Preference order, most durable first:
 *  1. `uuid`       — Claude stamps one per record; written once, identical on
 *                    every replay of the file.
 *  2. `message.id` — the provider's own message id (`msg_…`), equally stable.
 *  3. FNV-1a over the raw line — deterministic for records carrying neither.
 *
 * A fresh UUID is never an option here. That was the defect: the key was unique
 * by construction, so the `ON CONFLICT (session_id, idempotency_key) DO NOTHING`
 * clauses guarding both writes could never fire, and one sidecar start replayed
 * a whole transcript into N fabricated `active -> idle` transitions. Each of
 * those fired `fleet_watchdog_on_idle`, so a working lane was told it had gone
 * idle once per historical turn.
 */

function fnv1a(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < text.length; i++) {
		hash ^= BigInt(text.charCodeAt(i));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

export function turnEventKey(line: unknown, raw: string): string {
	const record = line as { uuid?: unknown; message?: { id?: unknown } } | null;

	const recordUuid = record?.uuid;
	if (typeof recordUuid === "string" && recordUuid.length > 0) {
		return `turn_end:${recordUuid}`;
	}

	const messageId = record?.message?.id;
	if (typeof messageId === "string" && messageId.length > 0) {
		return `turn_end:${messageId}`;
	}

	return `turn_end:fnv-${fnv1a(raw)}`;
}
