/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * bun runs every test file in ONE process and `mock.module` is process-global:
 * a mocked module left registered at end-of-file is what every LATER file
 * imports. Stage mocks here and call `restoreMockedModules` from the file's
 * `afterAll`, which re-registers each real module before the next file runs.
 */

import { mock } from "bun:test";

const capturedReals = new Map<string, Record<string, unknown>>();

export async function mockModuleRestorable<T extends Record<string, unknown>>(
	spec: string,
	factory: (real: T) => T,
): Promise<void> {
	if (!capturedReals.has(spec)) {
		capturedReals.set(spec, (await import(spec)) as Record<string, unknown>);
	}
	const real = capturedReals.get(spec) as T;
	mock.module(spec, () => factory(real));
}

export function restoreMockedModules(): void {
	for (const [spec, real] of capturedReals) {
		mock.module(spec, () => real);
	}
}
