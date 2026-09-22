/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Boots the database-backed ORPC surface for one visible fleet client.
 */

import {
	createDbClient,
	type DbClient,
} from "@teamscala/db/create-db-client";
import { registerPrismaClient } from "@teamscala/db/prisma-registry";
import { getEntriesByType } from "@teamscala/db/registry/getEntriesByType";
import { loadRegistryEntries } from "@teamscala/db/registry/loader/load-entries";
import { loadRegistryConfig } from "@teamscala/db/registry/load-config";
import type { RegistryType } from "@teamscala/db/registry/types";
import {
	configure as orpcConfigure,
	type InjectedPrisma,
} from "@teamscala/orpc/configure";
import * as v from "valibot";

export type StandaloneOrpcDeps = {
	createDbClient: typeof createDbClient;
	registerPrismaClient: typeof registerPrismaClient;
	loadRegistryEntries: typeof loadRegistryEntries;
	configureOrpc: typeof orpcConfigure;
};

const defaultDeps: StandaloneOrpcDeps = {
	createDbClient,
	registerPrismaClient,
	loadRegistryEntries,
	configureOrpc: orpcConfigure,
};

export async function configureStandaloneOrpc(
	connectionString: string,
	deps: StandaloneOrpcDeps = defaultDeps,
	onDatabaseReady?: (db: DbClient) => void,
): Promise<DbClient> {
	const db = await deps.createDbClient({
		connectionString,
		serviceName: "session-picker-cli-sessions",
	});
	deps.registerPrismaClient(db.prisma as never);
	onDatabaseReady?.(db);
	await deps.loadRegistryEntries(db.prisma);
	deps.configureOrpc({
		getPrisma: () => db.prisma as unknown as InjectedPrisma,
		loadRegistryConfig: (type, slug) => loadRegistryConfig(type, slug, v.unknown()),
		getEntriesByType: async (type) => getEntriesByType(type as RegistryType),
	});
	return db;
}
