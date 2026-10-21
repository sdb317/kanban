// Feature: in-place-workspace-mode, task 16.2 — create/edit dialog In-Place example tests.
// The task-create dialog and the inline create card hide the base-ref branch
// selector and the auto-review controls in In-Place Mode, and submit using the
// resolved default base ref. The inline edit flow keeps its stored base ref.
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import type { RuntimeGitRepositoryInfo } from "@/runtime/types";
import { WorktreeModeProvider } from "@/runtime/worktree-mode";

// Stub the heavy children so the tests focus on the base-ref / auto-review
// gating rather than the composer, branch search, or model picker internals.
vi.mock("@/components/task-prompt-composer", () => ({
	TaskPromptComposer: ({ value }: { value: string }) => (
		<textarea data-testid="prompt-composer" defaultValue={value} />
	),
}));

vi.mock("@/components/branch-select-dropdown", () => ({
	BranchSelectDropdown: () => <div data-testid="branch-select-dropdown" />,
}));

vi.mock("@/components/task-agent-model-picker", () => ({
	useTaskAgentModelPicker: () => ({
		agentOptions: [],
		clineProviderOptions: [],
		clineModelOptions: [],
		effectiveDefaultModelId: null,
		providerModels: [],
		isLoadingProviders: false,
		isLoadingModels: false,
		providerDefaultModels: {},
	}),
	TaskAgentModelPicker: () => <div data-testid="agent-model-picker" />,
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

const WORKSPACE_GIT: RuntimeGitRepositoryInfo = {
	currentBranch: "develop",
	defaultBranch: "main",
	branches: ["develop", "main"],
};

function renderInPlace(root: Root, ui: ReactNode): void {
	root.render(<WorktreeModeProvider value={false}>{ui}</WorktreeModeProvider>);
}

function renderWorktree(root: Root, ui: ReactNode): void {
	root.render(<WorktreeModeProvider value={true}>{ui}</WorktreeModeProvider>);
}

describe("task create/edit In-Place Mode", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		container.remove();
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderCreateDialog(
		worktreeMode: boolean,
		onBranchRefChange: () => void = vi.fn(),
		branchRef = "",
	): Promise<void> {
		const render = worktreeMode ? renderWorktree : renderInPlace;
		await act(async () => {
			render(
				root,
				<TaskCreateDialog
					open={true}
					onOpenChange={() => {}}
					prompt="Do the thing"
					onPromptChange={() => {}}
					images={[]}
					onImagesChange={() => {}}
					onCreate={() => "task-1"}
					onCreateAndStart={() => "task-1"}
					onCreateMultiple={() => ["task-1"]}
					startInPlanMode={false}
					onStartInPlanModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					workspaceId="workspace-1"
					workspaceGit={WORKSPACE_GIT}
					branchRef={branchRef}
					branchOptions={[{ value: "develop", label: "develop" }]}
					onBranchRefChange={onBranchRefChange}
				/>,
			);
		});
	}

	it("hides the base-ref selector and auto-review controls in the create dialog", async () => {
		await renderCreateDialog(false);

		expect(document.body.querySelector('[data-testid="branch-select-dropdown"]')).toBeNull();
		expect(document.body.textContent).not.toContain("Worktree base ref");
		expect(document.body.textContent).not.toContain("Automatically");
	});

	it("shows the base-ref selector and auto-review controls in the create dialog in Worktree Mode", async () => {
		await renderCreateDialog(true);

		expect(document.body.querySelector('[data-testid="branch-select-dropdown"]')).toBeInstanceOf(HTMLDivElement);
		expect(document.body.textContent).toContain("Worktree base ref");
		expect(document.body.textContent).toContain("Automatically");
	});

	it("resolves the default base ref for the create dialog from the current branch", async () => {
		const onBranchRefChange = vi.fn();
		await renderCreateDialog(false, onBranchRefChange, "");

		// resolveInPlaceDefaultBaseRef(workspaceGit) === currentBranch.
		expect(onBranchRefChange).toHaveBeenCalledWith("develop");
	});

	it("hides the base-ref selector and auto-review controls in the inline create card", async () => {
		await act(async () => {
			renderInPlace(
				root,
				<TaskInlineCreateCard
					prompt="Do the thing"
					onPromptChange={() => {}}
					onCreate={() => {}}
					startInPlanMode={false}
					onStartInPlanModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					workspaceId="workspace-1"
					workspaceGit={WORKSPACE_GIT}
					branchRef=""
					branchOptions={[{ value: "develop", label: "develop" }]}
					onBranchRefChange={() => {}}
					mode="create"
				/>,
			);
		});

		expect(container.querySelector('[data-testid="branch-select-dropdown"]')).toBeNull();
		expect(container.textContent).not.toContain("Worktree base ref");
		expect(container.querySelector('[aria-label="Enable automatic review action"]')).toBeNull();
	});

	it("resolves the default base ref for the inline create card", async () => {
		const onBranchRefChange = vi.fn();
		await act(async () => {
			renderInPlace(
				root,
				<TaskInlineCreateCard
					prompt="Do the thing"
					onPromptChange={() => {}}
					onCreate={() => {}}
					startInPlanMode={false}
					onStartInPlanModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					workspaceId="workspace-1"
					workspaceGit={WORKSPACE_GIT}
					branchRef=""
					branchOptions={[{ value: "develop", label: "develop" }]}
					onBranchRefChange={onBranchRefChange}
					mode="create"
				/>,
			);
		});

		expect(onBranchRefChange).toHaveBeenCalledWith("develop");
	});

	it("keeps the stored base ref in the inline edit flow (no default override)", async () => {
		const onBranchRefChange = vi.fn();
		await act(async () => {
			renderInPlace(
				root,
				<TaskInlineCreateCard
					prompt="Do the thing"
					onPromptChange={() => {}}
					onCreate={() => {}}
					startInPlanMode={false}
					onStartInPlanModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					workspaceId="workspace-1"
					workspaceGit={WORKSPACE_GIT}
					branchRef="stored-ref"
					branchOptions={[{ value: "develop", label: "develop" }]}
					onBranchRefChange={onBranchRefChange}
					mode="edit"
				/>,
			);
		});

		// Edit mode never rewrites the stored base ref to the in-place default.
		expect(onBranchRefChange).not.toHaveBeenCalled();
		// Base-ref selector and auto-review controls stay hidden in In-Place Mode.
		expect(container.querySelector('[data-testid="branch-select-dropdown"]')).toBeNull();
	});
});
