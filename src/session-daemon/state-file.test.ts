// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { buildSessionStateConfig, redactCommandToTemplate } from "./state-config.ts";
import type { SessionStateConfig } from "@teamscala/db-validation/registry-schemas/session-state";

/** A closed-tab archive entry carrying the session id restore would replay. */
const archivedLane = {
	optionSlug: "codex",
	windowName: "Lost Lane",
	sessionId: "968b4b67-0f87-4ba5-b871-8b38d2ed63b3",
	cwd: "/home/op",
	closedAt: "2026-08-01T10:51:13.506Z",
};
const liveTab = {
	optionSlug: "codex",
	windowName: "Survivor",
	sessionId: "11111111-1111-1111-1111-111111111111",
};

describe("buildSessionStateConfig preserves durable state a partial caller did not touch", () => {
	test("THE FIX: a {tabs}-only save inherits closedTabs[] + archived", () => {
		// patchTab / writeCapturedSessionId shape: ONLY tabs supplied, the call
		// that used to wipe the archive. The omitted fields inherit their priors.
		const out = buildSessionStateConfig(
			{ tabs: [liveTab, { optionSlug: "bash", windowName: "new" }] } as SessionStateConfig,
			{ closedTabs: [archivedLane], archived: true },
		);
		expect(out.closedTabs).toEqual([archivedLane]);
		expect(out.archived).toBe(true);
		expect(out.tabs.map((t) => t.windowName)).toEqual(["Survivor", "new"]);
	});

	test("BEHAVIOURAL REGRESSION GUARD: before the fix this exact call wiped the archive", () => {
		// Same disease the fix closes: a partial save over a row that held an
		// archive. Post-fix the archive is present; reverting to a raw full-config
		// write makes this assertion fail.
		const out = buildSessionStateConfig(
			{ tabs: [{ optionSlug: "bash", windowName: "x" }] } as SessionStateConfig,
			{ closedTabs: [archivedLane] },
		);
		expect(out.closedTabs).toEqual([archivedLane]);
	});

	test("an explicit closedTabs override is honoured (reconcile/restore set it)", () => {
		const freshClosed = [
			{ ...archivedLane, windowName: "Fresh Close", closedAt: "2026-08-01T11:00:00.000Z" },
		];
		const out = buildSessionStateConfig(
			{ tabs: [liveTab], closedTabs: freshClosed } as SessionStateConfig,
			{ closedTabs: [archivedLane], archived: true },
		);
		// Caller's list wins over the inherited one …
		expect(out.closedTabs).toEqual(freshClosed);
		// … and archived is still inherited (it was not supplied either).
		expect(out.archived).toBe(true);
	});

	test("an explicit empty closedTabs[] CLEARS the archive (restore dropping the last reopened entry)", () => {
		// restore cleanup passes the filtered list; restoring the last closed tab
		// yields []. That must CLEAR closedTabs, never silently preserve a stale
		// archive. An explicit [] is not inherited (only an OMITTED field is).
		const out = buildSessionStateConfig(
			{ tabs: [liveTab], closedTabs: [] } as SessionStateConfig,
			{ closedTabs: [archivedLane] },
		);
		expect(out.closedTabs).toBeUndefined();
	});

	test("a brand-new session (no inherited row) writes tabs with nothing to inherit", () => {
		const out = buildSessionStateConfig(
			{ tabs: [{ optionSlug: "bash", windowName: "first" }] } as SessionStateConfig,
			null,
		);
		expect(out.tabs).toHaveLength(1);
		expect(out.closedTabs).toBeUndefined();
		expect(out.archived).toBeUndefined();
	});

	test("archived flag inherited independently of closedTabs (setTabLabel shape)", () => {
		// setTabLabel passes closedTabs but NOT archived — archived must still be
		// inherited so an operator-hidden session is not un-hidden by a rename.
		const out = buildSessionStateConfig(
			{ tabs: [liveTab], closedTabs: [archivedLane] } as SessionStateConfig,
			{ archived: true },
		);
		expect(out.closedTabs).toEqual([archivedLane]);
		expect(out.archived).toBe(true);
	});
});

describe("redactCommandToTemplate — an archived command retains the placeholder, never the resolved key", () => {
	// The option's command TEMPLATE is the command BEFORE spawn resolves + prepends
	// the option's secret_env. An archived command healed to it holds the
	// unsubstituted placeholder form; the resolved key is gone.
	const templates = new Map([["codex", 'cd "$HOME/workspace"; codex exec']]);

	test("a materialised command (resolved secret prepended) is healed to the option template", () => {
		// The spawn-time materialised form prepends resolved secret_env values as
		// `export SECRET='literal';` — the exact leak /rpc/closed-tabs returned.
		const materialised = `export OLLAMA_CLI_API_KEY='sk-resolved-literal'; cd "$HOME/workspace"; codex exec`;
		expect(redactCommandToTemplate(materialised, "codex", templates)).toBe(
			'cd "$HOME/workspace"; codex exec',
		);
	});

	test("THE GUARD: the resolved key is gone and the template (placeholder) is retained", () => {
		// Full materialised spawn form: the spawn prefix (unset + PATH + runtime
		// tuning) + the resolved secret prefix + the option command. Redaction
		// replaces the whole rendered string with the template, so the resolved
		// key AND every spawn-time prefix is gone — only the placeholder remains.
		const materialised = `unset SERVICE_SLUG; export PATH="$HOME/.bun/bin:$PATH"; export JSC_numberOfGCMarkers='1'; export OLLAMA_CLI_API_KEY='sk-resolved-literal'; cd "$HOME/workspace"; codex exec`;
		const healed = redactCommandToTemplate(materialised, "codex", templates);
		expect(healed).not.toContain("sk-resolved-literal");
		expect(healed).not.toContain("OLLAMA_CLI_API_KEY");
		expect(healed).toBe('cd "$HOME/workspace"; codex exec');
	});

	test("a clean template command is left untouched (idempotent — a healed row writes nothing)", () => {
		const clean = 'cd "$HOME/workspace"; codex exec';
		expect(redactCommandToTemplate(clean, "codex", templates)).toBe(clean);
	});

	test("a deactivated option (no template) is left untouched — diagnostic data preserved", () => {
		// No template to verify against; the command is unchanged. Deactivated
		// options carry no secret_env literal, so this is the documented trade-off
		// in scrubStoredCommandSecrets, not a leak.
		const cmd = `export OLLAMA_CLI_API_KEY='x'; ghost-cmd`;
		expect(redactCommandToTemplate(cmd, "ghost", new Map())).toBe(cmd);
	});

	test("undefined command stays undefined", () => {
		expect(redactCommandToTemplate(undefined, "codex", templates)).toBeUndefined();
	});
});
