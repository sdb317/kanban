import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface WorktreeModeValue {
	/** `null` while the project config is still loading. */
	worktreesEnabled: boolean | null;
	/** Strict gate for git, diff, and auto-review behavior. True only when `worktreesEnabled === true`. */
	isWorktreeMode: boolean;
}

const WorktreeModeContext = createContext<WorktreeModeValue | null>(null);

export function WorktreeModeProvider({
	value,
	children,
}: {
	value: boolean | null;
	children: ReactNode;
}): React.ReactElement {
	const contextValue = useMemo<WorktreeModeValue>(
		() => ({
			worktreesEnabled: value,
			isWorktreeMode: value === true,
		}),
		[value],
	);

	return <WorktreeModeContext.Provider value={contextValue}>{children}</WorktreeModeContext.Provider>;
}

export function useWorktreeMode(): WorktreeModeValue {
	const value = useContext(WorktreeModeContext);
	if (!value) {
		throw new Error("useWorktreeMode must be used within a WorktreeModeProvider.");
	}
	return value;
}
