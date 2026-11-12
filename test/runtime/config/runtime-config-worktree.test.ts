import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, updateRuntimeConfig } from "../../../src/config/runtime-config";
import { WORKTREES_REQUIRE_GIT_MESSAGE } from "../../../src/config/worktree-setting";
import { parseRuntimeConfigSaveRequest } from "../../../src/core/api-validation";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createTempProject, withTempKanbanHome } from "../../utilities/temp-kanban-home";

/**
 * Example (non-property) tests for the worktree config behavior (subtask 2.11).
 *
 * Each test isolates HOME via `withTempKanbanHome` so the Global_Config lives in
 * a fresh temp dir, and seeds a selected agent in the Global_Config so the
 * missing-global auto-select side effect never performs PATH detection.
 */

const GLOBAL_CONFIG_SEGMENTS = [".kanban", "config.json"] as const;
const PROJECT_CONFIG_SEGMENTS = [".kanban", "config.json"] as const;

interface GlobalConfigFileShape {
	selectedAgentId?: string;
	worktreesEnabled?: unknown;
	[key: string]: unknown;
}

interface ProjectConfigFileShape {
	shortcuts?: unknown;
	worktreesEnabled?: unknown;
	[key: string]: unknown;
}

function globalConfigPath(homeDir: string): string {
	return join(homeDir, ...GLOBAL_CONFIG_SEGMENTS);
}

function projectConfigPath(projectPath: string): string {
	return join(projectPath, ...PROJECT_CONFIG_SEGMENTS);
}

/**
 * Seeds the Global_Config with a selected agent (and optional worktree value) so
 * `loadRuntimeConfig` never auto-selects an agent via PATH detection.
 */
function seedGlobalConfig(homeDir: string, extra: Record<string, unknown> = {}): void {
	const dir = join(homeDir, ".kanban");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ selectedAgentId: "cline", ...extra }, null, 2), "utf8");
}

function seedProjectConfig(projectPath: string, contents: Record<string, unknown>): void {
	const dir = join(projectPath, ".kanban");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(contents, null, 2), "utf8");
}

function readGlobalConfig(homeDir: string): GlobalConfigFileShape {
	return JSON.parse(readFileSync(globalConfigPath(homeDir), "utf8")) as GlobalConfigFileShape;
}

function readProjectConfig(projectPath: string): ProjectConfigFileShape {
	return JSON.parse(readFileSync(projectConfigPath(projectPath), "utf8")) as ProjectConfigFileShape;
}

describe.sequential("runtime-config worktree behavior", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves effective false when the project override is false and global is true", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-override-false-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-override-false-" });
		try {
			seedGlobalConfig(home.homeDir, { worktreesEnabled: true });
			seedProjectConfig(project.path, { worktreesEnabled: false });

			const state = await loadRuntimeConfig(project.path);
			expect(state.globalWorktreesEnabled).toBe(true);
			expect(state.projectWorktreesEnabled).toBe(false);
			expect(state.worktreesEnabled).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("resolves effective true when the project override is true and global is false", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-override-true-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-override-true-" });
		try {
			seedGlobalConfig(home.homeDir, { worktreesEnabled: false });
			seedProjectConfig(project.path, { worktreesEnabled: true });

			const state = await loadRuntimeConfig(project.path);
			expect(state.globalWorktreesEnabled).toBe(false);
			expect(state.projectWorktreesEnabled).toBe(true);
			expect(state.worktreesEnabled).toBe(true);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("applies the global setting when there is no project override", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-global-true-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-global-true-" });
		try {
			seedGlobalConfig(home.homeDir, { worktreesEnabled: true });

			const enabledState = await loadRuntimeConfig(project.path);
			expect(enabledState.globalWorktreesEnabled).toBe(true);
			expect(enabledState.projectWorktreesEnabled).toBeNull();
			expect(enabledState.worktreesEnabled).toBe(true);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("applies a global false setting when there is no project override", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-global-false-");
		const project = createTempProject({ git: false, prefix: "kanban-project-worktree-global-false-" });
		try {
			seedGlobalConfig(home.homeDir, { worktreesEnabled: false });

			const state = await loadRuntimeConfig(project.path);
			expect(state.globalWorktreesEnabled).toBe(false);
			expect(state.projectWorktreesEnabled).toBeNull();
			expect(state.worktreesEnabled).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("defaults to false when both files are missing or lack the worktreesEnabled key", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-default-");
		const project = createTempProject({ git: false, prefix: "kanban-project-worktree-default-" });
		try {
			// No config files written at all.
			const missing = await loadRuntimeConfig(project.path);
			expect(missing.globalWorktreesEnabled).toBeNull();
			expect(missing.projectWorktreesEnabled).toBeNull();
			expect(missing.worktreesEnabled).toBe(false);

			// Files exist but omit the worktreesEnabled key.
			seedGlobalConfig(home.homeDir);
			seedProjectConfig(project.path, { shortcuts: [] });
			const present = await loadRuntimeConfig(project.path);
			expect(present.globalWorktreesEnabled).toBeNull();
			expect(present.projectWorktreesEnabled).toBeNull();
			expect(present.worktreesEnabled).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("treats string, number, and null stored values as unset", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-invalid-stored-");
		const project = createTempProject({ git: false, prefix: "kanban-project-worktree-invalid-stored-" });
		try {
			const invalidValues: readonly unknown[] = ["true", "false", 0, 1, null];
			for (const globalValue of invalidValues) {
				for (const projectValue of invalidValues) {
					seedGlobalConfig(home.homeDir, { worktreesEnabled: globalValue });
					seedProjectConfig(project.path, { worktreesEnabled: projectValue });

					const state = await loadRuntimeConfig(project.path);
					expect(state.globalWorktreesEnabled).toBeNull();
					expect(state.projectWorktreesEnabled).toBeNull();
					// All sources unset -> default false.
					expect(state.worktreesEnabled).toBe(false);
				}
			}
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("falls through an invalid global value to a valid project override", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-invalid-global-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-invalid-global-" });
		try {
			seedGlobalConfig(home.homeDir, { worktreesEnabled: "true" });
			seedProjectConfig(project.path, { worktreesEnabled: true });

			const state = await loadRuntimeConfig(project.path);
			expect(state.globalWorktreesEnabled).toBeNull();
			expect(state.projectWorktreesEnabled).toBe(true);
			expect(state.worktreesEnabled).toBe(true);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("omits worktreesEnabled from the Global_Config when writing false and the key was absent", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-omit-false-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-omit-false-" });
		try {
			seedGlobalConfig(home.homeDir);

			const updated = await updateRuntimeConfig(project.path, { worktreesEnabled: false });
			expect(updated.worktreesEnabled).toBe(false);

			// Req 1.9: the key is omitted from the file when writing `false` and it was absent before.
			const raw = readGlobalConfig(home.homeDir);
			expect(Object.hasOwn(raw, "worktreesEnabled")).toBe(false);

			// Reloading from disk therefore treats the global source as unset.
			const reloaded = await loadRuntimeConfig(project.path);
			expect(reloaded.globalWorktreesEnabled).toBeNull();
			expect(reloaded.worktreesEnabled).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("rejects a non-boolean save value via the save-request schema", () => {
		expect(() => parseRuntimeConfigSaveRequest({ worktreesEnabled: "true" })).toThrow();
		expect(() => parseRuntimeConfigSaveRequest({ worktreesEnabled: 1 })).toThrow();
		expect(() => parseRuntimeConfigSaveRequest({ projectWorktreesEnabled: "false" })).toThrow();
		expect(() => parseRuntimeConfigSaveRequest({ projectWorktreesEnabled: 0 })).toThrow();
		// Valid shapes are accepted (including an explicit null to clear the override).
		expect(parseRuntimeConfigSaveRequest({ worktreesEnabled: true }).worktreesEnabled).toBe(true);
		expect(parseRuntimeConfigSaveRequest({ projectWorktreesEnabled: null }).projectWorktreesEnabled).toBeNull();
	});

	it("deletes an otherwise-empty project config file when the override is cleared", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-clear-delete-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-clear-delete-" });
		try {
			seedGlobalConfig(home.homeDir);
			seedProjectConfig(project.path, { worktreesEnabled: true });
			expect(existsSync(projectConfigPath(project.path))).toBe(true);

			const updated = await updateRuntimeConfig(project.path, { projectWorktreesEnabled: null });
			expect(updated.projectWorktreesEnabled).toBeNull();
			// No shortcuts and no override remain -> the file is removed entirely.
			expect(existsSync(projectConfigPath(project.path))).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("keeps the project config file with shortcuts when the override is cleared", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-clear-keep-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-clear-keep-" });
		try {
			seedGlobalConfig(home.homeDir);
			seedProjectConfig(project.path, {
				worktreesEnabled: true,
				shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
			});

			const updated = await updateRuntimeConfig(project.path, { projectWorktreesEnabled: null });
			expect(updated.projectWorktreesEnabled).toBeNull();

			// The file remains (shortcuts survive) but the worktreesEnabled key is gone.
			expect(existsSync(projectConfigPath(project.path))).toBe(true);
			const raw = readProjectConfig(project.path);
			expect(Object.hasOwn(raw, "worktreesEnabled")).toBe(false);
			expect(raw.shortcuts).toEqual([{ label: "Ship", command: "npm run ship", icon: "rocket" }]);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("rejects enabling worktrees for a non-git project (Req 2.7 guard)", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-git-guard-");
		const project = createTempProject({ git: false, prefix: "kanban-project-worktree-git-guard-" });
		try {
			seedGlobalConfig(home.homeDir);

			await expect(updateRuntimeConfig(project.path, { worktreesEnabled: true })).rejects.toThrow(
				WORKTREES_REQUIRE_GIT_MESSAGE,
			);
			// No config was written for the rejected value.
			const raw = readGlobalConfig(home.homeDir);
			expect(Object.hasOwn(raw, "worktreesEnabled")).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("creates only <project>/.kanban as a folder on a project write", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-folders-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-folders-" });
		try {
			seedGlobalConfig(home.homeDir);

			await updateRuntimeConfig(project.path, { projectWorktreesEnabled: true });

			// The only Kanban-created folder under the project is `.kanban`.
			expect(existsSync(join(project.path, ".kanban"))).toBe(true);
			expect(existsSync(projectConfigPath(project.path))).toBe(true);
			// No stray sibling folders were created.
			expect(existsSync(join(project.path, ".cline"))).toBe(false);
			expect(existsSync(join(project.path, "kanban"))).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});

	it("leaves the old project file and effective value intact when a locked write fails (Req 14.5)", async () => {
		const home = withTempKanbanHome("kanban-home-worktree-write-failure-");
		const project = createTempProject({ git: true, prefix: "kanban-project-worktree-write-failure-" });
		try {
			seedGlobalConfig(home.homeDir);
			// Establish a known project override of `false` first.
			await updateRuntimeConfig(project.path, { projectWorktreesEnabled: false });
			const before = await loadRuntimeConfig(project.path);
			expect(before.projectWorktreesEnabled).toBe(false);
			expect(before.worktreesEnabled).toBe(false);
			const beforeRaw = readFileSync(projectConfigPath(project.path), "utf8");

			// Inject a write failure in the locked filesystem.
			const writeSpy = vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockRejectedValue(new Error("disk full"));

			await expect(updateRuntimeConfig(project.path, { projectWorktreesEnabled: true })).rejects.toThrow(
				"disk full",
			);

			writeSpy.mockRestore();

			// The previously-written file is unchanged, and so is the loaded effective value.
			expect(readFileSync(projectConfigPath(project.path), "utf8")).toBe(beforeRaw);
			const after = await loadRuntimeConfig(project.path);
			expect(after.projectWorktreesEnabled).toBe(false);
			expect(after.worktreesEnabled).toBe(false);
		} finally {
			project.cleanup();
			home.cleanup();
		}
	});
});
