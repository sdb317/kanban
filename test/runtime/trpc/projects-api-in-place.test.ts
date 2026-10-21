import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeProjectTaskCounts } from "../../../src/core/api-contract";
import type { CreateWorkspaceRegistryDependencies, WorkspaceRegistry } from "../../../src/server/workspace-registry";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { type CreateProjectsApiDependencies, createProjectsApi } from "../../../src/trpc/projects-api";
import {
	createTempProject,
	type TempKanbanHome,
	type TempProject,
	withTempKanbanHome,
} from "../../utilities/temp-kanban-home.js";

function createProjectsApiDeps(serverCwd: string): CreateProjectsApiDependencies {
	return {
		getActiveWorkspacePath: vi.fn(() => null),
		getActiveWorkspaceId: vi.fn(() => null),
		rememberWorkspace: vi.fn(),
		setActiveWorkspace: vi.fn(async () => {}),
		clearActiveWorkspace: vi.fn(),
		resolveProjectInputPath: vi.fn((inputPath: string, cwd: string) => resolve(cwd, inputPath)),
		// Real directory check: a missing folder rejects, a real folder resolves.
		assertPathIsDirectory: vi.fn(async (path: string) => {
			const info = await stat(path);
			if (!info.isDirectory()) {
				throw new Error(`Not a directory: ${path}`);
			}
		}),
		// Non-git folder: no `.git` present.
		hasGitRepository: vi.fn(() => false),
		summarizeProjectTaskCounts: vi.fn(
			async (): Promise<RuntimeProjectTaskCounts> => ({
				backlog: 0,
				in_progress: 0,
				review: 0,
				trash: 0,
			}),
		),
		createProjectSummary: vi.fn((project) => ({
			id: project.workspaceId,
			path: project.repoPath,
			name: "test",
			taskCounts: project.taskCounts,
		})),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		getTerminalManagerForWorkspace: vi.fn(() => null),
		disposeWorkspace: vi.fn(() => ({
			terminalManager: null as TerminalSessionManager | null,
			workspacePath: null as string | null,
		})),
		collectProjectWorktreeTaskIdsForRemoval: vi.fn(() => new Set<string>()),
		loadGlobalWorktreesEnabled: vi.fn(async () => false),
		loadEffectiveWorktreesEnabled: vi.fn(async () => false),
		warn: vi.fn(),
		buildProjectsPayload: vi.fn(async () => ({ currentProjectId: null, projects: [] })),
		pickDirectoryPathFromSystemDialog: vi.fn(() => null),
		serverCwd,
	};
}

function createRuntimeConfigState(globalConfigPath: string, projectConfigPath: string | null): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: "cline",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		globalWorktreesEnabled: null,
		projectWorktreesEnabled: null,
		worktreesEnabled: false,
	};
}

function createRegistryDeps(cwd: string): CreateWorkspaceRegistryDependencies {
	const globalConfigPath = join(cwd, ".cline", "kanban", "config.json");
	return {
		cwd,
		loadGlobalRuntimeConfig: vi.fn(async () => createRuntimeConfigState(globalConfigPath, null)),
		loadRuntimeConfig: vi.fn(async (projectPath: string) =>
			createRuntimeConfigState(globalConfigPath, join(projectPath, ".cline", "kanban", "config.json")),
		),
		hasGitRepository: vi.fn(() => false),
		pathIsDirectory: vi.fn(async () => true),
		loadGlobalWorktreesEnabled: vi.fn(async () => false),
		loadEffectiveWorktreesEnabled: vi.fn(async () => false),
	};
}

describe("projects API addProject in In-Place Mode", () => {
	let home: TempKanbanHome;
	let project: TempProject;

	beforeEach(() => {
		home = withTempKanbanHome();
		project = createTempProject({ git: false });
	});

	afterEach(() => {
		project.cleanup();
		home.cleanup();
	});

	it("global false: registers a non-git folder without requiresGitInitialization and creates no .git", async () => {
		const deps = createProjectsApiDeps(project.path);
		const api = createProjectsApi(deps);

		const result = await api.addProject(null, { path: project.path });

		expect(result.ok).toBe(true);
		expect(result.requiresGitInitialization).toBeUndefined();
		expect(result.error).toBeUndefined();
		// No git initialization happened.
		expect(existsSync(join(project.path, ".git"))).toBe(false);
	});

	it("global true: returns requiresGitInitialization for a non-git folder", async () => {
		const deps = createProjectsApiDeps(project.path);
		(deps.loadGlobalWorktreesEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const api = createProjectsApi(deps);

		const result = await api.addProject(null, { path: project.path });

		expect(result.ok).toBe(false);
		expect(result.requiresGitInitialization).toBe(true);
		expect(result.project).toBeNull();
	});

	it("global false: rejects a missing folder (assertPathIsDirectory throws first)", async () => {
		const deps = createProjectsApiDeps(project.path);
		const api = createProjectsApi(deps);
		const missingPath = join(project.path, "does-not-exist");

		const result = await api.addProject(null, { path: missingPath });

		expect(result.ok).toBe(false);
		expect(result.requiresGitInitialization).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	it("global true: rejects a missing folder before the git-init flow", async () => {
		const deps = createProjectsApiDeps(project.path);
		(deps.loadGlobalWorktreesEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const api = createProjectsApi(deps);
		const missingPath = join(project.path, "does-not-exist");

		const result = await api.addProject(null, { path: missingPath });

		expect(result.ok).toBe(false);
		expect(result.requiresGitInitialization).toBeUndefined();
		expect(result.error).toBeDefined();
		// The git-init prompt must not fire for a path that never passed the
		// directory check.
		expect(deps.loadGlobalWorktreesEnabled).not.toHaveBeenCalled();
	});
});

describe("workspace registry launch cwd in In-Place Mode", () => {
	let home: TempKanbanHome;
	let project: TempProject;

	beforeEach(() => {
		home = withTempKanbanHome();
		project = createTempProject({ git: false });
	});

	afterEach(() => {
		project.cleanup();
		home.cleanup();
	});

	it("global false: registers a non-git launch cwd", async () => {
		const deps = createRegistryDeps(project.path);
		const registry: WorkspaceRegistry = await createWorkspaceRegistry(deps);

		expect(registry.getActiveWorkspaceId()).not.toBeNull();
		expect(registry.getActiveWorkspacePath()).not.toBeNull();
		// The registered path resolves to the launch cwd (via realpath).
		expect(registry.getActiveWorkspacePath()).toBe(realpathSync(project.path));
	});

	it("global true: does not register a non-git launch cwd", async () => {
		const deps = createRegistryDeps(project.path);
		(deps.loadGlobalWorktreesEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const registry: WorkspaceRegistry = await createWorkspaceRegistry(deps);

		// With worktrees required and no git repo, the launch cwd is not registered
		// and there are no indexed workspaces in a fresh temp HOME.
		expect(registry.getActiveWorkspaceId()).toBeNull();
		expect(registry.getActiveWorkspacePath()).toBeNull();
	});
});
