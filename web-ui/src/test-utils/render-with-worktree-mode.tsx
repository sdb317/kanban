import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WorktreeModeProvider } from "@/runtime/worktree-mode";

export interface RenderWithWorktreeModeOptions {
	/** The worktree mode value provided to the tree. Defaults to `true` (Worktree Mode). */
	worktreesEnabled?: boolean | null;
}

export interface RenderWithWorktreeModeResult {
	container: HTMLDivElement;
	root: Root;
	/** Unmounts the tree and removes the container from the document. */
	unmount: () => void;
}

/**
 * Renders `ui` wrapped in a {@link WorktreeModeProvider} with the given value.
 *
 * Mirrors the `createRoot` + `act` render style used across the web-ui test
 * suite so component tests can mount under a known worktree mode without
 * re-declaring the provider boilerplate.
 */
export function renderWithWorktreeMode(
	ui: ReactNode,
	{ worktreesEnabled = true }: RenderWithWorktreeModeOptions = {},
): RenderWithWorktreeModeResult {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);

	act(() => {
		root.render(<WorktreeModeProvider value={worktreesEnabled}>{ui}</WorktreeModeProvider>);
	});

	return {
		container,
		root,
		unmount: () => {
			act(() => {
				root.unmount();
			});
			container.remove();
		},
	};
}
