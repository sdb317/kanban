import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
	getRuntimeGlobalConfigPath,
	getRuntimeProjectConfigPath,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { WORKTREES_REQUIRE_GIT_MESSAGE } from "../../../src/config/worktree-setting";
import { createTempProject, withTempKanbanHome } from "../../utilities/temp-kanban-home.js";

/**
 * Snapshot of a config file on disk: whether it exists and its exact raw bytes.
 * Reads the raw file directly (node:fs) rather than going through the config
 * loader so the assertions observe exactly what is (or is not) on disk.
 */
interface ConfigFileSnapshot {
	exists: boolean;
	contents: string | null;
}

function snapshotConfigFile(configPath: string): ConfigFileSnapshot {
	if (!existsSync(configPath)) {
		return { exists: false, contents: null };
	}
	return { exists: true, contents: readFileSync(configPath, "utf8") };
}

function expectFileUnchanged(before: ConfigFileSnapshot, after: ConfigFileSnapshot): void {
	expect(after.exists).toBe(before.exists);
	expect(after.contents).toBe(before.contents);
}

/**
 * Seeds the Global_Config with a pinned agent so `updateRuntimeConfig` skips its
 * agent-auto-select side effect (which otherwise spawns agent detection and
 * writes the file on a fresh HOME). This keeps the guard's "no write" behavior
 * observable: the seeded file must stay byte-identical after a rejected save.
 */
function seedGlobalConfig(contents: Record<string, unknown>): void {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	mkdirSync(dirname(globalConfigPath), { recursive: true });
	writeFileSync(globalConfigPath, JSON.stringify(contents), "utf8");
}

describe("runtime-config worktrees-require-git guard", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	// Property 6: Worktrees require git.
	// Validates: Requirements 2.7
	//
	// For a NON-GIT project, any save whose next effective value would be `true`
	// is rejected with WORKTREES_REQUIRE_GIT_MESSAGE, and neither Global_Config
	// nor Project_Config is written as a result.
	it("rejects enabling worktrees on a non-git project without writing either config", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Scenarios whose next effective value is `true` on a non-git
				// project:
				//  - project override true, any global (unset / false / true)
				//  - no override (use global default) AND global true
				fc.oneof(
					fc
						.constantFrom<boolean | null | undefined>(true, false, null, undefined)
						.map((global) => ({ projectWorktreesEnabled: true as const, worktreesEnabled: global })),
					fc.constant({ projectWorktreesEnabled: undefined, worktreesEnabled: true as const }),
				),
				async (scenario) => {
					const home = withTempKanbanHome();
					cleanups.push(home.cleanup);
					// Seed a pinned agent so the save path does not auto-select
					// an agent and write the global config as a side effect.
					seedGlobalConfig({ selectedAgentId: "cline" });
					const project = createTempProject({ git: false });
					cleanups.push(project.cleanup);

					const globalConfigPath = getRuntimeGlobalConfigPath();
					const projectConfigPath = getRuntimeProjectConfigPath(project.path);

					const globalBefore = snapshotConfigFile(globalConfigPath);
					const projectBefore = snapshotConfigFile(projectConfigPath);
					expect(projectBefore.exists).toBe(false);

					const updates: Parameters<typeof updateRuntimeConfig>[1] = {};
					if (scenario.projectWorktreesEnabled !== undefined) {
						updates.projectWorktreesEnabled = scenario.projectWorktreesEnabled;
					}
					if (scenario.worktreesEnabled === true) {
						updates.worktreesEnabled = true;
					} else if (scenario.worktreesEnabled === false) {
						updates.worktreesEnabled = false;
					}

					await expect(updateRuntimeConfig(project.path, updates)).rejects.toThrow(WORKTREES_REQUIRE_GIT_MESSAGE);

					// The rejection leaves both config files byte-identical: the
					// seeded global config is untouched and the project config is
					// still absent.
					expectFileUnchanged(globalBefore, snapshotConfigFile(globalConfigPath));
					expectFileUnchanged(projectBefore, snapshotConfigFile(projectConfigPath));

					home.cleanup();
					project.cleanup();
					cleanups.length = 0;
				},
			),
			{ numRuns: 8 },
		);
	}, 60_000);

	// Negative cases: on a non-git project, a save whose next effective value
	// stays `false` must succeed (no throw). These exercise the guard's
	// "only when the effective value would become true" condition.
	it("allows saves that keep the effective value false on a non-git project", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					// Explicit project override `false` (with any global).
					fc
						.constantFrom<boolean | undefined>(true, false, undefined)
						.map((global) => ({ projectWorktreesEnabled: false as const, worktreesEnabled: global })),
					// Global `false`, no override.
					fc.constant({ projectWorktreesEnabled: undefined, worktreesEnabled: false as const }),
				),
				async (scenario) => {
					const home = withTempKanbanHome();
					cleanups.push(home.cleanup);
					seedGlobalConfig({ selectedAgentId: "cline" });
					const project = createTempProject({ git: false });
					cleanups.push(project.cleanup);

					const updates: Parameters<typeof updateRuntimeConfig>[1] = {};
					if (scenario.projectWorktreesEnabled !== undefined) {
						updates.projectWorktreesEnabled = scenario.projectWorktreesEnabled;
					}
					if (scenario.worktreesEnabled !== undefined) {
						updates.worktreesEnabled = scenario.worktreesEnabled;
					}

					const state = await updateRuntimeConfig(project.path, updates);
					// Effective value stays false and no error is thrown.
					expect(state.worktreesEnabled).toBe(false);

					home.cleanup();
					project.cleanup();
					cleanups.length = 0;
				},
			),
			{ numRuns: 8 },
		);
	}, 60_000);
});
