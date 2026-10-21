// Pure mapping from the worktree settings draft to a minimal config save request.
// Keeping this free of React/UI lets the settings property test exercise it directly.
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";

/** Three-way project override selection shown in the settings radio group. */
export type ProjectWorktreeOverrideChoice = "global" | "off" | "on";

export interface WorktreeSettingsDraft {
	/** Global "Use git worktrees" toggle state. */
	globalWorktreesEnabled: boolean;
	/** Per-project override selection, or `null` when no project is selected. */
	projectOverride: ProjectWorktreeOverrideChoice | null;
}

/** Fields of the config save request this helper may populate. */
export type WorktreeSaveRequestFields = Pick<RuntimeConfigSaveRequest, "worktreesEnabled" | "projectWorktreesEnabled">;

/** Map the three-way override choice to the stored value: global -> null, off -> false, on -> true. */
export function resolveProjectOverrideValue(choice: ProjectWorktreeOverrideChoice): boolean | null {
	switch (choice) {
		case "off":
			return false;
		case "on":
			return true;
		default:
			return null;
	}
}

/** Derive the override choice from a stored value for pre-selecting the radio group. */
export function resolveProjectOverrideChoice(value: boolean | null): ProjectWorktreeOverrideChoice {
	if (value === true) {
		return "on";
	}
	if (value === false) {
		return "off";
	}
	return "global";
}

/**
 * Build the minimal save request from the loaded config and the current draft.
 * Only fields whose value differs from the loaded config are included (Req 2.4).
 */
export function buildWorktreeSaveRequest(
	loaded: Pick<RuntimeConfigResponse, "globalWorktreesEnabled" | "projectWorktreesEnabled">,
	draft: WorktreeSettingsDraft,
): WorktreeSaveRequestFields {
	const request: WorktreeSaveRequestFields = {};

	// The loaded global value is `null` when unset; an unset global reads as `false` in the UI toggle.
	const loadedGlobal = loaded.globalWorktreesEnabled === true;
	if (draft.globalWorktreesEnabled !== loadedGlobal) {
		request.worktreesEnabled = draft.globalWorktreesEnabled;
	}

	if (draft.projectOverride !== null) {
		const nextOverride = resolveProjectOverrideValue(draft.projectOverride);
		if (nextOverride !== loaded.projectWorktreesEnabled) {
			request.projectWorktreesEnabled = nextOverride;
		}
	}

	return request;
}
