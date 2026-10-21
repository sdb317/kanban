export const DEFAULT_WORKTREES_ENABLED = false;

export const INVALID_WORKTREES_ENABLED_MESSAGE = "Invalid worktreesEnabled value: expected true or false.";

export const WORKTREES_REQUIRE_GIT_MESSAGE = "Git worktrees require a git repository.";

/** Raw value -> valid setting or null (unset). Only JSON booleans are valid (Req 1.1, 1.7). */
export function parseWorktreeSettingValue(raw: unknown): boolean | null {
	return typeof raw === "boolean" ? raw : null;
}

export interface WorktreeSettingSources {
	globalWorktreesEnabled: boolean | null;
	projectWorktreesEnabled: boolean | null;
}

/** Project override -> global -> default false (Req 1.4-1.6). */
export function resolveEffectiveWorktreesEnabled(sources: WorktreeSettingSources): boolean {
	if (sources.projectWorktreesEnabled !== null) {
		return sources.projectWorktreesEnabled;
	}
	if (sources.globalWorktreesEnabled !== null) {
		return sources.globalWorktreesEnabled;
	}
	return DEFAULT_WORKTREES_ENABLED;
}

/** In-Place default baseRef: current branch or "" (Req 10.3). */
export function resolveInPlaceDefaultBaseRef(git: { currentBranch: string | null } | null): string {
	return git?.currentBranch ?? "";
}
