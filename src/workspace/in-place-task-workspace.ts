import { stat } from "node:fs/promises";

import type {
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract.js";

/**
 * Thrown when an In-Place task session is started but the project folder is
 * missing or is not a directory. The message is exactly
 * `Project folder is unavailable: <path>` so callers can surface it verbatim
 * (Req 3.9).
 */
export class ProjectFolderUnavailableError extends Error {
	constructor(projectPath: string) {
		super(`Project folder is unavailable: ${projectPath}`);
		this.name = "ProjectFolderUnavailableError";
	}
}

/**
 * In-Place task workspace (Effective_Worktree_Setting = false).
 *
 * Every task agent and task shell runs with the project folder itself as its
 * cwd. These functions run no git, write no files, and never read
 * `~/.cline/worktrees`. They mirror the signatures of the Worktree-mode helpers
 * in `task-worktree.ts` (`resolveTaskCwd`, `ensureTaskWorktreeIfDoesntExist`,
 * `deleteTaskWorktree`, `getTaskWorkspaceInfo`) so the task workspace provider
 * can forward to either implementation uniformly (Req 12.3).
 */
export interface InPlaceTaskWorkspace {
	/**
	 * Resolves the task cwd. Confirms the project folder exists and is a
	 * directory, then returns the project path. The `baseRef` and `ensure`
	 * inputs are accepted to match the provider contract but are ignored, since
	 * In-Place Mode never creates or looks up a worktree (Req 3.1, 3.4, 3.5,
	 * 3.7, 3.8, 12.3).
	 *
	 * @throws {ProjectFolderUnavailableError} when the project path is missing or
	 * is not a directory (Req 3.9).
	 */
	resolveTaskCwd(input: { taskId: string; baseRef: string; ensure: boolean }): Promise<string>;
	/** Pure no-op "ensure" that reports the project folder as the workspace (Req 5.2). */
	ensureTaskWorkspace(input: { taskId: string; baseRef: string }): Promise<RuntimeWorktreeEnsureResponse>;
	/** Pure no-op "delete": there is never a worktree to remove (Req 5.3, 12.4). */
	deleteTaskWorkspace(input: { taskId: string }): Promise<RuntimeWorktreeDeleteResponse>;
	/** Reports the project folder as an always-present, git-free workspace (Req 5.4). */
	getTaskWorkspaceInfo(input: { taskId: string; baseRef: string }): Promise<RuntimeTaskWorkspaceInfoResponse>;
}

async function assertProjectFolderAvailable(projectPath: string): Promise<void> {
	try {
		const stats = await stat(projectPath);
		if (!stats.isDirectory()) {
			throw new ProjectFolderUnavailableError(projectPath);
		}
	} catch (error) {
		if (error instanceof ProjectFolderUnavailableError) {
			throw error;
		}
		throw new ProjectFolderUnavailableError(projectPath);
	}
}

/**
 * Creates the In-Place task workspace bound to a single project folder. The
 * provider (`task-workspace-provider.ts`) constructs one of these per scope and
 * forwards every call to it in In-Place Mode.
 */
export function createInPlaceTaskWorkspace(projectPath: string): InPlaceTaskWorkspace {
	return {
		async resolveTaskCwd() {
			await assertProjectFolderAvailable(projectPath);
			return projectPath;
		},
		async ensureTaskWorkspace(input) {
			return {
				ok: true,
				path: projectPath,
				baseRef: input.baseRef,
				baseCommit: null,
			};
		},
		async deleteTaskWorkspace() {
			return {
				ok: true,
				removed: false,
			};
		},
		async getTaskWorkspaceInfo(input) {
			return {
				taskId: input.taskId,
				path: projectPath,
				exists: true,
				baseRef: input.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
			};
		},
	};
}
