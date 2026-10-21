import fc from "fast-check";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData, TaskAutoReviewMode } from "@/types";

// The hook arms auto-review only for review tasks that report working changes
// (`changedFiles > 0`). It schedules each action behind this delay.
const AUTO_REVIEW_ACTION_DELAY_MS = 500;
const TIMER_ADVANCE_MS = 1_000;

const COLUMN_IDS: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
const COLUMN_TITLES: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	trash: "Done",
};

interface GeneratedTask {
	id: string;
	columnId: BoardColumnId;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
}

function createCard(task: GeneratedTask): BoardCard {
	return {
		id: task.id,
		title: task.id,
		prompt: task.id,
		startInPlanMode: false,
		autoReviewEnabled: task.autoReviewEnabled,
		autoReviewMode: task.autoReviewMode,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function buildBoard(tasks: GeneratedTask[]): BoardData {
	const columns = COLUMN_IDS.map((columnId) => ({
		id: columnId,
		title: COLUMN_TITLES[columnId],
		cards: tasks.filter((task) => task.columnId === columnId).map(createCard),
	}));
	return { columns, dependencies: [] };
}

// Make every review task appear to have working changes so the hook arms
// auto-review for it. Non-review tasks are irrelevant to the snapshot store.
function armReviewSnapshots(tasks: GeneratedTask[]): void {
	for (const task of tasks) {
		if (task.columnId !== "review") {
			continue;
		}
		setTaskWorkspaceSnapshot({
			taskId: task.id,
			path: `/tmp/${task.id}`,
			branch: task.id,
			isDetached: false,
			headCommit: "abc123",
			changedFiles: 3,
			additions: 10,
			deletions: 2,
		});
	}
}

const autoReviewModeArb: fc.Arbitrary<TaskAutoReviewMode> = fc.constantFrom("commit", "pr");

function tasksArb(): fc.Arbitrary<GeneratedTask[]> {
	// The workspace-metadata store trims task ids on lookup, so a card id with
	// surrounding whitespace would never match its stored snapshot. Constrain to
	// non-empty ids with no leading/trailing whitespace to keep the generated
	// board a faithful stand-in for real task ids.
	return fc
		.uniqueArray(
			fc.string({ minLength: 1, maxLength: 6 }).filter((value) => value.length > 0 && value === value.trim()),
			{ minLength: 1, maxLength: 6 },
		)
		.chain((ids) =>
			fc.tuple(
				...ids.map((id) =>
					fc.record({
						id: fc.constant(id),
						columnId: fc.constantFrom<BoardColumnId>(...COLUMN_IDS),
						autoReviewEnabled: fc.boolean(),
						autoReviewMode: autoReviewModeArb,
					}),
				),
			),
		);
}

// A board that guarantees at least one review task with auto-review enabled,
// so transition suppression has something meaningful to act on.
function tasksWithEnabledReviewArb(): fc.Arbitrary<GeneratedTask[]> {
	return tasksArb().map((tasks): GeneratedTask[] => {
		const hasEnabledReview = tasks.some((task) => task.columnId === "review" && task.autoReviewEnabled);
		if (hasEnabledReview) {
			return tasks;
		}
		// `tasksArb()` always yields at least one task; force the first into an
		// enabled review task so the suppression scenarios have a target.
		return tasks.map((task, index) =>
			index === 0 ? { ...task, columnId: "review", autoReviewEnabled: true } : task,
		);
	});
}

type RunAutoReviewGitAction = (taskId: string, action: TaskGitAction) => Promise<boolean>;
type RequestMoveTaskToTrash = (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;

function createRunAutoReviewGitActionMock() {
	return vi.fn<RunAutoReviewGitAction>(async () => true);
}

function createRequestMoveTaskToTrashMock() {
	return vi.fn<RequestMoveTaskToTrash>(async () => {});
}

interface HarnessProps {
	board: BoardData;
	enabled?: boolean;
	worktreesEnabled?: boolean | null;
	runAutoReviewGitAction: RunAutoReviewGitAction;
	requestMoveTaskToTrash: RequestMoveTaskToTrash;
}

function HookHarness({
	board,
	enabled,
	worktreesEnabled,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: HarnessProps): null {
	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
		enabled,
		worktreesEnabled,
	});
	return null;
}

describe("useReviewAutoActions property tests", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	function renderHarness(props: HarnessProps): void {
		act(() => {
			root.render(<HookHarness {...props} />);
		});
	}

	function flushAutoReviewTimers(): void {
		act(() => {
			vi.advanceTimersByTime(TIMER_ADVANCE_MS);
		});
	}

	// Property 14 (part A): master gate.
	// Validates: Requirements 7.3, 7.6 — while disabled, no auto-review git
	// action and no move-to-trash ever fires, for any generated board,
	// including review tasks with autoReviewEnabled=true and working changes.
	it("Property 14: runs no auto-review action while disabled", () => {
		fc.assert(
			fc.property(tasksArb(), fc.constantFrom<boolean | null>(true, false, null), (tasks, worktreesEnabled) => {
				resetWorkspaceMetadataStore();
				const runAutoReviewGitAction = createRunAutoReviewGitActionMock();
				const requestMoveTaskToTrash = createRequestMoveTaskToTrashMock();

				armReviewSnapshots(tasks);
				renderHarness({
					board: buildBoard(tasks),
					enabled: false,
					worktreesEnabled,
					runAutoReviewGitAction,
					requestMoveTaskToTrash,
				});
				flushAutoReviewTimers();

				expect(runAutoReviewGitAction).not.toHaveBeenCalled();
				expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
			}),
			{ numRuns: 30 },
		);
	});

	// Property 14 (part B): false -> true transition suppression.
	// Validates: Requirement 7.8 — on a loaded false -> true transition, tasks
	// already in review at the time of the change get no auto-review action,
	// while a task that enters review AFTER the transition is eligible.
	it("Property 14: suppresses pre-existing review tasks across a false -> true transition", () => {
		fc.assert(
			fc.property(tasksWithEnabledReviewArb(), (tasks) => {
				resetWorkspaceMetadataStore();
				const runAutoReviewGitAction = createRunAutoReviewGitActionMock();
				const requestMoveTaskToTrash = createRequestMoveTaskToTrashMock();

				const preExistingReviewTaskIds = tasks.filter((task) => task.columnId === "review").map((task) => task.id);

				armReviewSnapshots(tasks);

				// Mount in In-Place Mode. The parent gates the hook off in this mode
				// (enabled=false), so nothing arms and the transition effect records
				// the prior worktreesEnabled=false value.
				renderHarness({
					board: buildBoard(tasks),
					enabled: false,
					worktreesEnabled: false,
					runAutoReviewGitAction,
					requestMoveTaskToTrash,
				});
				flushAutoReviewTimers();
				expect(runAutoReviewGitAction).not.toHaveBeenCalled();

				// Flip to Worktree Mode (false -> true): current review tasks are
				// snapshotted into the suppressed set.
				renderHarness({
					board: buildBoard(tasks),
					enabled: true,
					worktreesEnabled: true,
					runAutoReviewGitAction,
					requestMoveTaskToTrash,
				});
				flushAutoReviewTimers();

				// No auto-review action fired for any pre-existing review task.
				for (const call of runAutoReviewGitAction.mock.calls) {
					expect(preExistingReviewTaskIds).not.toContain(call[0]);
				}

				// A brand new task entering review after the transition IS eligible.
				const newTaskId = "post-transition-review-task";
				const newTask: GeneratedTask = {
					id: newTaskId,
					columnId: "review",
					autoReviewEnabled: true,
					autoReviewMode: "commit",
				};
				const tasksWithNew = [...tasks, newTask];
				armReviewSnapshots([newTask]);
				renderHarness({
					board: buildBoard(tasksWithNew),
					enabled: true,
					worktreesEnabled: true,
					runAutoReviewGitAction,
					requestMoveTaskToTrash,
				});
				flushAutoReviewTimers();

				expect(runAutoReviewGitAction).toHaveBeenCalledWith(newTaskId, "commit");
				// Still nothing for the suppressed pre-existing review tasks.
				for (const call of runAutoReviewGitAction.mock.calls) {
					expect(preExistingReviewTaskIds).not.toContain(call[0]);
				}
			}),
			{ numRuns: 25 },
		);
	});

	// Property 14 (part C): a fresh mount in Worktree Mode is NOT a transition.
	// Validates: Requirement 13.5 context — null -> true is not a false -> true
	// transition, so pre-existing enabled review tasks ARE eligible.
	it("Property 14: a fresh null -> true mount applies auto-review normally", () => {
		fc.assert(
			fc.property(tasksWithEnabledReviewArb(), (tasks) => {
				resetWorkspaceMetadataStore();
				const runAutoReviewGitAction = createRunAutoReviewGitActionMock();
				const requestMoveTaskToTrash = createRequestMoveTaskToTrashMock();

				const enabledReviewTaskIds = tasks
					.filter((task) => task.columnId === "review" && task.autoReviewEnabled)
					.map((task) => task.id);

				armReviewSnapshots(tasks);
				// First (and only) render with worktreesEnabled=true: prior value is
				// null/undefined, so this is not a false -> true transition.
				renderHarness({
					board: buildBoard(tasks),
					enabled: true,
					worktreesEnabled: true,
					runAutoReviewGitAction,
					requestMoveTaskToTrash,
				});
				flushAutoReviewTimers();

				const calledTaskIds = runAutoReviewGitAction.mock.calls.map((call) => call[0]);
				for (const taskId of enabledReviewTaskIds) {
					expect(calledTaskIds).toContain(taskId);
				}
			}),
			{ numRuns: 25 },
		);
	});

	// Sanity anchor for the 500ms delay constant used by the hook: actions must
	// not fire before the delay elapses.
	it("Property 14: no auto-review action fires before the scheduled delay", () => {
		resetWorkspaceMetadataStore();
		const runAutoReviewGitAction = createRunAutoReviewGitActionMock();
		const requestMoveTaskToTrash = createRequestMoveTaskToTrashMock();
		const tasks: GeneratedTask[] = [
			{ id: "t1", columnId: "review", autoReviewEnabled: true, autoReviewMode: "commit" },
		];
		armReviewSnapshots(tasks);
		renderHarness({
			board: buildBoard(tasks),
			enabled: true,
			worktreesEnabled: true,
			runAutoReviewGitAction,
			requestMoveTaskToTrash,
		});
		act(() => {
			vi.advanceTimersByTime(AUTO_REVIEW_ACTION_DELAY_MS - 1);
		});
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(2);
		});
		expect(runAutoReviewGitAction).toHaveBeenCalledWith("t1", "commit");
	});
});
