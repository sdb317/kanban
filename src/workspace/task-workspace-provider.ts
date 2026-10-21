import { loadEffectiveWorktreesEnabled } from "../config/effective-worktree-mode.js";
import type {
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract.js";
import { createInPlaceTaskWorkspace } from "./in-place-task-workspace.js";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	resolveTaskCwd,
} from "./task-worktree.js";

/**
 * Effective workspace mode for a project. `"worktree"` runs today's worktree
 * code paths unchanged; `"in_place"` runs every task agent and task shell with
 * the project folder as its cwd (Req 12.2, 13.1).
 */
export type WorkspaceMode = "in_place" | "worktree";

/**
 * Uniform task-workspace surface shared by both modes. The runtime resolves one
 * of these per scope and forwards every task start, shell start, ensure,
 * delete, and info call through it, so the mode decision lives in exactly one
 * place (Req 3.1, 12.2, 12.5, 12.6).
 */
export interface TaskWorkspaceProvider {
	readonly mode: WorkspaceMode;
	/**
	 * Resolves the cwd for a task agent or task shell. When `ensure` is true the
	 * Worktree implementation tries the existing worktree first and falls back to
	 * creating one; when `ensure` is false it only resolves an existing worktree
	 * (Req 3.1, 12.3, 13.1).
	 */
	resolveTaskCwd(input: { taskId: string; baseRef: string; ensure: boolean }): Promise<string>;
	ensureTaskWorkspace(input: { taskId: string; baseRef: string }): Promise<RuntimeWorktreeEnsureResponse>;
	deleteTaskWorkspace(input: { taskId: string }): Promise<RuntimeWorktreeDeleteResponse>;
	getTaskWorkspaceInfo(input: { taskId: string; baseRef: string }): Promise<RuntimeTaskWorkspaceInfoResponse>;
}

/**
 * Worktree-mode provider. Forwards every call to the existing helpers in
 * `task-worktree.ts` with no behavior change. `resolveTaskCwd` hosts the
 * existing-or-ensure logic that previously lived in `runtime-api.ts`
 * (`resolveExistingTaskCwdOrEnsure`), copied verbatim: it tries the existing
 * worktree and, on throw, falls back to ensuring one (Req 13.1, 13.2, 13.7).
 */
function createWorktreeTaskWorkspaceProvider(projectPath: string): TaskWorkspaceProvider {
	return {
		mode: "worktree",
		async resolveTaskCwd(input) {
			if (!input.ensure) {
				return await resolveTaskCwd({
					cwd: projectPath,
					taskId: input.taskId,
					baseRef: input.baseRef,
					ensure: false,
				});
			}
			try {
				return await resolveTaskCwd({
					cwd: projectPath,
					taskId: input.taskId,
					baseRef: input.baseRef,
					ensure: false,
				});
			} catch {
				return await resolveTaskCwd({
					cwd: projectPath,
					taskId: input.taskId,
					baseRef: input.baseRef,
					ensure: true,
				});
			}
		},
		async ensureTaskWorkspace(input) {
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: projectPath,
				taskId: input.taskId,
				baseRef: input.baseRef,
			});
		},
		async deleteTaskWorkspace(input) {
			return await deleteTaskWorktree({
				repoPath: projectPath,
				taskId: input.taskId,
			});
		},
		async getTaskWorkspaceInfo(input) {
			return await getTaskWorkspaceInfo({
				cwd: projectPath,
				taskId: input.taskId,
				baseRef: input.baseRef,
			});
		},
	};
}

/**
 * In-Place-mode provider. Wraps the git-free `in-place-task-workspace.ts`
 * implementation, which runs no git, writes no files, and always resolves to
 * the project folder (Req 12.2).
 */
function createInPlaceTaskWorkspaceProvider(projectPath: string): TaskWorkspaceProvider {
	const inPlace = createInPlaceTaskWorkspace(projectPath);
	return {
		mode: "in_place",
		resolveTaskCwd: inPlace.resolveTaskCwd,
		ensureTaskWorkspace: inPlace.ensureTaskWorkspace,
		deleteTaskWorkspace: inPlace.deleteTaskWorkspace,
		getTaskWorkspaceInfo: inPlace.getTaskWorkspaceInfo,
	};
}

/**
 * Builds the task workspace provider for a project from an already-resolved
 * effective setting. Callers that have already loaded the mode use this to
 * avoid re-reading config.
 */
export function createTaskWorkspaceProvider(projectPath: string, worktreesEnabled: boolean): TaskWorkspaceProvider {
	return worktreesEnabled
		? createWorktreeTaskWorkspaceProvider(projectPath)
		: createInPlaceTaskWorkspaceProvider(projectPath);
}

/**
 * Resolves the effective worktree setting for a project (project override ->
 * global -> default false) and returns the matching provider.
 */
export async function resolveTaskWorkspaceProvider(projectPath: string): Promise<TaskWorkspaceProvider> {
	return createTaskWorkspaceProvider(projectPath, await loadEffectiveWorktreesEnabled(projectPath));
}
