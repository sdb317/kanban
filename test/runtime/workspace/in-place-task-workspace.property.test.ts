import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createInPlaceTaskWorkspace,
	ProjectFolderUnavailableError,
} from "../../../src/workspace/in-place-task-workspace";
import { createTempDir } from "../../utilities/temp-dir";

/**
 * Property 8: In-Place task cwd is always the project folder.
 * Validates: Requirements 3.1, 3.7, 3.9, 12.3
 *
 * For an In-Place task workspace bound to an existing project folder, every
 * entry point that reports a cwd — `resolveTaskCwd`, `ensureTaskWorkspace().path`,
 * and `getTaskWorkspaceInfo().path` — returns the project folder path for ALL
 * task ids and ALL base refs, including `""`, whitespace-only strings, and
 * strings that name branches which do not exist, and regardless of whether a
 * worktree-style folder already exists on disk. No git process is ever spawned
 * because the module performs no git work (Req 3.1, 3.7, 12.3).
 *
 * A concrete example also asserts that pointing the workspace at a missing path
 * (and at a file rather than a directory) rejects with
 * `ProjectFolderUnavailableError` whose message is exactly
 * `Project folder is unavailable: <path>` (Req 3.9).
 */

/**
 * Intercept `node:child_process` so that any attempt to spawn a process (which
 * is how the Worktree-mode helpers run git) is observable. The In-Place module
 * does no git, so these must never be called.
 */
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
	exec: vi.fn(),
	execSync: vi.fn(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

const childProcessMocks = [spawn, spawnSync, exec, execSync, execFile, execFileSync] as unknown as Array<{
	mock: { calls: unknown[] };
}>;

function expectNoChildProcessSpawned(): void {
	for (const mocked of childProcessMocks) {
		expect(mocked.mock.calls).toHaveLength(0);
	}
}

/**
 * Base refs spanning the cases the In-Place resolver must tolerate without any
 * branch validation: empty, whitespace-only, and names of branches that do not
 * exist, plus a few ordinary branch-like strings.
 */
const baseRefArbitrary: fc.Arbitrary<string> = fc.oneof(
	fc.constant(""),
	fc.constantFrom(" ", "   ", "\t", "\n", " \t "),
	fc.constantFrom("does-not-exist", "feature/ghost", "refs/heads/missing", "origin/nope"),
	fc.string(),
);

describe("in-place task workspace cwd", () => {
	const dirs: Array<{ cleanup: () => void }> = [];

	afterEach(() => {
		vi.clearAllMocks();
		while (dirs.length > 0) {
			dirs.pop()?.cleanup();
		}
	});

	// Property 8: In-Place task cwd is always the project folder.
	// Validates: Requirements 3.1, 3.7, 3.9, 12.3
	it("returns the project folder for every task id and base ref and spawns no git process", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.string({ minLength: 1 }),
				baseRefArbitrary,
				fc.boolean(),
				fc.boolean(),
				async (taskId, baseRef, ensure, preexistingWorktreeFolder) => {
					const project = createTempDir("kanban-inplace-project-");
					dirs.push(project);

					// Optionally create a worktree-style folder on disk to prove the
					// In-Place resolver ignores it and never consults a worktree.
					if (preexistingWorktreeFolder) {
						const worktreeDir = join(project.path, ".worktrees", "pre-existing");
						mkdirSync(worktreeDir, { recursive: true });
						writeFileSync(join(worktreeDir, "marker"), "x", "utf8");
					}

					const workspace = createInPlaceTaskWorkspace(project.path);

					const resolved = await workspace.resolveTaskCwd({ taskId, baseRef, ensure });
					const ensured = await workspace.ensureTaskWorkspace({ taskId, baseRef });
					const info = await workspace.getTaskWorkspaceInfo({ taskId, baseRef });

					expect(resolved).toBe(project.path);
					expect(ensured.ok).toBe(true);
					expect(ensured.path).toBe(project.path);
					expect(info.path).toBe(project.path);

					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 200 },
		);
	});

	// Example: a missing project folder rejects with ProjectFolderUnavailableError.
	// Validates: Requirement 3.9
	it("rejects with ProjectFolderUnavailableError for a missing project path", async () => {
		const parent = createTempDir("kanban-inplace-missing-");
		dirs.push(parent);
		const missingPath = join(parent.path, "nonexistent-project");

		const workspace = createInPlaceTaskWorkspace(missingPath);

		await expect(workspace.resolveTaskCwd({ taskId: "t1", baseRef: "", ensure: true })).rejects.toThrow(
			ProjectFolderUnavailableError,
		);
		await expect(workspace.resolveTaskCwd({ taskId: "t1", baseRef: "", ensure: true })).rejects.toThrow(
			`Project folder is unavailable: ${missingPath}`,
		);
		expectNoChildProcessSpawned();
	});

	// Example: a path that is a file (not a directory) also rejects.
	// Validates: Requirement 3.9
	it("rejects with ProjectFolderUnavailableError when the path is a file, not a directory", async () => {
		const parent = createTempDir("kanban-inplace-file-");
		dirs.push(parent);
		const filePath = join(parent.path, "project-file");
		writeFileSync(filePath, "not a directory", "utf8");

		const workspace = createInPlaceTaskWorkspace(filePath);

		await expect(workspace.resolveTaskCwd({ taskId: "t1", baseRef: "main", ensure: false })).rejects.toThrow(
			new ProjectFolderUnavailableError(filePath),
		);
		expectNoChildProcessSpawned();
	});
});
