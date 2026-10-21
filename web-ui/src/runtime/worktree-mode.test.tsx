import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useWorktreeMode, WorktreeModeProvider, type WorktreeModeValue } from "@/runtime/worktree-mode";
import { renderWithWorktreeMode } from "@/test-utils/render-with-worktree-mode";

let previousActEnvironment: boolean | undefined;

function withActEnvironment<T>(run: () => T): T {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	return run();
}

afterEach(() => {
	if (previousActEnvironment === undefined) {
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	} else {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	}
	previousActEnvironment = undefined;
});

function Capture({ onValue }: { onValue: (value: WorktreeModeValue) => void }): null {
	const value = useWorktreeMode();
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

describe("useWorktreeMode", () => {
	it("reports worktree mode when enabled is true", () => {
		let captured: WorktreeModeValue | null = null;
		const { unmount } = withActEnvironment(() =>
			renderWithWorktreeMode(
				<Capture
					onValue={(value) => {
						captured = value;
					}}
				/>,
				{ worktreesEnabled: true },
			),
		);

		expect(captured).toEqual({ worktreesEnabled: true, isWorktreeMode: true });
		unmount();
	});

	it("is not worktree mode when enabled is false", () => {
		let captured: WorktreeModeValue | null = null;
		const { unmount } = withActEnvironment(() =>
			renderWithWorktreeMode(
				<Capture
					onValue={(value) => {
						captured = value;
					}}
				/>,
				{ worktreesEnabled: false },
			),
		);

		expect(captured).toEqual({ worktreesEnabled: false, isWorktreeMode: false });
		unmount();
	});

	it("is not worktree mode while the config is loading (null)", () => {
		let captured: WorktreeModeValue | null = null;
		const { unmount } = withActEnvironment(() =>
			renderWithWorktreeMode(
				<Capture
					onValue={(value) => {
						captured = value;
					}}
				/>,
				{ worktreesEnabled: null },
			),
		);

		expect(captured).toEqual({ worktreesEnabled: null, isWorktreeMode: false });
		unmount();
	});

	it("throws when used outside of a provider", () => {
		function Unwrapped(): null {
			useWorktreeMode();
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		withActEnvironment(() => {
			expect(() =>
				act(() => {
					root.render(<Unwrapped />);
				}),
			).toThrowError(/within a WorktreeModeProvider/);
		});

		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("exposes the provider for direct wrapping", () => {
		expect(typeof WorktreeModeProvider).toBe("function");
	});
});
