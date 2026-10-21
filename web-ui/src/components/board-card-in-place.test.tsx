// Feature: in-place-workspace-mode, task 16.2 — board card In-Place example tests.
// In In-Place Mode a review card renders no change summary, no Commit/Open PR
// buttons, and no cancel-automatic-action control.
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeModeProvider } from "@/runtime/worktree-mode";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

vi.mock("@/utils/react-use", () => ({
	useMedia: () => false,
	useMeasure: () => [
		() => {},
		{ width: 240, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) },
	],
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const REVIEW_SNAPSHOT: ReviewTaskWorkspaceSnapshot = {
	taskId: "task-1",
	path: "/tmp/worktrees/task-1",
	branch: "feature/task-1",
	isDetached: false,
	headCommit: "1234567890abcdef",
	changedFiles: 4,
	additions: 20,
	deletions: 7,
};

function renderInPlace(root: Root, ui: ReactNode): void {
	root.render(<WorktreeModeProvider value={false}>{ui}</WorktreeModeProvider>);
}

describe("BoardCard In-Place Mode", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockWorkspaceSnapshot = REVIEW_SNAPSHOT;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function findButton(label: string): HTMLButtonElement | undefined {
		return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
	}

	it("renders no change-count summary or Commit/Open PR buttons on a review card", async () => {
		await act(async () => {
			renderInPlace(
				root,
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="review" onCommit={() => {}} onOpenPr={() => {}} />
				</TooltipProvider>,
			);
		});

		// No working-copy change counts rendered for the review snapshot.
		expect(container.textContent).not.toContain("4 files");
		expect(container.textContent).not.toContain("+20");
		expect(container.textContent).not.toContain("-7");
		// No Commit / Open PR buttons.
		expect(findButton("Commit")).toBeUndefined();
		expect(findButton("Open PR")).toBeUndefined();
	});

	it("does not render the cancel-automatic-action control even when auto review is enabled", async () => {
		await act(async () => {
			renderInPlace(
				root,
				<TooltipProvider>
					<BoardCard
						card={createCard({ autoReviewEnabled: true, autoReviewMode: "pr" })}
						index={0}
						columnId="review"
						onCancelAutomaticAction={() => {}}
					/>
				</TooltipProvider>,
			);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(cancelButton).toBeUndefined();
	});
});
