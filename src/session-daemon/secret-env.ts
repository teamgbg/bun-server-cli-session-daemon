/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Resolve sealed registry credentials into the environment of one spawned CLI
 * lane. This is the launcher half of the platform's single credential path:
 * secret row -> decryptor -> consumer-native environment variable.
 */

import { loadRegistryConfig } from "@teamscala/db/registry/load-config";
import { decryptSecretConfig } from "@teamscala/encryption/crypto/secret-config";
import * as v from "valibot";
import { renderEnvPrefix } from "./runtime-tuning-env.ts";

export interface SecretEnvReference {
	name: string;
	secret_slug: string;
	field: string;
}

type LoadSecret = (slug: string) => Promise<unknown>;
type DecryptSecret = (config: Record<string, unknown>) => Record<string, unknown>;

async function loadSecret(slug: string): Promise<unknown> {
	return loadRegistryConfig("secret", slug, v.unknown());
}

export async function resolveSecretEnv(
	references: SecretEnvReference[],
	load: LoadSecret = loadSecret,
	decrypt: DecryptSecret = (config) =>
		decryptSecretConfig(config as never) as Record<string, unknown>,
): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const reference of references) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.name)) {
			throw new Error(
				`session-picker secret_env: invalid environment name "${reference.name}"`,
			);
		}
		const raw = await load(reference.secret_slug);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(
				`session-picker secret_env: required secret "${reference.secret_slug}" is missing`,
			);
		}
		const config = decrypt(raw as Record<string, unknown>);
		const value = config[reference.field];
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(
				`session-picker secret_env: required field "${reference.secret_slug}.${reference.field}" is missing`,
			);
		}
		env[reference.name] = value;
	}
	return env;
}

export async function secretEnvPrefix(
	references: SecretEnvReference[],
): Promise<string> {
	if (references.length === 0) return "";
	return renderEnvPrefix(await resolveSecretEnv(references));
}
