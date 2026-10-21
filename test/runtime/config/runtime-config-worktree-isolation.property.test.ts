import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
	getRuntimeGlobalConfigPath,
	getRuntimeProjectConfigPath,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { createTempProject, withTempKanbanHome } from "../../utilities/temp-kanban-home.js";

/**
 * Reads a JSON config file from disk, returning `null` when the file is absent
 * or unparsable. Reads the raw bytes directly (node:fs) rather than going
 * through the config loader so the assertions observe exactly what was written.
 */
function readRawConfig(configPath: string): Record<string, unknown> | null {
	if (!existsSync(configPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

describe("runtime-config worktree project override isolation", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	// Property 3: Project override isolation.
	// Validates: Requirements 1.3
	//
	// Persisting a project override writes it into that project's Project_Config
	// only: never into the Global_Config, and never into another project's
	// Project_Config.
	it("writes a project override only into that project's config file", async () => {
		await fc.assert(
			fc.asyncProperty(fc.boolean(), async (override) => {
				const home = withTempKanbanHome();
				cleanups.push(home.cleanup);
				// Both projects are git repos so a `true` override passes the
				// require-git guard in `updateRuntimeConfig`.
				const projectA = createTempProject({ git: true, prefix: "kanban-project-a-" });
				cleanups.push(projectA.cleanup);
				const projectB = createTempProject({ git: true, prefix: "kanban-project-b-" });
				cleanups.push(projectB.cleanup);

				const globalConfigPath = getRuntimeGlobalConfigPath();
				const projectAConfigPath = getRuntimeProjectConfigPath(projectA.path);
				const projectBConfigPath = getRuntimeProjectConfigPath(projectB.path);

				// Seed a Global_Config with no `worktreesEnabled` key so
				// `updateRuntimeConfig` skips the (slow) first-run agent PATH
				// detection. It also lets us assert the key is never added by a
				// project-override write.
				mkdirSync(dirname(globalConfigPath), { recursive: true });
				writeFileSync(globalConfigPath, JSON.stringify({ selectedAgentId: "cline" }), "utf8");

				const state = await updateRuntimeConfig(projectA.path, {
					projectWorktreesEnabled: override,
				});

				// The returned state reflects the project override only.
				expect(state.projectWorktreesEnabled).toBe(override);
				expect(state.globalWorktreesEnabled).toBeNull();

				// Project A's config file carries the override value under
				// `worktreesEnabled`.
				const projectAConfig = readRawConfig(projectAConfigPath);
				expect(projectAConfig).not.toBeNull();
				expect(Object.hasOwn(projectAConfig as object, "worktreesEnabled")).toBe(true);
				expect((projectAConfig as Record<string, unknown>).worktreesEnabled).toBe(override);

				// The Global_Config must NOT gain a `worktreesEnabled` key from
				// this project-override write.
				const globalConfig = readRawConfig(globalConfigPath);
				if (globalConfig !== null) {
					expect(Object.hasOwn(globalConfig, "worktreesEnabled")).toBe(false);
				}

				// Project B must not carry project A's override: its config file
				// either does not exist or does not hold A's value.
				const projectBConfig = readRawConfig(projectBConfigPath);
				if (projectBConfig !== null) {
					expect(Object.hasOwn(projectBConfig, "worktreesEnabled")).toBe(false);
				}

				// Clean up eagerly so repeated runs do not accumulate temp dirs.
				home.cleanup();
				projectA.cleanup();
				projectB.cleanup();
				cleanups.length = 0;
			}),
			// `fc.boolean()` only spans two cases; a small run count keeps disk +
			// `git init` I/O modest while still exercising both override values.
			{ numRuns: 6 },
		);
	}, 60_000);
});
