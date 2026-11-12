import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
    getRuntimeGlobalConfigPath,
    getRuntimeProjectConfigPath,
    loadRuntimeConfig,
    updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { createTempProject, type TempKanbanHome, withTempKanbanHome } from "../../utilities/temp-kanban-home.js";

/**
 * Property 4: Invalid stored values are ignored and preserved.
 * Validates: Requirements 1.7
 *
 * A non-boolean `worktreesEnabled` in Global_Config or Project_Config is:
 *  - treated as UNSET during resolution (globalWorktreesEnabled /
 *    projectWorktreesEnabled === null, effective falls through to default
 *    `false`), and
 *  - left UNCHANGED on disk: byte-identical across a pure `loadRuntimeConfig`,
 *    and preserved verbatim after saving an UNRELATED field via
 *    `updateRuntimeConfig`.
 */

// The full space of non-boolean (invalid) raw values a `worktreesEnabled` key
// can hold. Real booleans are excluded on purpose — they are valid.
const invalidWorktreeValueArbitrary: fc.Arbitrary<unknown> = fc.oneof(
	fc.constantFrom("true", "false"),
	fc.constantFrom(0, 1, 42),
	fc.constant(null),
	fc.constant({}),
	fc.constant([1, 2]),
	fc.constant({ a: 1 }),
);

/** Writes a config.json at `path`, creating `.kanban` as needed. */
function writeConfigFile(path: string, contents: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(contents, null, 2), "utf8");
}

function readRawWorktreeValue(path: string): unknown {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { worktreesEnabled?: unknown };
	return parsed.worktreesEnabled;
}

let activeHome: TempKanbanHome | null = null;

afterEach(() => {
	activeHome?.cleanup();
	activeHome = null;
});

describe("runtime-config worktreesEnabled invalid stored values", () => {
	it("treats an invalid global value as unset and leaves both files byte-identical after a pure load", async () => {
		await fc.assert(
			fc.asyncProperty(
				invalidWorktreeValueArbitrary,
				invalidWorktreeValueArbitrary,
				async (badGlobal, badProject) => {
					const home = withTempKanbanHome();
					activeHome = home;
					const project = createTempProject({ git: false });
					try {
						const globalPath = getRuntimeGlobalConfigPath();
						const projectPath = getRuntimeProjectConfigPath(project.path);

						// Global config has a valid, unrelated field plus an invalid worktreesEnabled.
						writeConfigFile(globalPath, { selectedAgentId: "cline", worktreesEnabled: badGlobal });
						writeConfigFile(projectPath, {
							shortcuts: [{ label: "Build", command: "npm run build" }],
							worktreesEnabled: badProject,
						});

						const globalBytesBefore = readFileSync(globalPath);
						const projectBytesBefore = readFileSync(projectPath);

						const state = await loadRuntimeConfig(project.path);

						// Invalid values resolve as unset; effective falls through to default false.
						expect(state.globalWorktreesEnabled).toBeNull();
						expect(state.projectWorktreesEnabled).toBeNull();
						expect(state.worktreesEnabled).toBe(false);

						// A pure load rewrites nothing: both files are byte-for-byte identical.
						expect(readFileSync(globalPath).equals(globalBytesBefore)).toBe(true);
						expect(readFileSync(projectPath).equals(projectBytesBefore)).toBe(true);
					} finally {
						project.cleanup();
						home.cleanup();
						activeHome = null;
					}
				},
			),
			{ numRuns: 40 },
		);
	});

	it("preserves an invalid worktreesEnabled value verbatim when an unrelated field is saved", async () => {
		await fc.assert(
			fc.asyncProperty(
				invalidWorktreeValueArbitrary,
				invalidWorktreeValueArbitrary,
				async (badGlobal, badProject) => {
					const home = withTempKanbanHome();
					activeHome = home;
					const project = createTempProject({ git: false });
					try {
						const globalPath = getRuntimeGlobalConfigPath();
						const projectPath = getRuntimeProjectConfigPath(project.path);

						// Seed both files with an invalid worktreesEnabled value.
						writeConfigFile(globalPath, { selectedAgentId: "cline", worktreesEnabled: badGlobal });
						writeConfigFile(projectPath, {
							shortcuts: [{ label: "Build", command: "npm run build" }],
							worktreesEnabled: badProject,
						});

						// Save an UNRELATED field. No worktree update is provided, so the
						// writers must copy the existing raw value unchanged (task 2.4).
						const next = await updateRuntimeConfig(project.path, { selectedAgentId: "claude" });

						// The unrelated update did not resolve the invalid values.
						expect(next.globalWorktreesEnabled).toBeNull();
						expect(next.projectWorktreesEnabled).toBeNull();
						expect(next.worktreesEnabled).toBe(false);

						// Both files are rewritten by the update; assert the invalid
						// worktreesEnabled raw value is preserved byte-identically in-value.
						expect(readRawWorktreeValue(globalPath)).toStrictEqual(badGlobal);
						expect(readRawWorktreeValue(projectPath)).toStrictEqual(badProject);
					} finally {
						project.cleanup();
						home.cleanup();
						activeHome = null;
					}
				},
			),
			{ numRuns: 40 },
		);
	});
});
