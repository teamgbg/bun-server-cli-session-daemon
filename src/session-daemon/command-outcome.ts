/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 * Read one durable command outcome for the picker/CLI faces. The daemon owns
 * this typed read via the Bun.SQL runner so clients never acquire their own DB
 * connection — and the file stays getPrisma-free (no-direct-prisma-outside-orpc).
 * Split out of picker-command-producer.ts: enqueue producers and the outcome
 * reader are different surfaces with different callers.
 */

import { createBunSqlRunner } from "@teamscala/db/sql/create-bun-sql-runner";

export interface PickerCommandOutcome {
	status: string;
	result: Record<string, unknown> | null;
	error: string | null;
}

export async function readCommandOutcome(
	commandId: string,
): Promise<PickerCommandOutcome | null> {
	const runner = createBunSqlRunner();
	const rows = await runner.query<PickerCommandOutcome>(
		"SELECT status, result, error FROM host_commands WHERE id = $1",
		commandId,
	);
	return rows[0] ?? null;
}
