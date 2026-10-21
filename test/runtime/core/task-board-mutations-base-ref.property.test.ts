import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveInPlaceDefaultBaseRef } from "../../../src/config/worktree-setting";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { addTaskToColumn, updateTask } from "../../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

/**
 * Arbitrary spanning the full space of caller-supplied `baseRef` strings in
 * In-Place Mode: the empty string, whitespace-only strings, and arbitrary
 * strings (branch-like names included) wrapped in surrounding whitespace.
 * In-Place Mode stores these without branch validation (Req 10.2).
 */
const baseRefArbitrary: fc.Arbitrary<string> = fc.oneof(
	fc.constant(""),
	fc.stringMatching(/^[ \t\n\r]+$/),
	fc.string(),
	fc
		.tuple(fc.stringMatching(/^[ \t\n\r]*$/), fc.string(), fc.stringMatching(/^[ \t\n\r]*$/))
		.map(([leading, core, trailing]) => `${leading}${core}${trailing}`),
);

describe("In-Place baseRef storage in board mutations", () => {
	// Property 15 (part 1): supplied baseRef is stored trimmed, without validation.
	// Validates: Requirements 10.2
	it("stores exactly input.baseRef.trim() on createTask and updateTask", () => {
		fc.assert(
			fc.property(baseRefArbitrary, baseRefArbitrary, (createBaseRef, updateBaseRef) => {
				const created = addTaskToColumn(
					createBoard(),
					"backlog",
					{ prompt: "Task prompt", baseRef: createBaseRef },
					() => "aaaaa111",
				);
				expect(created.task.baseRef).toBe(createBaseRef.trim());

				const updated = updateTask(created.board, created.task.id, {
					prompt: "Task prompt",
					baseRef: updateBaseRef,
				});
				expect(updated.updated).toBe(true);
				expect(updated.task?.baseRef).toBe(updateBaseRef.trim());
			}),
			{ numRuns: 1000 },
		);
	});
});

describe("resolveInPlaceDefaultBaseRef", () => {
	// Property 15 (part 2): default baseRef is git?.currentBranch ?? "".
	// Validates: Requirements 10.3
	it("returns the checked-out branch for named branches, and '' for null git or null currentBranch", () => {
		expect(resolveInPlaceDefaultBaseRef(null)).toBe("");
		expect(resolveInPlaceDefaultBaseRef({ currentBranch: null })).toBe("");

		fc.assert(
			fc.property(fc.string({ minLength: 1 }), (branch) => {
				expect(resolveInPlaceDefaultBaseRef({ currentBranch: branch })).toBe(branch);
			}),
			{ numRuns: 500 },
		);
	});
});
