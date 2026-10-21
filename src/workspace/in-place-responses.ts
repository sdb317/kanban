import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
	RuntimeWorkspaceChangesResponse,
} from "../core/api-contract.js";

/**
 * Pure response builders for In-Place Mode (Effective_Worktree_Setting = false).
 *
 * Every builder returns a well-formed success response that matches its procedure's
 * response schema: `ok: true`, no `error` field, empty lists, zero counts, null
 * nullables, `output: ""` where required, and required strings echoed from the
 * request argument or `""`. None of these touch git or the filesystem, so they are
 * safe no-ops for projects that are not git repositories (Req 5.5, 5.6, 5.7, 9.7).
 *
 * These are deliberately separate from `createEmptyWorkspaceChangesResponse`, which
 * runs `git rev-parse` to resolve the repo root.
 */

/** An empty git summary: null branches, zero counts (Req 5.6). */
export function createInPlaceGitSyncSummary(): RuntimeGitSyncSummary {
	return {
		currentBranch: null,
		upstreamBranch: null,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

export function createInPlaceGitSummaryResponse(): RuntimeGitSummaryResponse {
	return {
		ok: true,
		summary: createInPlaceGitSyncSummary(),
	};
}

export function createInPlaceGitSyncResponse(action: RuntimeGitSyncAction): RuntimeGitSyncResponse {
	return {
		ok: true,
		action,
		summary: createInPlaceGitSyncSummary(),
		output: "",
	};
}

export function createInPlaceGitCheckoutResponse(branch: string): RuntimeGitCheckoutResponse {
	return {
		ok: true,
		branch,
		summary: createInPlaceGitSyncSummary(),
		output: "",
	};
}

export function createInPlaceGitDiscardResponse(): RuntimeGitDiscardResponse {
	return {
		ok: true,
		summary: createInPlaceGitSyncSummary(),
		output: "",
	};
}

export function createInPlaceGitLogResponse(): RuntimeGitLogResponse {
	return {
		ok: true,
		commits: [],
		totalCount: 0,
	};
}

export function createInPlaceGitRefsResponse(): RuntimeGitRefsResponse {
	return {
		ok: true,
		refs: [],
	};
}

export function createInPlaceCommitDiffResponse(commitHash: string): RuntimeGitCommitDiffResponse {
	return {
		ok: true,
		commitHash,
		files: [],
	};
}

export function createInPlaceWorkspaceChangesResponse(
	projectPath: string,
	now: () => number,
): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: projectPath,
		generatedAt: now(),
		files: [],
	};
}
