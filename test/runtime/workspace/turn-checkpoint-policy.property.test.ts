import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeTaskTurnCheckpoint } from "../../../src/core/api-contract";
import { clearTurnCheckpoints } from "../../../src/workspace/turn-checkpoint-policy";

/** Checkpoint objects matching `runtimeTaskTurnCheckpointSchema`. */
const checkpointArbitrary: fc.Arbitrary<RuntimeTaskTurnCheckpoint> = fc.record({
	turn: fc.integer({ min: 1, max: 100000 }),
	ref: fc.string(),
	commit: fc.string(),
	createdAt: fc.integer({ min: 0 }),
});

/**
 * The two turn-checkpoint fields are `.nullable().optional()` in the schema, so
 * span a checkpoint object, `null`, and absence (`undefined`).
 */
const checkpointFieldArbitrary: fc.Arbitrary<RuntimeTaskTurnCheckpoint | null | undefined> = fc.oneof(
	checkpointArbitrary,
	fc.constant(null),
	fc.constant(undefined),
);

/**
 * Realistic `RuntimeTaskSessionSummary` objects. Every field is varied, with
 * the two checkpoint fields spanning object / null / undefined so "targeted"
 * clearing is exercised regardless of their starting value.
 */
const summaryArbitrary: fc.Arbitrary<RuntimeTaskSessionSummary> = fc.record({
	taskId: fc.string(),
	state: fc.constantFrom("idle", "running", "awaiting_review", "failed", "interrupted"),
	mode: fc.oneof(fc.constantFrom("act", "plan"), fc.constant(null), fc.constant(undefined)),
	agentId: fc.oneof(fc.string(), fc.constant(null)),
	workspacePath: fc.oneof(fc.string(), fc.constant(null)),
	pid: fc.oneof(fc.integer(), fc.constant(null)),
	startedAt: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
	updatedAt: fc.integer({ min: 0 }),
	lastOutputAt: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
	reviewReason: fc.constantFrom("attention", "exit", "error", "interrupted", "hook", null),
	exitCode: fc.oneof(fc.integer(), fc.constant(null)),
	lastHookAt: fc.oneof(fc.integer({ min: 0 }), fc.constant(null)),
	latestHookActivity: fc.oneof(
		fc.record({
			activityText: fc.oneof(fc.string(), fc.constant(null)),
			toolName: fc.oneof(fc.string(), fc.constant(null)),
			toolInputSummary: fc.oneof(fc.string(), fc.constant(null)),
			finalMessage: fc.oneof(fc.string(), fc.constant(null)),
			hookEventName: fc.oneof(fc.string(), fc.constant(null)),
			notificationType: fc.oneof(fc.string(), fc.constant(null)),
			source: fc.oneof(fc.string(), fc.constant(null)),
		}),
		fc.constant(null),
	),
	warningMessage: fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)),
	latestTurnCheckpoint: checkpointFieldArbitrary,
	previousTurnCheckpoint: checkpointFieldArbitrary,
}) as fc.Arbitrary<RuntimeTaskSessionSummary>;

describe("clearTurnCheckpoints", () => {
	// Property 12: Checkpoint clearing is targeted.
	// Validates: Requirements 6.3
	it("nulls both checkpoint fields, leaves every other field unchanged, and never mutates the input", () => {
		fc.assert(
			fc.property(summaryArbitrary, (summary) => {
				// Snapshot the original checkpoint values to verify purity afterward.
				const originalLatest = summary.latestTurnCheckpoint;
				const originalPrevious = summary.previousTurnCheckpoint;

				const result = clearTurnCheckpoints(summary);

				// (1) Both checkpoint fields are cleared to null for all inputs.
				expect(result.latestTurnCheckpoint).toBeNull();
				expect(result.previousTurnCheckpoint).toBeNull();

				// (2) Every other field is byte-for-byte unchanged: the result equals
				// the input with only the two checkpoint fields overridden to null.
				const expected = {
					...summary,
					latestTurnCheckpoint: null,
					previousTurnCheckpoint: null,
				};
				expect(result).toEqual(expected);

				// (3) Purity: the original input object is not mutated.
				expect(summary.latestTurnCheckpoint).toBe(originalLatest);
				expect(summary.previousTurnCheckpoint).toBe(originalPrevious);
			}),
			{ numRuns: 500 },
		);
	});
});
