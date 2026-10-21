import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

import { afterEach, describe, expect, it } from "vitest";

import {
	loadRuntimeConfig,
	type RuntimeConfigUpdateInput,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { resolveEffectiveWorktreesEnabled } from "../../../src/config/worktree-setting";
import { runtimeConfigResponseSchema } from "../../../src/core/api-contract";
import { buildRuntimeConfigResponse } from "../../../src/terminal/agent-registry";
import { createTempProject, type TempKanbanHome, withTempKanbanHome } from "../../utilities/temp-kanban-home";

/**
 * Property 2: Config save/load round trip.
 * Validates: Requirements 1.2, 1.8, 1.10, 1.12, 1.13
 *
 * For ALL valid worktree configurations (each of the global setting and the
 * project override being `true`, `false`, or unset), saving the configuration
 * and then loading it yields the same global setting, project override, and
 * effective value. The loaded config response also validates against
 * `runtimeConfigResponseSchema`.
 */

/** The finite valid worktree-setting domain: a boolean or unset (null). */
const worktreeValueArbitrary: fc.Arbitrary<boolean | null> = fc.constantFrom(true, false, null);

/**
 * A neutral set of Cline provider settings so the config response can be built
 * and validated against its schema. Values are irrelevant to this property.
 */
const clineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	apiKeyConfigured: false,
	oauthProvider: null,
	oauthAccessTokenConfigured: false,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: null,
	oauthExpiresAt: null,
} as const;

/**
 * Translate a desired stored value into the update input understood by
 * `updateRuntimeConfig`. `undefined` leaves the global setting untouched (it
 * stays unset in a fresh home); `null` clears the project override.
 */
function toGlobalUpdate(value: boolean | null): boolean | undefined {
	return value === null ? undefined : value;
}

/**
 * Expected persisted/loaded Global_Worktree_Setting for a requested global
 * value, accounting for Req 1.9: writing `false` while the `worktreesEnabled`
 * key was absent from Global_Config omits the key, so it loads back as unset
 * (`null`). The effective value is unaffected because absent and `false` both
 * resolve to `false`. `true` and unset round-trip to themselves.
 */
function expectedPersistedGlobal(requested: boolean | null): boolean | null {
	return requested === false ? null : requested;
}

/**
 * Seed a minimal Global_Config (an agent id only, no `worktreesEnabled` key) so
 * the loader does not trigger agent PATH detection per case. The absent
 * `worktreesEnabled` key preserves the Req 1.9 omission behavior under test.
 */
function seedGlobalConfig(homeDir: string): void {
	const dir = join(homeDir, ".cline", "kanban");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ selectedAgentId: "cline" }), "utf8");
}

describe("runtime-config worktree save/load round trip", () => {
	let tempHome: TempKanbanHome | null = null;

	afterEach(() => {
		tempHome?.cleanup();
		tempHome = null;
	});

	// The valid domain is only 3 x 3 = 9 combinations; a modest run count covers
	// it while keeping real git + disk I/O per case affordable. A generous
	// timeout accommodates `git init` + commit done once per generated case.
	it(
		"round-trips every valid global/override combination and the loaded response is schema-valid",
		{ timeout: 120_000 },
		async () => {
			await fc.assert(
				fc.asyncProperty(worktreeValueArbitrary, worktreeValueArbitrary, async (global, override) => {
					// Fresh, isolated HOME per case so neither Global_Config nor any
					// prior override leaks between generated cases.
					tempHome = withTempKanbanHome();
					seedGlobalConfig(tempHome.homeDir);
					// A git project so effective `true` passes the worktrees-require-git
					// guard (Req 2.7) and every combination is accepted.
					const project = createTempProject({ git: true });
					try {
						const updates: RuntimeConfigUpdateInput = {
							worktreesEnabled: toGlobalUpdate(global),
							projectWorktreesEnabled: override,
						};

						const saved = await updateRuntimeConfig(project.path, updates);
						const loaded = await loadRuntimeConfig(project.path);

						// What persists to disk (and therefore what a fresh load sees):
						// the project override is stored verbatim for booleans and
						// cleared for `null`; the global value is subject to Req 1.9.
						const persistedGlobal = expectedPersistedGlobal(global);
						const persistedOverride = override;
						// The effective value is invariant under the Req 1.9 omission
						// because absent and `false` both resolve to `false`.
						const expectedEffective = resolveEffectiveWorktreesEnabled({
							globalWorktreesEnabled: persistedGlobal,
							projectWorktreesEnabled: persistedOverride,
						});

						// The save result reflects the requested configuration in memory.
						expect(saved.globalWorktreesEnabled).toBe(global);
						expect(saved.projectWorktreesEnabled).toBe(override);
						expect(saved.worktreesEnabled).toBe(expectedEffective);

						// Round trip: a fresh load reproduces the persisted values and
						// the same effective value (Req 1.10, 1.12, 1.13).
						expect(loaded.globalWorktreesEnabled).toBe(persistedGlobal);
						expect(loaded.projectWorktreesEnabled).toBe(persistedOverride);
						expect(loaded.worktreesEnabled).toBe(expectedEffective);
						// Effective value is always a boolean (Req 1.8).
						expect(typeof loaded.worktreesEnabled).toBe("boolean");

						// The config response built from the loaded state validates
						// against the shared response schema (Req 1.8).
						const response = buildRuntimeConfigResponse(loaded, clineProviderSettings);
						const parsed = runtimeConfigResponseSchema.safeParse(response);
						expect(parsed.success).toBe(true);
						expect(response.globalWorktreesEnabled).toBe(persistedGlobal);
						expect(response.projectWorktreesEnabled).toBe(persistedOverride);
						expect(response.worktreesEnabled).toBe(expectedEffective);
					} finally {
						project.cleanup();
						tempHome.cleanup();
						tempHome = null;
					}
				}),
				{ numRuns: 15 },
			);
		},
	);
});
