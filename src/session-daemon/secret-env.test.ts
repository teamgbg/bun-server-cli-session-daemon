// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { resolveSecretEnv } from "./secret-env.ts";
import { renderEnvPrefix } from "./runtime-tuning-env.ts";

describe("resolveSecretEnv", () => {
	test("injects a sealed database credential into the requested native env", async () => {
		const env = await resolveSecretEnv(
			[
				{
					name: "ANTHROPIC_AUTH_TOKEN",
					secret_slug: "zai-coding-plan-key",
					field: "token",
				},
			],
			async () => ({ token: "sealed-value" }),
			() => ({ token: "decrypted-value" }),
		);

		expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: "decrypted-value" });
		expect(renderEnvPrefix(env)).toBe(
			"export ANTHROPIC_AUTH_TOKEN='decrypted-value'; ",
		);
	});

	test("fails visibly when the referenced credential field is absent", async () => {
		await expect(
			resolveSecretEnv(
				[
					{
						name: "ANTHROPIC_AUTH_TOKEN",
						secret_slug: "zai-coding-plan-key",
						field: "token",
					},
				],
				async () => ({}),
				(config) => config,
			),
		).rejects.toThrow("zai-coding-plan-key.token");
	});

	test("refuses an environment name that could escape the shell assignment", async () => {
		await expect(
			resolveSecretEnv(
				[
					{
						name: "TOKEN; touch /tmp/pwned",
						secret_slug: "zai-coding-plan-key",
						field: "token",
					},
				],
				async () => ({ token: "x" }),
				(config) => config,
			),
		).rejects.toThrow("invalid environment name");
	});
});
