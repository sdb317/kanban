// Feature: in-place-workspace-mode, task 16.2 — zero Git/Diff tRPC calls in In-Place Mode.
// A recording tRPC client proves that the gated diff and git hooks issue no
// Git or Diff endpoint calls across board load, task selection, a visibility
// change, and a project switch while In-Place Mode keeps them disabled.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGitActions } from "@/hooks/use-git-actions";
import type { BoardData, CardSelection } from "@/types";

// Every method on every tRPC namespace records its "namespace.endpoint" name
// when queried or mutated, so the test can assert git/diff endpoints stay cold.
const recordedCalls: string[] = [];

function makeEndpoint(name: string) {
	return {
		query: vi.fn(async () => {
			recordedCalls.push(name);
			return { ok: true, files: [], commits: [], totalCount: 0, refs: [] };
		}),
		mutate: vi.fn(async () => {
			recordedCalls.push(name);
			return { ok: true, summary: null };
		}),
	};
}

function makeNamespaceProxy(namespace: string) {
	return new Proxy(
		{},
		{
			get: (_target, endpoint: string) => makeEndpoint(`${namespace}.${endpoint}`),
		},
	);
}

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: makeNamespaceProxy("workspace"),
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

// The workspace metadata store is driven by the runtime stream in the app; for
// this hook test it stays empty, which is the realistic In-Place state.
vi.mock("@/stores/workspace-metadata-store", () => ({
	useHomeGitSummaryValue: () => null,
	useHomeGitStateVersionValue: () => 0,
	useTaskWorkspaceSnapshotValue: () => null,
	useTaskWorkspaceStateVersionValue: () => 0,
	getTaskWorkspaceInfo: () => null,
	getTaskWorkspaceSnapshot: () => null,
	setHomeGitSummary: () => {},
	setTaskWorkspaceInfo: () => {},
}));

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	} as unknown as BoardData;
}

function createSelection(taskId: string): CardSelection {
	const card = {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "",
		createdAt: 1,
		updatedAt: 1,
	};
	const column = { id: "review" as const, title: "Review", cards: [card] };
	return { card, column, allColumns: [column] } as unknown as CardSelection;
}

function GitActionsHarness({
	projectId,
	selectedCard,
}: {
	projectId: string | null;
	selectedCard: CardSelection | null;
}): null {
	useGitActions({
		currentProjectId: projectId,
		board: createBoard(),
		selectedCard,
		runtimeProjectConfig: null,
		sendTaskSessionInput: async () => ({ ok: true }),
		sendTaskChatMessage: async () => ({ ok: true }),
		fetchTaskWorkspaceInfo: async () => null,
		// Git history is "open" to prove that even then, the disabled flag keeps
		// the git-history data hook from issuing any refs/log/diff/changes calls.
		isGitHistoryOpen: true,
		refreshWorkspaceState: async () => {},
		enabled: false,
	});
	return null;
}

describe("In-Place Mode issues zero Git and Diff tRPC calls", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		recordedCalls.length = 0;
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("records no git or diff endpoint calls across load, selection, visibility, and project switch", async () => {
		// 1. Board load (home scope, no task selected).
		await act(async () => {
			root.render(<GitActionsHarness projectId="project-1" selectedCard={null} />);
			await Promise.resolve();
		});

		// 2. Task selection.
		await act(async () => {
			root.render(<GitActionsHarness projectId="project-1" selectedCard={createSelection("task-a")} />);
			await Promise.resolve();
		});

		// 3. Visibility change (simulate the document becoming visible again).
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
			await Promise.resolve();
		});

		// 4. Project switch (different workspace id + task).
		await act(async () => {
			root.render(<GitActionsHarness projectId="project-2" selectedCard={createSelection("task-b")} />);
			await Promise.resolve();
		});

		// No Diff (getChanges / getWorkspaceChanges / getCommitDiff) and no Git
		// (getGitRefs / getGitLog / runGitSyncAction / checkoutGitBranch /
		// discardGitChanges) endpoint was ever reached.
		expect(recordedCalls).toEqual([]);
	});
});
