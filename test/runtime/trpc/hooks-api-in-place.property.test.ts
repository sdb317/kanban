import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeTaskTurnCheckpoint } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";
import type { TurnCheckpointPolicy } from "../../../src/workspace/turn-checkpoint-policy";

/**
 * Property 11: Turn completion never checkpoints in In-Place Mode.
 * Validates: Requirements 6.1, 6.2
 *
 * While the effective setting is false (In-Place Mode), a completed agent turn
 * (the `to_review` hook) must apply the SAME state transition and broadcasts as
 * Worktree Mode, but must create NO turn checkpoint and run ZERO git commands for
 * checkpoint capture or stale-ref deletion.
 *
 * The test drives `createHooksApi(...)` with spy deps for `captureTaskTurnCheckpoint`
 * and `deleteTaskTurnCheckpointRef`, a fake `TerminalSessionManager`, and a
 * `turnCheckpointPolicy` whose `shouldCaptureTurnCheckpoint` returns a generated
 * boolean. Over varied hook inputs it asserts: the transition and broadcasts always
 * fire, but the two git-touching spies fire only when the policy is true (Worktree),
 * never when it is false (In-Place).
 */

/** Pre-existing checkpoint fields the transitioned summary might carry. */
const checkpointArbitrary: fc.Arbitrary<RuntimeTaskTurnCheckpoint> = fc.record({
	turn: fc.integer({ min: 1, max: 100000 }),
	ref: fc.string({ minLength: 1 }),
	commit: fc.string({ minLength: 1 }),
	createdAt: fc.integer({ min: 0 }),
});

const checkpointFieldArbitrary: fc.Arbitrary<RuntimeTaskTurnCheckpoint | null | undefined> = fc.oneof(
	checkpointArbitrary,
	fc.constant(null),
	fc.constant(undefined),
);

/** Varied, valid `metadata` payload accepted by the hook ingest schema. */
const metadataArbitrary = fc.option(
	fc.record(
		{
			source: fc.string(),
			activityText: fc.string(),
			toolName: fc.string(),
		},
		{ requiredKeys: [] },
	),
	{ nil: undefined },
);

interface IngestInput {
	taskId: string;
	workspaceId: string;
	event: "to_review";
	metadata?: { source?: string; activityText?: string; toolName?: string };
}

/**
 * Generate a `to_review` hook input (the only event that reaches the capture
 * branch). `to_review` requires a running summary, which the fake manager always
 * supplies, so the transition is always allowed.
 */
// The hook ingest parser trims `taskId`/`workspaceId` and rejects blanks, so
// generate identifiers that still contain a non-whitespace character after trim.
const identifierArbitrary = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

const ingestInputArbitrary: fc.Arbitrary<IngestInput> = fc
	.record({
		taskId: identifierArbitrary,
		workspaceId: identifierArbitrary,
		metadata: metadataArbitrary,
	})
	.map(({ taskId, workspaceId, metadata }) => ({ taskId, workspaceId, event: "to_review" as const, metadata }));

function createRunningSummary(taskId: string, workspacePath: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath,
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

interface HarnessResult {
	response: Awaited<ReturnType<ReturnType<typeof createHooksApi>["ingest"]>>;
	manager: {
		getSummary: ReturnType<typeof vi.fn>;
		transitionToReview: ReturnType<typeof vi.fn>;
		transitionToRunning: ReturnType<typeof vi.fn>;
		applyHookActivity: ReturnType<typeof vi.fn>;
		applyTurnCheckpoint: ReturnType<typeof vi.fn>;
	};
	captureTaskTurnCheckpoint: ReturnType<typeof vi.fn>;
	deleteTaskTurnCheckpointRef: ReturnType<typeof vi.fn>;
	broadcastRuntimeWorkspaceStateUpdated: ReturnType<typeof vi.fn>;
	broadcastTaskReadyForReview: ReturnType<typeof vi.fn>;
}

/**
 * Run a single `to_review` ingest through the hooks API with a policy that returns
 * `shouldCapture`. The transitioned summary carries the generated pre-existing
 * checkpoint fields so the capture branch (if reached) has a stale ref to delete.
 */
async function runIngest(
	input: IngestInput,
	shouldCapture: boolean,
	latestTurnCheckpoint: RuntimeTaskTurnCheckpoint | null | undefined,
	previousTurnCheckpoint: RuntimeTaskTurnCheckpoint | null | undefined,
): Promise<HarnessResult> {
	const workspacePath = "/tmp/repo";

	const transitionedSummary: RuntimeTaskSessionSummary = {
		...createRunningSummary(input.taskId, workspacePath),
		state: "awaiting_review",
		reviewReason: "hook",
		latestTurnCheckpoint,
		previousTurnCheckpoint,
	};

	const manager = {
		getSummary: vi.fn(() => createRunningSummary(input.taskId, workspacePath)),
		transitionToReview: vi.fn(() => transitionedSummary),
		transitionToRunning: vi.fn(),
		applyHookActivity: vi.fn(),
		applyTurnCheckpoint: vi.fn(),
	};

	const captureTaskTurnCheckpoint = vi.fn(async () => ({
		turn: (latestTurnCheckpoint?.turn ?? 0) + 1,
		ref: `refs/kanban/checkpoints/${input.taskId}/turn/new`,
		commit: "deadbeef",
		createdAt: Date.now(),
	}));
	const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);
	const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
	const broadcastTaskReadyForReview = vi.fn();

	const turnCheckpointPolicy: TurnCheckpointPolicy = {
		shouldCaptureTurnCheckpoint: vi.fn(async () => shouldCapture),
	};

	const api = createHooksApi({
		getWorkspacePathById: vi.fn(() => workspacePath),
		ensureTerminalManagerForWorkspace: vi.fn(async () => manager as unknown as TerminalSessionManager),
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastTaskReadyForReview,
		captureTaskTurnCheckpoint,
		deleteTaskTurnCheckpointRef,
		turnCheckpointPolicy,
	});

	const response = await api.ingest(input);
	// Let the best-effort fire-and-forget ref deletion microtask settle.
	await Promise.resolve();

	return {
		response,
		manager,
		captureTaskTurnCheckpoint,
		deleteTaskTurnCheckpointRef,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastTaskReadyForReview,
	};
}

describe("createHooksApi In-Place Mode checkpoint gating", () => {
	it("transitions and broadcasts but never captures or deletes refs when the policy is In-Place (false)", async () => {
		await fc.assert(
			fc.asyncProperty(
				ingestInputArbitrary,
				checkpointFieldArbitrary,
				checkpointFieldArbitrary,
				async (input, latest, previous) => {
					const r = await runIngest(input, false, latest, previous);

					// The state transition still happens for the completed turn.
					expect(r.response).toEqual({ ok: true });
					expect(r.manager.transitionToReview).toHaveBeenCalledTimes(1);
					// The parser trims identifiers before dispatching the transition.
					expect(r.manager.transitionToReview).toHaveBeenCalledWith(input.taskId.trim(), "hook");

					// Broadcasts fire unconditionally.
					expect(r.broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
					expect(r.broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);

					// No checkpoint is captured and no git ref work runs in In-Place Mode.
					expect(r.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
					expect(r.deleteTaskTurnCheckpointRef).not.toHaveBeenCalled();
					expect(r.manager.applyTurnCheckpoint).not.toHaveBeenCalled();
				},
			),
			{ numRuns: 300 },
		);
	});

	it("captures the turn checkpoint when the policy is Worktree (true), proving the gate is the policy", async () => {
		await fc.assert(
			fc.asyncProperty(
				ingestInputArbitrary,
				checkpointFieldArbitrary,
				checkpointFieldArbitrary,
				async (input, latest, previous) => {
					const r = await runIngest(input, true, latest, previous);

					expect(r.response).toEqual({ ok: true });
					expect(r.manager.transitionToReview).toHaveBeenCalledTimes(1);

					// Broadcasts still fire.
					expect(r.broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
					expect(r.broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);

					// Worktree Mode captures exactly one checkpoint and applies it.
					expect(r.captureTaskTurnCheckpoint).toHaveBeenCalledTimes(1);
					expect(r.manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);

					// A stale previous ref (when present) is pruned; absent otherwise.
					const staleRef = (previous ?? null)?.ref ?? null;
					if (staleRef) {
						expect(r.deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
							cwd: "/tmp/repo",
							ref: staleRef,
						});
					} else {
						expect(r.deleteTaskTurnCheckpointRef).not.toHaveBeenCalled();
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
