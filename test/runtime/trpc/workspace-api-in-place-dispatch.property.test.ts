import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../../src/core/api-contract";

/**
 * Property 10: Mode is chosen per call.
 * Validates: Requirements 5.9, 5.11
 *
 * `createWorkspaceApi` resolves the effective worktree setting through the
 * injected `loadEffectiveWorktreesEnabled` on every endpoint call and never
 * caches the result. Given a random boolean sequence consumed one value per
 * endpoint call, each call must route to the mode that was effective *for that
 * call*: `false` runs the pure In-Place builder (recognizable by its
 * fully-specified no-op response shape and the Worktree helpers staying
 * untouched), and `true` runs today's Worktree branch (recognizable by the
 * mocked git/worktree helper being invoked). The dispatcher must also consult
 * `loadEffectiveWorktreesEnabled` exactly once per call (Req 5.9, 5.11).
 */

// Observable, git-free stand-ins for the Worktree-branch helpers. Each returns
// a tagged response so a Worktree-branch result is unambiguously distinguishable
// from the pure In-Place builder output.
const worktreeMocks = vi.hoisted(() => ({
	getGitSyncSummary: vi.fn(),
	runGitSyncAction: vi.fn(),
	runGitCheckoutAction: vi.fn(),
	discardGitChanges: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getGitLog: vi.fn(),
	getGitRefs: vi.fn(),
	getCommitDiff: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	deleteTaskWorktree: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: vi.fn(),
}));

vi.mock("../../../src/workspace/git-sync.js", () => ({
	getGitSyncSummary: worktreeMocks.getGitSyncSummary,
	runGitSyncAction: worktreeMocks.runGitSyncAction,
	runGitCheckoutAction: worktreeMocks.runGitCheckoutAction,
	discardGitChanges: worktreeMocks.discardGitChanges,
}));

vi.mock("../../../src/workspace/git-history.js", () => ({
	getGitLog: worktreeMocks.getGitLog,
	getGitRefs: worktreeMocks.getGitRefs,
	getCommitDiff: worktreeMocks.getCommitDiff,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: worktreeMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: worktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: worktreeMocks.ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo: worktreeMocks.getTaskWorkspaceInfo,
	resolveTaskCwd: worktreeMocks.resolveTaskCwd,
}));

import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

const WORKTREE_SUMMARY: RuntimeGitSyncSummary = {
	currentBranch: "feature/worktree",
	upstreamBranch: "origin/feature/worktree",
	changedFiles: 3,
	additions: 42,
	deletions: 7,
	aheadCount: 1,
	behindCount: 2,
};

const SCOPE: RuntimeTrpcWorkspaceScope = {
	workspaceId: "workspace-1",
	workspacePath: "/tmp/project",
};

function resetWorktreeMocks(): void {
	for (const mock of Object.values(worktreeMocks)) {
		mock.mockReset();
	}
	// Non-empty, tagged return values so a Worktree-branch result never looks
	// like the empty In-Place no-op response.
	worktreeMocks.getGitSyncSummary.mockResolvedValue(WORKTREE_SUMMARY);
	worktreeMocks.runGitSyncAction.mockResolvedValue({
		ok: true,
		action: "pull",
		summary: WORKTREE_SUMMARY,
		output: "worktree-pull",
	} satisfies RuntimeGitSyncResponse);
	worktreeMocks.runGitCheckoutAction.mockResolvedValue({
		ok: true,
		branch: "feature/worktree",
		summary: WORKTREE_SUMMARY,
		output: "worktree-checkout",
	} satisfies RuntimeGitCheckoutResponse);
	worktreeMocks.discardGitChanges.mockResolvedValue({
		ok: true,
		summary: WORKTREE_SUMMARY,
		output: "worktree-discard",
	} satisfies RuntimeGitDiscardResponse);
	worktreeMocks.getWorkspaceChanges.mockResolvedValue({
		repoRoot: "/tmp/project/.worktrees/task-1",
		generatedAt: 123,
		files: [
			{
				path: "a.txt",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "old",
				newText: "new",
			},
		],
	} satisfies RuntimeWorkspaceChangesResponse);
	worktreeMocks.getGitLog.mockResolvedValue({
		ok: true,
		commits: [
			{
				hash: "abc1234",
				shortHash: "abc1234",
				authorName: "Dev",
				authorEmail: "dev@example.com",
				date: "2024-01-01",
				message: "worktree commit",
				parentHashes: [],
			},
		],
		totalCount: 1,
	} satisfies RuntimeGitLogResponse);
	worktreeMocks.getGitRefs.mockResolvedValue({
		ok: true,
		refs: [{ name: "feature/worktree", type: "branch", hash: "abc1234", isHead: true }],
	} satisfies RuntimeGitRefsResponse);
	worktreeMocks.getCommitDiff.mockResolvedValue({
		ok: true,
		commitHash: "abc1234",
		files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 0, patch: "@@" }],
	} satisfies RuntimeGitCommitDiffResponse);
	worktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
		ok: true,
		path: "/tmp/project/.worktrees/task-1",
		baseRef: "main",
		baseCommit: "deadbeef",
	} satisfies RuntimeWorktreeEnsureResponse);
	worktreeMocks.deleteTaskWorktree.mockResolvedValue({
		ok: true,
		removed: true,
	} satisfies RuntimeWorktreeDeleteResponse);
	worktreeMocks.getTaskWorkspaceInfo.mockResolvedValue({
		taskId: "task-1",
		path: "/tmp/project/.worktrees/task-1",
		exists: true,
		baseRef: "main",
		branch: "task/task-1",
		isDetached: false,
		headCommit: "deadbeef",
	} satisfies RuntimeTaskWorkspaceInfoResponse);
	worktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/project/.worktrees/task-1");
}

/**
 * Builds the workspace API with a `loadEffectiveWorktreesEnabled` stub driven by
 * a fixed boolean sequence: the Nth call returns `sequence[N]`. Tracks how many
 * times the stub ran so the test can assert exactly one resolution per endpoint
 * call. The Worktree-branch collaborators are stubbed (unused by In-Place) and
 * never touch git.
 */
function createApiForSequence(sequence: boolean[]): {
	api: RuntimeTrpcContext["workspaceApi"];
	loadCalls: () => number;
} {
	let index = 0;
	const loadEffectiveWorktreesEnabled = vi.fn(async () => {
		const value = sequence[index] ?? false;
		index += 1;
		return value;
	});
	const api = createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		loadEffectiveWorktreesEnabled,
	});
	return { api, loadCalls: () => loadEffectiveWorktreesEnabled.mock.calls.length };
}

/**
 * Each entry is one mode-dispatched endpoint. `invoke` runs it; `expectInPlace`
 * asserts the pure In-Place no-op shape and that no Worktree helper was called;
 * `expectWorktree` asserts the Worktree helper ran and its tagged result flowed
 * through. Every entry consumes exactly one value from the boolean sequence.
 */
interface Endpoint {
	name: string;
	invoke: (api: RuntimeTrpcContext["workspaceApi"]) => Promise<unknown>;
	worktreeMock: { mock: { calls: unknown[] } };
	expectInPlace: (result: unknown) => void;
	expectWorktree: (result: unknown) => void;
}

const ENDPOINTS: Endpoint[] = [
	{
		name: "loadGitSummary",
		invoke: (api) => api.loadGitSummary(SCOPE, null),
		worktreeMock: worktreeMocks.getGitSyncSummary,
		expectInPlace: (result) => {
			const response = result as RuntimeGitSummaryResponse;
			expect(response.ok).toBe(true);
			expect(response.summary).toEqual({
				currentBranch: null,
				upstreamBranch: null,
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			});
			expect("error" in response).toBe(false);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitSummaryResponse;
			expect(response.ok).toBe(true);
			expect(response.summary).toEqual(WORKTREE_SUMMARY);
		},
	},
	{
		name: "runGitSyncAction",
		invoke: (api) => api.runGitSyncAction(SCOPE, { action: "pull" }),
		worktreeMock: worktreeMocks.runGitSyncAction,
		expectInPlace: (result) => {
			const response = result as RuntimeGitSyncResponse;
			expect(response.ok).toBe(true);
			expect(response.action).toBe("pull");
			expect(response.output).toBe("");
			expect(response.summary.changedFiles).toBe(0);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitSyncResponse;
			expect(response.output).toBe("worktree-pull");
		},
	},
	{
		name: "checkoutGitBranch",
		invoke: (api) => api.checkoutGitBranch(SCOPE, { branch: "main" }),
		worktreeMock: worktreeMocks.runGitCheckoutAction,
		expectInPlace: (result) => {
			const response = result as RuntimeGitCheckoutResponse;
			expect(response.ok).toBe(true);
			expect(response.branch).toBe("main");
			expect(response.output).toBe("");
			expect(response.summary.changedFiles).toBe(0);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitCheckoutResponse;
			expect(response.output).toBe("worktree-checkout");
		},
	},
	{
		name: "discardGitChanges",
		invoke: (api) => api.discardGitChanges(SCOPE, null),
		worktreeMock: worktreeMocks.discardGitChanges,
		expectInPlace: (result) => {
			const response = result as RuntimeGitDiscardResponse;
			expect(response.ok).toBe(true);
			expect(response.output).toBe("");
			expect(response.summary.changedFiles).toBe(0);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitDiscardResponse;
			expect(response.output).toBe("worktree-discard");
		},
	},
	{
		name: "loadWorkspaceChanges",
		invoke: (api) => api.loadWorkspaceChanges(SCOPE),
		worktreeMock: worktreeMocks.getWorkspaceChanges,
		expectInPlace: (result) => {
			const response = result as RuntimeWorkspaceChangesResponse;
			expect(response.repoRoot).toBe(SCOPE.workspacePath);
			expect(response.files).toEqual([]);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeWorkspaceChangesResponse;
			expect(response.repoRoot).toBe("/tmp/project/.worktrees/task-1");
			expect(response.files).toHaveLength(1);
		},
	},
	{
		name: "loadGitLog",
		invoke: (api) => api.loadGitLog(SCOPE, { ref: null, maxCount: 20, skip: 0, taskScope: null }),
		worktreeMock: worktreeMocks.getGitLog,
		expectInPlace: (result) => {
			const response = result as RuntimeGitLogResponse;
			expect(response.ok).toBe(true);
			expect(response.commits).toEqual([]);
			expect(response.totalCount).toBe(0);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitLogResponse;
			expect(response.commits).toHaveLength(1);
		},
	},
	{
		name: "loadGitRefs",
		invoke: (api) => api.loadGitRefs(SCOPE, null),
		worktreeMock: worktreeMocks.getGitRefs,
		expectInPlace: (result) => {
			const response = result as RuntimeGitRefsResponse;
			expect(response.ok).toBe(true);
			expect(response.refs).toEqual([]);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitRefsResponse;
			expect(response.refs).toHaveLength(1);
		},
	},
	{
		name: "loadCommitDiff",
		invoke: (api) => api.loadCommitDiff(SCOPE, { commitHash: "abc1234", taskScope: null }),
		worktreeMock: worktreeMocks.getCommitDiff,
		expectInPlace: (result) => {
			const response = result as RuntimeGitCommitDiffResponse;
			expect(response.ok).toBe(true);
			expect(response.commitHash).toBe("abc1234");
			expect(response.files).toEqual([]);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeGitCommitDiffResponse;
			expect(response.files).toHaveLength(1);
		},
	},
	{
		name: "ensureWorktree",
		invoke: (api) => api.ensureWorktree(SCOPE, { taskId: "task-1", baseRef: "main" }),
		worktreeMock: worktreeMocks.ensureTaskWorktreeIfDoesntExist,
		expectInPlace: (result) => {
			const response = result as RuntimeWorktreeEnsureResponse;
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.path).toBe(SCOPE.workspacePath);
				expect(response.baseCommit).toBeNull();
			}
		},
		expectWorktree: (result) => {
			const response = result as RuntimeWorktreeEnsureResponse;
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.path).toBe("/tmp/project/.worktrees/task-1");
				expect(response.baseCommit).toBe("deadbeef");
			}
		},
	},
	{
		name: "deleteWorktree",
		invoke: (api) => api.deleteWorktree(SCOPE, { taskId: "task-1" }),
		worktreeMock: worktreeMocks.deleteTaskWorktree,
		expectInPlace: (result) => {
			const response = result as RuntimeWorktreeDeleteResponse;
			expect(response.ok).toBe(true);
			expect(response.removed).toBe(false);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeWorktreeDeleteResponse;
			expect(response.ok).toBe(true);
			expect(response.removed).toBe(true);
		},
	},
	{
		name: "loadTaskContext",
		invoke: (api) => api.loadTaskContext(SCOPE, { taskId: "task-1", baseRef: "main" }),
		worktreeMock: worktreeMocks.getTaskWorkspaceInfo,
		expectInPlace: (result) => {
			const response = result as RuntimeTaskWorkspaceInfoResponse;
			expect(response.path).toBe(SCOPE.workspacePath);
			expect(response.branch).toBeNull();
			expect(response.headCommit).toBeNull();
			expect(response.isDetached).toBe(false);
			expect(response.exists).toBe(true);
		},
		expectWorktree: (result) => {
			const response = result as RuntimeTaskWorkspaceInfoResponse;
			expect(response.path).toBe("/tmp/project/.worktrees/task-1");
			expect(response.branch).toBe("task/task-1");
		},
	},
];

describe("createWorkspaceApi per-call mode selection (Property 10)", () => {
	beforeEach(() => {
		resetWorktreeMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// Property 10: Mode is chosen per call.
	// Validates: Requirements 5.9, 5.11
	for (const endpoint of ENDPOINTS) {
		it(`routes ${endpoint.name} by the effective setting at the time of each call`, async () => {
			await fc.assert(
				fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }), async (sequence) => {
					resetWorktreeMocks();
					const { api, loadCalls } = createApiForSequence(sequence);

					for (let callIndex = 0; callIndex < sequence.length; callIndex += 1) {
						const callsBefore = endpoint.worktreeMock.mock.calls.length;
						const result = await endpoint.invoke(api);
						const callsAfter = endpoint.worktreeMock.mock.calls.length;
						const worktreeHelperRan = callsAfter > callsBefore;

						if (sequence[callIndex]) {
							// Worktree Mode: the git/worktree helper for this endpoint
							// must have run and produced its tagged result (Req 5.11).
							expect(worktreeHelperRan).toBe(true);
							endpoint.expectWorktree(result);
						} else {
							// In-Place Mode: the pure builder shape, and no Worktree
							// helper invoked for this call (Req 5.9).
							expect(worktreeHelperRan).toBe(false);
							endpoint.expectInPlace(result);
						}

						// The mode is resolved exactly once per endpoint call and never
						// cached across calls (Req 5.9).
						expect(loadCalls()).toBe(callIndex + 1);
					}
				}),
				{ numRuns: 60 },
			);
		});
	}
});
