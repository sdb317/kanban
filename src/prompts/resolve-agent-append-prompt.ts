import { isHomeAgentSessionId } from "../core/home-agent-session.js";
import {
	type ResolveAppendSystemPromptCommandPrefixOptions,
	renderAppendSystemPrompt,
	resolveAppendSystemPromptCommandPrefix,
	resolveHomeAgentId,
} from "./append-system-prompt.js";
import { renderInPlaceTaskAgentPrompt } from "./task-agent-prompt.js";

export interface ResolveAgentAppendSystemPromptInput {
	taskId: string;
	projectPath: string;
	worktreesEnabled: boolean;
	commandPrefixOptions?: ResolveAppendSystemPromptCommandPrefixOptions;
}

/**
 * Selects the append system prompt for a runtime agent session.
 *
 * - Home sessions (synthetic home-agent session ids) always receive the Kanban
 *   sidebar prompt, rendered with the current `worktreesEnabled` mode so the
 *   worktree-true output stays byte-identical to today's behavior.
 * - Task sessions in In-Place Mode (`worktreesEnabled === false`) receive the
 *   In-Place task agent prompt scoped to the shared project folder.
 * - Task sessions in Worktree Mode (`worktreesEnabled === true`) receive no
 *   appended prompt (`null`), matching today's behavior for task agents.
 */
export function resolveAgentAppendSystemPrompt(input: ResolveAgentAppendSystemPromptInput): string | null {
	const { taskId, projectPath, worktreesEnabled, commandPrefixOptions } = input;

	if (isHomeAgentSessionId(taskId)) {
		return renderAppendSystemPrompt(resolveAppendSystemPromptCommandPrefix(commandPrefixOptions), {
			agentId: resolveHomeAgentId(taskId),
			worktreesEnabled,
		});
	}

	if (!worktreesEnabled) {
		return renderInPlaceTaskAgentPrompt(projectPath);
	}

	return null;
}
