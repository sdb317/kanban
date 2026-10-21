import * as childProcess from "node:child_process";
import { mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkspaceContext, loadWorkspaceScopeById } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";
import { withTempKanbanHome } from "../../utilities/temp-kanban-home";

// Wrap the real `node:child_process` module so `spawnSync` keeps working for
// legitimate git detection while we can assert whether it was ever invoked
// for the `git` binary during a given call.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(actual.spawnSync),
	};
});

const spawnSyncSpy = vi.mocked(childProcess.spawnSync);

function countGitSpawns(): number {
	return spawnSyncSpy.mock.calls.filter(([command]) => command === "git").length;
}

describe.sequential("workspace-state git-free identity", () => {
	let kanbanHome: ReturnType<typeof withTempKanbanHome>;
	let projectDir: ReturnType<typeof createTempDir>;

	beforeEach(() => {
		kanbanHome = withTempKanbanHome("kanban-non-git-home-");
		projectDir = createTempDir("kanban-non-git-project-");
	});

	afterEach(() => {
		projectDir.cleanup();
		kanbanHome.cleanup();
		spawnSyncSpy.mockClear();
	});

	it("resolves a non-git folder to its canonical realpath with empty git info", async () => {
		const context = await loadWorkspaceContext(projectDir.path);

		// Temp dirs can be symlinked (e.g. macOS /var -> /private/var), so the
		// expected repoPath is the canonical realpath of the folder.
		const expectedRepoPath = await realpath(projectDir.path);
		expect(context.repoPath).toBe(expectedRepoPath);

		expect(context.git).toEqual({
			currentBranch: null,
			defaultBranch: null,
			branches: [],
		});
	});

	it("loadWorkspaceScopeById returns the entry without spawning git", async () => {
		const context = await loadWorkspaceContext(projectDir.path);

		spawnSyncSpy.mockClear();

		const scope = await loadWorkspaceScopeById(context.workspaceId);

		expect(scope).toEqual({
			workspaceId: context.workspaceId,
			repoPath: context.repoPath,
		});
		expect(countGitSpawns()).toBe(0);
	});

	it("loadWorkspaceScopeById returns null for an unknown id without spawning git", async () => {
		spawnSyncSpy.mockClear();

		const scope = await loadWorkspaceScopeById("does-not-exist");

		expect(scope).toBeNull();
		expect(countGitSpawns()).toBe(0);
	});

	it("resolves a nested non-git folder created under the project", async () => {
		const nested = join(projectDir.path, "nested", "deep");
		mkdirSync(nested, { recursive: true });

		const context = await loadWorkspaceContext(nested);

		const expectedRepoPath = await realpath(nested);
		expect(context.repoPath).toBe(expectedRepoPath);
		expect(context.git.branches).toEqual([]);
	});
});
