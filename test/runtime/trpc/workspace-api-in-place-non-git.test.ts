import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncResponseSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../../../src/core/api-contract";
import { createTempProject, type TempProject } from "../../utilities/temp-kanban-home";

/**
 * Task 6.4 — Example tests for the In-Place Mode (Effective_Worktree_Setting =
 * false) branch of `createWorkspaceApi` on a project folder that is NOT a git
 * repository.
 *
 * These assert the exact fields required by Requirement 5 (criteria 2–6) and
 * that the same responses hold even though the folder is not a git repo (5.8).
 * Every git-capable entry point in the backend ultimately spawns `git` through
 * `node:child_process` (`execFile` in git-utils / search-workspace-files,
 * `spawnSync` in workspace-state), so we mock that module with real
 * implementations wrapped in spies and assert no child process is ever spawned
 * for the Worktree, Diff, and Git endpoint calls.
 */

const childProcessSpies = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	childProcessSpies.execFile.mockImplementation(actual.execFile);
	childProcessSpies.execFileSync.mockImplementation(actual.execFileSync);
	childProcessSpies.spawn.mockImplementation(actual.spawn);
	childProcessSpies.spawnSync.mockImplementation(actual.spawnSync);
	return {
		...actual,
		execFile: childProcessSpies.execFile as unknown as typeof actual.execFile,
		execFileSync: childProcessSpies.execFileSync as unknown as typeof actual.execFileSync,
		spawn: childProcessSpies.spawn as unknown as typeof actual.spawn,
		spawnSync: childProcessSpies.spawnSync as unknown as typeof actual.spawnSync,
	};
});

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;

function createInPlaceWorkspaceApi(): WorkspaceApi {
	return createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(async () => {
			throw new Error("terminal manager must not be used in In-Place Mode");
		}),
		getScopedClineTaskSessionService: vi.fn(async () => {
			throw new Error("cline session service must not be used in In-Place Mode");
		}),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		// Effective_Worktree_Setting = false selects the In-Place branch for every call.
		loadEffectiveWorktreesEnabled: async () => false,
	});
}

function expectNoGitProcessSpawned(): void {
	expect(childProcessSpies.execFile).not.toHaveBeenCalled();
	expect(childProcessSpies.execFileSync).not.toHaveBeenCalled();
	expect(childProcessSpies.spawn).not.toHaveBeenCalled();
	expect(childProcessSpies.spawnSync).not.toHaveBeenCalled();
}

describe("createWorkspaceApi In-Place Mode on a non-git folder", () => {
	let project: TempProject;
	let projectPath: string;
	let api: WorkspaceApi;
	let scope: { workspaceId: string; workspacePath: string };

	beforeEach(() => {
		childProcessSpies.execFile.mockClear();
		childProcessSpies.execFileSync.mockClear();
		childProcessSpies.spawn.mockClear();
		childProcessSpies.spawnSync.mockClear();

		project = createTempProject({ git: false });
		projectPath = project.path;
		api = createInPlaceWorkspaceApi();
		scope = { workspaceId: "workspace-1", workspacePath: projectPath };
	});

	afterEach(() => {
		project.cleanup();
	});

	// Requirement 5.2 — ensureWorktree
	it("ensureWorktree reports the project folder with the requested baseRef and no commit (5.2, 5.8)", async () => {
		const response = await api.ensureWorktree(scope, { taskId: "task-1", baseRef: "feature-x" });

		expect(runtimeWorktreeEnsureResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		if (!response.ok) {
			throw new Error("expected ensureWorktree to succeed");
		}
		expect(response.path).toBe(projectPath);
		expect(response.baseRef).toBe("feature-x");
		expect(response.baseCommit).toBeNull();
		expectNoGitProcessSpawned();
	});

	// Requirement 5.3 — deleteWorktree
	it("deleteWorktree succeeds without removing anything (5.3, 5.8)", async () => {
		const response = await api.deleteWorktree(scope, { taskId: "task-1" });

		expect(runtimeWorktreeDeleteResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.removed).toBe(false);
		expect(response.error).toBeUndefined();
		expectNoGitProcessSpawned();
	});

	// Requirement 5.4 — getTaskContext (loadTaskContext)
	it("loadTaskContext reports the project folder as a present, git-free workspace (5.4, 5.8)", async () => {
		const response = await api.loadTaskContext(scope, { taskId: "task-1", baseRef: "feature-x" });

		expect(runtimeTaskWorkspaceInfoResponseSchema.parse(response)).toEqual(response);
		expect(response.taskId).toBe("task-1");
		expect(response.path).toBe(projectPath);
		expect(response.exists).toBe(true);
		expect(response.baseRef).toBe("feature-x");
		expect(response.branch).toBeNull();
		expect(response.isDetached).toBe(false);
		expect(response.headCommit).toBeNull();
		expectNoGitProcessSpawned();
	});

	// Requirement 5.5 — Diff endpoints (loadChanges / loadWorkspaceChanges)
	it("loadChanges returns an empty diff rooted at the project folder (5.5, 5.8)", async () => {
		const before = Date.now();
		const response = await api.loadChanges(scope, { taskId: "task-1", baseRef: "feature-x", mode: "working_copy" });
		const after = Date.now();

		expect(runtimeWorkspaceChangesResponseSchema.parse(response)).toEqual(response);
		expect(response.repoRoot).toBe(projectPath);
		expect(response.files).toEqual([]);
		expect(response.generatedAt).toBeGreaterThanOrEqual(before);
		expect(response.generatedAt).toBeLessThanOrEqual(after);
		expectNoGitProcessSpawned();
	});

	it("loadWorkspaceChanges returns an empty diff rooted at the project folder (5.5, 5.8)", async () => {
		const before = Date.now();
		const response = await api.loadWorkspaceChanges(scope);
		const after = Date.now();

		expect(runtimeWorkspaceChangesResponseSchema.parse(response)).toEqual(response);
		expect(response.repoRoot).toBe(projectPath);
		expect(response.files).toEqual([]);
		expect(response.generatedAt).toBeGreaterThanOrEqual(before);
		expect(response.generatedAt).toBeLessThanOrEqual(after);
		expectNoGitProcessSpawned();
	});

	// Requirement 5.6 — Git endpoints: ok:true, no error, empty lists, zero counts,
	// null nullables, required strings echoed or "".
	it("loadGitSummary returns an empty, successful summary (5.6, 5.8)", async () => {
		const response = await api.loadGitSummary(scope, null);

		expect(runtimeGitSummaryResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.summary).toEqual({
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		});
		expectNoGitProcessSpawned();
	});

	it("runGitSyncAction echoes the action and returns empty output (5.6, 5.8)", async () => {
		const response = await api.runGitSyncAction(scope, { action: "pull" });

		expect(runtimeGitSyncResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.action).toBe("pull");
		expect(response.output).toBe("");
		expect(response.summary.changedFiles).toBe(0);
		expect(response.summary.currentBranch).toBeNull();
		expectNoGitProcessSpawned();
	});

	it("checkoutGitBranch echoes the requested branch and returns empty output (5.6, 5.8)", async () => {
		const response = await api.checkoutGitBranch(scope, { branch: "feature-x" });

		expect(runtimeGitCheckoutResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.branch).toBe("feature-x");
		expect(response.output).toBe("");
		expectNoGitProcessSpawned();
	});

	it("loadGitLog returns an empty commit list (5.6, 5.8)", async () => {
		const response = await api.loadGitLog(scope, { maxCount: 50, skip: 0 });

		expect(runtimeGitLogResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.commits).toEqual([]);
		expect(response.totalCount).toBe(0);
		expectNoGitProcessSpawned();
	});

	it("loadGitRefs returns an empty refs list (5.6, 5.8)", async () => {
		const response = await api.loadGitRefs(scope, null);

		expect(runtimeGitRefsResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.refs).toEqual([]);
		expectNoGitProcessSpawned();
	});

	it("loadCommitDiff echoes the commit hash and returns no files (5.6, 5.8)", async () => {
		const response = await api.loadCommitDiff(scope, { commitHash: "abc1234" });

		expect(runtimeGitCommitDiffResponseSchema.parse(response)).toEqual(response);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.commitHash).toBe("abc1234");
		expect(response.files).toEqual([]);
		expectNoGitProcessSpawned();
	});

	// Coverage check: a Worktree endpoint, a Diff endpoint, and a Git endpoint
	// called back to back on the same non-git folder spawn no git process.
	it("Worktree, Diff, and Git endpoint calls together spawn no git process (15.5, 15.6)", async () => {
		const ensure = await api.ensureWorktree(scope, { taskId: "task-1", baseRef: "feature-x" });
		const changes = await api.loadWorkspaceChanges(scope);
		const summary = await api.loadGitSummary(scope, null);

		expect(ensure.ok).toBe(true);
		expect(changes.repoRoot).toBe(projectPath);
		expect(summary.ok).toBe(true);
		expectNoGitProcessSpawned();
	});
});
