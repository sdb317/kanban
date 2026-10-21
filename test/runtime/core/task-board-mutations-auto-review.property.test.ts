import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData, RuntimeTaskAutoReviewMode } from "../../../src/core/api-contract";
import {
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../../../src/core/task-board-mutations";

/**
 * Property 13 — Auto-review fields survive board operations.
 * Validates: Requirements 7.4
 *
 * The move/trash/restore/delete board mutations are mode-independent: they
 * reorder cards between columns but must never touch a card's stored
 * `autoReviewEnabled` / `autoReviewMode`. This property generates a board of
 * tasks carrying arbitrary auto-review values, applies a random sequence of
 * those mutations, and asserts the two fields are byte-identical before and
 * after — for every task that still exists.
 *
 * `updateTask` is intentionally excluded: it legitimately overwrites these
 * fields with caller-supplied values, so it is not a mode-independent mutation.
 */

const COLUMN_IDS: readonly RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
const AUTO_REVIEW_MODES: readonly RuntimeTaskAutoReviewMode[] = ["commit", "pr"];

interface TaskSpec {
	id: string;
	columnId: RuntimeBoardColumnId;
	autoReviewEnabled: boolean;
	autoReviewMode: RuntimeTaskAutoReviewMode;
}

/** A single operation to apply, referencing a task by index into the spec list. */
type Operation =
	| { kind: "moveToReview"; taskIndex: number }
	| { kind: "moveToTrash"; taskIndex: number }
	| { kind: "moveToBacklog"; taskIndex: number }
	| { kind: "moveToInProgress"; taskIndex: number }
	| { kind: "trashAndGetReady"; taskIndex: number }
	| { kind: "restoreFromTrash"; taskIndex: number }
	| { kind: "delete"; taskIndex: number };

/** Distinct 5-char task ids so `addTaskToColumn` never collides. */
function makeTaskId(index: number): string {
	const base = (index + 1).toString(36).padStart(4, "0");
	return `t${base}`;
}

const taskSpecArbitrary = (index: number): fc.Arbitrary<TaskSpec> =>
	fc.record({
		id: fc.constant(makeTaskId(index)),
		columnId: fc.constantFrom(...COLUMN_IDS),
		autoReviewEnabled: fc.boolean(),
		autoReviewMode: fc.constantFrom(...AUTO_REVIEW_MODES),
	});

const taskSpecsArbitrary: fc.Arbitrary<TaskSpec[]> = fc
	.integer({ min: 1, max: 6 })
	.chain((count) => fc.tuple(...Array.from({ length: count }, (_, index) => taskSpecArbitrary(index))))
	.map((specs) => [...specs]);

const operationArbitrary = (taskCount: number): fc.Arbitrary<Operation> =>
	fc.record({
		kind: fc.constantFrom<Operation["kind"]>(
			"moveToReview",
			"moveToTrash",
			"moveToBacklog",
			"moveToInProgress",
			"trashAndGetReady",
			"restoreFromTrash",
			"delete",
		),
		taskIndex: fc.integer({ min: 0, max: taskCount - 1 }),
	});

function emptyBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function buildBoard(specs: TaskSpec[]): RuntimeBoardData {
	let board = emptyBoard();
	for (const spec of specs) {
		const result = addTaskToColumn(
			board,
			spec.columnId,
			{
				taskId: spec.id,
				prompt: `Prompt for ${spec.id}`,
				baseRef: "main",
				autoReviewEnabled: spec.autoReviewEnabled,
				autoReviewMode: spec.autoReviewMode,
			},
			() => spec.id,
		);
		board = result.board;
	}
	return board;
}

/** Snapshot the auto-review fields keyed by task id across every column. */
function snapshotAutoReview(
	board: RuntimeBoardData,
): Map<string, { enabled: boolean; mode: RuntimeTaskAutoReviewMode }> {
	const snapshot = new Map<string, { enabled: boolean; mode: RuntimeTaskAutoReviewMode }>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			snapshot.set(card.id, { enabled: card.autoReviewEnabled ?? false, mode: card.autoReviewMode ?? "commit" });
		}
	}
	return snapshot;
}

function applyOperation(board: RuntimeBoardData, operation: Operation, specs: TaskSpec[]): RuntimeBoardData {
	const spec = specs[operation.taskIndex];
	if (!spec) {
		return board;
	}
	switch (operation.kind) {
		case "moveToReview":
			return moveTaskToColumn(board, spec.id, "review").board;
		case "moveToTrash":
			return moveTaskToColumn(board, spec.id, "trash").board;
		case "moveToBacklog":
			return moveTaskToColumn(board, spec.id, "backlog").board;
		case "moveToInProgress":
			return moveTaskToColumn(board, spec.id, "in_progress").board;
		case "trashAndGetReady":
			return trashTaskAndGetReadyLinkedTaskIds(board, spec.id).board;
		case "restoreFromTrash":
			// Restore = move back out of trash into review.
			return moveTaskToColumn(board, spec.id, "review").board;
		case "delete":
			return deleteTasksFromBoard(board, [spec.id]).board;
	}
}

describe("task-board-mutations auto-review preservation (Property 13)", () => {
	it("never mutates autoReviewEnabled / autoReviewMode across move/trash/restore/delete", () => {
		fc.assert(
			fc.property(
				taskSpecsArbitrary.chain((specs) =>
					fc
						.array(operationArbitrary(specs.length), { minLength: 1, maxLength: 12 })
						.map((operations) => ({ specs, operations })),
				),
				({ specs, operations }) => {
					// Expected values come straight from each spec and are immutable
					// for the whole sequence — delete removes a task but must never
					// alter surviving tasks' fields, and all other ops only relocate.
					const expected = new Map(
						specs.map((spec) => [spec.id, { enabled: spec.autoReviewEnabled, mode: spec.autoReviewMode }]),
					);

					let board = buildBoard(specs);

					// Sanity: freshly built board already matches the specs.
					for (const [id, fields] of snapshotAutoReview(board)) {
						expect(fields).toEqual(expected.get(id));
					}

					for (const operation of operations) {
						board = applyOperation(board, operation, specs);
						// After every single operation, every task still on the board
						// must carry its original auto-review fields byte-for-byte.
						for (const [id, fields] of snapshotAutoReview(board)) {
							expect(fields).toEqual(expected.get(id));
						}
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
