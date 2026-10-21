import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import fc from "fast-check";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncResponseSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../../../src/core/api-contract";

/**
 * Property 9: In-Place endpoints are schema-valid, fully specified no-ops.
 * Validates: Requirements 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 9.7
 *
 * With `loadEffectiveWorktreesEnabled` resolving to `false`, every workspace
 * API endpoint that would normally touch git or a worktree instead runs its
 * In-Place branch. For every schema-valid input, each endpoint:
 *   - returns a response that parses against its response schema (Req 5.1),
 *   - reports the exact fully-specified field values required by Requirement 5
 *     (ok/path/baseRef/baseCommit/removed, diff `repoRoot`/`files`, and the
 *     empty git summary / zero counts / null nullables / echoed required
 *     strings),
 *   - spawns no git process and writes nothing to the filesystem, since the
 *     In-Place path never calls `runGit` / `node:child_process` and performs no
 *     filesystem writes (Req 5.7, 5.8, 9.7).
 */

// Mock the git runner used by every Worktree-mode code path. In In-Place Mode
// it must never be called; tripping this mock would reveal a leaked git call.
const gitUtilsMocks = vi.hoisted(() => ({
	runGit: vi.fn(async () => ({
		ok: true,
		stdout: "",
		stderr: "",
		output: "",
		error: null,
		exitCode: 0,
	})),
}));

vi.mock("../../../src/workspace/git-utils.js", () => ({
	runGit: gitUtilsMocks.runGit,
	getGitStdout: vi.fn(),
	readGitHeadInfo: vi.fn(),
	getGitCommandErrorMessage: vi.fn(),
}));

// Intercept every process-spawning entry point. The In-Place path does no git,
// so any spawn would be a bug.
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
	exec: vi.fn(),
	execSync: vi.fn(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

// Spy on the filesystem write surface by wrapping the real modules. In-Place
// endpoints are pure response builders / git-free provider calls and must never
// write to disk (Req 5.7, 5.8). Reads (e.g. `stat`) pass through to the real
// implementation.
const fsWriteMocks = vi.hoisted(() => ({
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
	writeFile: vi.fn(async () => undefined),
	mkdir: vi.fn(async () => undefined),
	rm: vi.fn(async () => undefined),
	rename: vi.fn(async () => undefined),
}));

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		writeFileSync: fsWriteMocks.writeFileSync,
		mkdirSync: fsWriteMocks.mkdirSync,
		rmSync: fsWriteMocks.rmSync,
	};
});

vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	return {
		...actual,
		default: actual,
		writeFile: fsWriteMocks.writeFile,
		mkdir: fsWriteMocks.mkdir,
		rm: fsWriteMocks.rm,
		rename: fsWriteMocks.rename,
	};
});

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

const childProcessMocks = [spawn, spawnSync, exec, execSync, execFile, execFileSync] as unknown as Array<{
	mock: { calls: unknown[] };
}>;

function expectNoChildProcessSpawned(): void {
	for (const mocked of childProcessMocks) {
		expect(mocked.mock.calls).toHaveLength(0);
	}
	expect(gitUtilsMocks.runGit).not.toHaveBeenCalled();
	for (const spy of Object.values(fsWriteMocks)) {
		expect(spy).not.toHaveBeenCalled();
	}
}

const WORKSPACE_PATH = "/tmp/in-place-project";

const scope = {
	workspaceId: "workspace-in-place",
	workspacePath: WORKSPACE_PATH,
} as const;

/**
 * Build the workspace API locked into In-Place Mode. The broadcast / snapshot /
 * manager dependencies are stubs that would throw if the In-Place branch ever
 * reached into Worktree-mode machinery.
 */
function createInPlaceApi(): ReturnType<typeof createWorkspaceApi> {
	return createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(async () => {
			throw new Error("terminal manager must not be used in In-Place Mode");
		}),
		getScopedClineTaskSessionService: vi.fn(async () => {
			throw new Error("cline task session service must not be used in In-Place Mode");
		}),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(() => {
			throw new Error("In-Place endpoints must not broadcast");
		}),
		broadcastRuntimeProjectsUpdated: vi.fn(() => {
			throw new Error("In-Place endpoints must not broadcast");
		}),
		buildWorkspaceStateSnapshot: vi.fn(),
		loadEffectiveWorktreesEnabled: async () => false,
	});
}

/** Non-empty, non-whitespace identifier (task ids, branch names, commit hashes). */
const nonBlankStringArbitrary: fc.Arbitrary<string> = fc
	.string({ minLength: 1 })
	.filter((value) => value.trim().length > 0);

/** Base ref including the empty string, which In-Place Mode must accept. */
const baseRefArbitrary: fc.Arbitrary<string> = fc.oneof(fc.constant(""), fc.string(), nonBlankStringArbitrary);

const syncActionArbitrary: fc.Arbitrary<"fetch" | "pull" | "push"> = fc.constantFrom("fetch", "pull", "push");

describe("workspace API In-Place endpoints are schema-valid no-ops", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Req 5.6: empty git summary with zero counts and null branches.
	it("loadGitSummary returns an ok, empty summary without git or writes", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(
				fc.option(fc.record({ taskId: nonBlankStringArbitrary, baseRef: nonBlankStringArbitrary }), {
					nil: null,
				}),
				async (input) => {
					const response = await api.loadGitSummary(scope, input);
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
					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: ok sync response echoing the requested action.
	it("runGitSyncAction echoes the action with an empty summary and output", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(syncActionArbitrary, async (action) => {
				const response = await api.runGitSyncAction(scope, { action });
				expect(runtimeGitSyncResponseSchema.parse(response)).toEqual(response);
				expect(response.ok).toBe(true);
				expect(response.error).toBeUndefined();
				expect(response.action).toBe(action);
				expect(response.output).toBe("");
				expect(response.summary.changedFiles).toBe(0);
				expect(response.summary.currentBranch).toBeNull();
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: checkout echoes the requested branch, empty summary/output.
	it("checkoutGitBranch echoes the requested branch", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(nonBlankStringArbitrary, async (branch) => {
				const response = await api.checkoutGitBranch(scope, { branch });
				expect(runtimeGitCheckoutResponseSchema.parse(response)).toEqual(response);
				expect(response.ok).toBe(true);
				expect(response.error).toBeUndefined();
				expect(response.branch).toBe(branch.trim());
				expect(response.output).toBe("");
				expect(response.summary.currentBranch).toBeNull();
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: discard is an ok no-op with an empty summary.
	it("discardGitChanges returns ok with an empty summary", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(
				fc.option(fc.record({ taskId: nonBlankStringArbitrary, baseRef: nonBlankStringArbitrary }), {
					nil: null,
				}),
				async (input) => {
					const response = await api.discardGitChanges(scope, input);
					expect(runtimeGitDiscardResponseSchema.parse(response)).toEqual(response);
					expect(response.ok).toBe(true);
					expect(response.error).toBeUndefined();
					expect(response.output).toBe("");
					expect(response.summary.changedFiles).toBe(0);
					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 100 },
		);
	});

	// Req 5.5: diff endpoints report repoRoot = projectPath, epoch-ms timestamp, no files.
	it("loadChanges reports the project path and no files", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(
				nonBlankStringArbitrary,
				nonBlankStringArbitrary,
				fc.constantFrom("working_copy", "last_turn"),
				async (taskId, baseRef, mode) => {
					const before = Date.now();
					const response = await api.loadChanges(scope, {
						taskId,
						baseRef,
						mode: mode as "working_copy" | "last_turn",
					});
					const after = Date.now();
					expect(runtimeWorkspaceChangesResponseSchema.parse(response)).toEqual(response);
					expect(response.repoRoot).toBe(WORKSPACE_PATH);
					expect(response.files).toEqual([]);
					expect(response.generatedAt).toBeGreaterThanOrEqual(before);
					expect(response.generatedAt).toBeLessThanOrEqual(after);
					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 100 },
		);
	});

	// Req 5.5: the workspace-level diff endpoint behaves identically.
	it("loadWorkspaceChanges reports the project path and no files", async () => {
		const api = createInPlaceApi();
		const before = Date.now();
		const response = await api.loadWorkspaceChanges(scope);
		const after = Date.now();
		expect(runtimeWorkspaceChangesResponseSchema.parse(response)).toEqual(response);
		expect(response.repoRoot).toBe(WORKSPACE_PATH);
		expect(response.files).toEqual([]);
		expect(response.generatedAt).toBeGreaterThanOrEqual(before);
		expect(response.generatedAt).toBeLessThanOrEqual(after);
		expectNoChildProcessSpawned();
	});

	// Req 5.2: ensure reports the project folder, echoed baseRef, null baseCommit.
	it("ensureWorktree reports the project folder and echoes the base ref", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(nonBlankStringArbitrary, baseRefArbitrary, async (taskId, baseRef) => {
				const response = await api.ensureWorktree(scope, { taskId, baseRef });
				expect(runtimeWorktreeEnsureResponseSchema.parse(response)).toEqual(response);
				expect(response.ok).toBe(true);
				if (response.ok) {
					expect(response.path).toBe(WORKSPACE_PATH);
					expect(response.baseRef).toBe(baseRef.trim());
					expect(response.baseCommit).toBeNull();
				}
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});

	// Req 5.3: delete is an ok no-op that removed nothing.
	it("deleteWorktree returns ok with removed=false", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(nonBlankStringArbitrary, async (taskId) => {
				const response = await api.deleteWorktree(scope, { taskId });
				expect(runtimeWorktreeDeleteResponseSchema.parse(response)).toEqual(response);
				expect(response.ok).toBe(true);
				expect(response.removed).toBe(false);
				expect(response.error).toBeUndefined();
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});

	// Req 5.4: task context reports an always-present, git-free project workspace.
	it("loadTaskContext reports the project folder as an existing git-free workspace", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(nonBlankStringArbitrary, baseRefArbitrary, async (taskId, baseRef) => {
				const response = await api.loadTaskContext(scope, { taskId, baseRef });
				expect(runtimeTaskWorkspaceInfoResponseSchema.parse(response)).toEqual(response);
				expect(response.taskId).toBe(taskId.trim());
				expect(response.path).toBe(WORKSPACE_PATH);
				expect(response.exists).toBe(true);
				expect(response.baseRef).toBe(baseRef.trim());
				expect(response.branch).toBeNull();
				expect(response.isDetached).toBe(false);
				expect(response.headCommit).toBeNull();
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: git log is ok, empty, zero total count.
	it("loadGitLog returns an empty log", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(
				fc.record(
					{
						ref: fc.option(nonBlankStringArbitrary, { nil: undefined }),
						maxCount: fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined }),
						skip: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
					},
					{ requiredKeys: [] },
				),
				async (input) => {
					const response = await api.loadGitLog(scope, input);
					expect(runtimeGitLogResponseSchema.parse(response)).toEqual(response);
					expect(response.ok).toBe(true);
					expect(response.error).toBeUndefined();
					expect(response.commits).toEqual([]);
					expect(response.totalCount).toBe(0);
					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: git refs is ok with an empty refs list.
	it("loadGitRefs returns an empty refs list", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(
				fc.option(fc.record({ taskId: nonBlankStringArbitrary, baseRef: nonBlankStringArbitrary }), {
					nil: null,
				}),
				async (input) => {
					const response = await api.loadGitRefs(scope, input);
					expect(runtimeGitRefsResponseSchema.parse(response)).toEqual(response);
					expect(response.ok).toBe(true);
					expect(response.error).toBeUndefined();
					expect(response.refs).toEqual([]);
					expectNoChildProcessSpawned();
				},
			),
			{ numRuns: 100 },
		);
	});

	// Req 5.6: commit diff echoes the requested hash with no files.
	it("loadCommitDiff echoes the commit hash with no files", async () => {
		const api = createInPlaceApi();
		await fc.assert(
			fc.asyncProperty(nonBlankStringArbitrary, async (commitHash) => {
				const response = await api.loadCommitDiff(scope, { commitHash });
				expect(runtimeGitCommitDiffResponseSchema.parse(response)).toEqual(response);
				expect(response.ok).toBe(true);
				expect(response.error).toBeUndefined();
				expect(response.commitHash).toBe(commitHash);
				expect(response.files).toEqual([]);
				expectNoChildProcessSpawned();
			}),
			{ numRuns: 100 },
		);
	});
});
