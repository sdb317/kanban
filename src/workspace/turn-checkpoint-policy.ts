// Turn-checkpoint policy: checkpoints are only captured in Worktree Mode.
// Each capture site asks the policy right before capturing, so the effective
// worktree setting is honored at turn time even for sessions that started in a
// different mode (Req 6.1, 6.2, 14.3).
import { loadEffectiveWorktreesEnabled } from "../config/effective-worktree-mode.js";
import type { RuntimeTaskSessionSummary } from "../core/api-contract.js";

export interface TurnCheckpointPolicy {
	shouldCaptureTurnCheckpoint(projectPath: string): Promise<boolean>;
}

export function createTurnCheckpointPolicy(deps?: {
	loadEffectiveWorktreesEnabled?: (p: string) => Promise<boolean>;
}): TurnCheckpointPolicy {
	const loadEffective = deps?.loadEffectiveWorktreesEnabled ?? loadEffectiveWorktreesEnabled;
	return {
		shouldCaptureTurnCheckpoint(projectPath: string): Promise<boolean> {
			return loadEffective(projectPath);
		},
	};
}

/** Copy of the summary with both turn-checkpoint fields cleared (Req 6.3). Pure: never mutates the input. */
export function clearTurnCheckpoints(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return { ...summary, latestTurnCheckpoint: null, previousTurnCheckpoint: null };
}
