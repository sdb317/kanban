import { existsSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
	getRuntimeGlobalConfigPath,
	getRuntimeProjectConfigPath,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { INVALID_WORKTREES_ENABLED_MESSAGE } from "../../../src/config/worktree-setting";
import { parseRuntimeConfigSaveRequest } from "../../../src/core/api-validation";
import { createTempProject, withTempKanbanHome } from "../../utilities/temp-kanban-home.js";

/**
 * Snapshots a config file as raw bytes, or `null` when the file is absent.
 * Reading the raw bytes (node:fs) rather than going through the loader lets the
 * assertions observe byte-for-byte that nothing was written.
 */
function snapshotFile(configPath: string): string | null {
	return existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
}

/**
 * Mirrors the runtime's reject-before-write ordering for `saveConfig`: the save
 * request is validated with `parseRuntimeConfigSaveRequest` first, and only a
 * successfully parsed request reaches `updateRuntimeConfig`. An invalid request
 * therefore throws at parse time, before any file is touched.
 */
async function validateThenSave(cwd: string, request: unknown): Promise<void> {
	const parsed = parseRuntimeConfigSaveRequest(request);
	await updateRuntimeConfig(cwd, {
		...(parsed.worktreesEnabled !== undefined ? { worktreesEnabled: parsed.worktreesEnabled } : {}),
		...(parsed.projectWorktreesEnabled !== undefined
			? { projectWorktreesEnabled: parsed.projectWorktreesEnabled }
			: {}),
	});
}

/**
 * Non-boolean values that are invalid for BOTH `worktreesEnabled` and the
 * `projectWorktreesEnabled` override. `null` is deliberately excluded here: it
 * is a valid "clear override" value for `projectWorktreesEnabled` and is only
 * invalid for the global field, so it is generated separately.
 */
const invalidNonBooleanArbitrary = fc.oneof(
	fc.constantFrom<unknown>("true", "false", "", "yes", "no"),
	fc.constantFrom<unknown>(0, 1, -1, 42),
	fc.integer(),
	fc.string(),
	fc.array(fc.boolean()),
	fc.object(),
);

describe("runtime-config invalid worktree save rejection", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	// Property 5: Invalid saves are rejected without writes.
	// Validates: Requirements 1.11
	//
	// For any save request whose `worktreesEnabled` or `projectWorktreesEnabled`
	// is not a boolean (and, for the override, not `null`),
	// `parseRuntimeConfigSaveRequest` throws an error mentioning
	// `worktreesEnabled`, and both config files are byte-identical afterwards.
	it("rejects non-boolean worktree save fields and leaves both config files unchanged", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Which field carries the invalid value.
				fc.constantFrom<"global" | "project">("global", "project"),
				// The invalid value itself. `null` is appended only for the global
				// field, where it is invalid (for the override it means "clear").
				invalidNonBooleanArbitrary,
				fc.boolean(),
				async (field, invalidValue, useNullForGlobal) => {
					const home = withTempKanbanHome();
					cleanups.push(home.cleanup);
					// A non-git project is sufficient: the invalid save is rejected
					// at parse time, before the require-git guard can run. Seeding
					// uses `false` values, which never trip that guard either.
					const project = createTempProject({ git: false });
					cleanups.push(project.cleanup);

					const globalConfigPath = getRuntimeGlobalConfigPath();
					const projectConfigPath = getRuntimeProjectConfigPath(project.path);

					// Seed a known, valid state so there is real content on disk to
					// protect: a global value plus a project override.
					await updateRuntimeConfig(project.path, { worktreesEnabled: false });
					await updateRuntimeConfig(project.path, { projectWorktreesEnabled: false });

					const globalBefore = snapshotFile(globalConfigPath);
					const projectBefore = snapshotFile(projectConfigPath);

					const value = field === "global" && useNullForGlobal ? null : (invalidValue as unknown);
					const request = field === "global" ? { worktreesEnabled: value } : { projectWorktreesEnabled: value };

					// The parse-guarded save path must throw, and the error must
					// mention the worktrees field.
					await expect(validateThenSave(project.path, request)).rejects.toThrow(INVALID_WORKTREES_ENABLED_MESSAGE);

					// No write occurred: both files are byte-identical.
					expect(snapshotFile(globalConfigPath)).toBe(globalBefore);
					expect(snapshotFile(projectConfigPath)).toBe(projectBefore);

					// Clean up eagerly so repeated runs do not accumulate temp dirs.
					home.cleanup();
					project.cleanup();
					cleanups.length = 0;
				},
			),
			{ numRuns: 16 },
		);
	}, 60_000);

	// Example: `null` is a VALID override value (clear), so it must NOT be
	// rejected, confirming the generator above correctly excludes it for the
	// project field.
	it("accepts null as a valid projectWorktreesEnabled override (clear)", () => {
		const parsed = parseRuntimeConfigSaveRequest({ projectWorktreesEnabled: null });
		expect(parsed.projectWorktreesEnabled).toBeNull();
	});
});
