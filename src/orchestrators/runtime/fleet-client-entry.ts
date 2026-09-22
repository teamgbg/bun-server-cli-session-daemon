/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Registry-owned launcher target for a visible platform agent client. The
 * picker supplies only durable identity and runtime metadata through the
 * environment; the brief remains in task-sync/work_items and is never passed
 * to a terminal command.
 */

import {
	recordVisibleFleetStartupFailure,
	startVisibleFleetClient,
	type VisibleFleetClientInput,
} from "./fleet-client";
import { configureStandaloneOrpc } from "./standalone-orpc";
import type { DbClient } from "@teamscala/db/create-db-client";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`visible fleet client requires ${name}`);
	return value;
}

// Launcher-only module: the picker executes this file BY PATH with the
// SCALA_FLEET_* env supplied. The derived exports map also exposes it as an
// importable subpath, so every import-time effect (env reads, DB connect,
// process exit hooks) runs only when executed as the entrypoint — importing
// the module in a clean consumer is inert.
if (import.meta.main) {
	const input: VisibleFleetClientInput = {
	cliSessionId: required("SCALA_FLEET_CLI_SESSION_ID"),
	workItemId: required("SCALA_FLEET_WORK_ITEM_ID"),
	commandId: required("SCALA_FLEET_COMMAND_ID"),
	runtimeSlug: required("SCALA_FLEET_RUNTIME_SLUG"),
	provider: required("SCALA_FLEET_PROVIDER"),
	windowName: required("SCALA_FLEET_WINDOW_NAME"),
	workdir: required("SCALA_FLEET_WORKDIR"),
	model: process.env.SCALA_FLEET_MODEL,
	organisationId: process.env.SCALA_FLEET_ORGANISATION_ID,
	pickerOptionSlug: required("SCALA_FLEET_PICKER_OPTION_SLUG"),
};

let cliDb: DbClient | undefined;
try {
		cliDb = await configureStandaloneOrpc(
			required("DATABASE_URL"),
			undefined,
			(database) => {
				cliDb = database;
			},
		);
		const activeDb = cliDb;
		const registration = await startVisibleFleetClient(input, activeDb.prisma);
		process.stdout.write(
			`${JSON.stringify({ type: "fleet_client_registered", ...registration })}\n`,
		);
		const close = async () => {
			await activeDb.disconnect();
		};
		process.once("SIGTERM", () => void close());
		process.once("SIGINT", () => void close());
	} catch (error) {
		if (cliDb) {
			await recordVisibleFleetStartupFailure(input, cliDb.prisma, error);
			await cliDb.disconnect();
		}
		process.stderr.write(
			`visible fleet client startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
