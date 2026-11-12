// In-Place Workspace Mode variants of the sidebar prompt sections.
//
// When `worktreesEnabled` is `false`, `renderAppendSystemPrompt` swaps the
// Worktree Mode wording for these shared-folder variants: no worktree intro,
// no `.kanban/worktrees/` bullet, no auto-review paragraph, no `--base-ref` /
// `--auto-review-*` flags on `task create` / `task update`, and `task done` /
// `task delete` / `task start` reworded so they never mention worktree cleanup.
//
// Keeping these here keeps `append-system-prompt.ts` readable while leaving the
// Worktree Mode (default) output byte-for-byte identical to the golden snapshot.

/**
 * Replaces the "It manages git worktrees automatically..." sentence in the
 * intro paragraph. In In-Place Mode every task agent runs directly in the
 * shared project folder.
 */
export const IN_PLACE_SIDEBAR_INTRO_SENTENCE =
	"Each task runs a dedicated CLI agent directly in the shared project folder.";

/**
 * Replaces the "do that work in its own worktree" wording in the
 * "You are NOT a coding agent" section.
 */
export const IN_PLACE_SIDEBAR_NOT_CODING_AGENT_SENTENCE =
	"If the user asks you to write code, fix a bug, implement a feature, refactor, or do any hands-on development work, do NOT attempt it. Instead, help them by creating tasks on the Kanban board so a dedicated coding agent can do that work in the shared project folder. Always redirect implementation requests to task creation.";

/**
 * Replaces the "inside `.kanban/worktrees/`" bullet. In In-Place Mode every
 * agent shares the project folder, so always manage tasks against the project
 * path.
 */
export const IN_PLACE_SIDEBAR_SHARED_FOLDER_BULLET =
	"- Every task agent runs directly in the shared project folder. Always create or manage tasks against the project workspace path, passed with `--project-path`.";

/**
 * Builds the In-Place `task create` CLI reference section. The `--base-ref`
 * and `--auto-review-*` flags are dropped because they have no effect in
 * In-Place Mode.
 */
export function renderInPlaceTaskCreateSection(kanbanCommand: string): string {
	return `## task create

Purpose: create a new task in \`backlog\`, with optional plan mode.

Command:
\`${kanbanCommand} task create [--title "<text>"] --prompt "<text>" [--project-path <path>] [--start-in-plan-mode <true|false>]\`

Parameters:
- \`--title "<text>"\` optional task title. If omitted, Kanban derives one from the prompt.
- \`--prompt "<text>"\` required task prompt text.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added.
- \`--start-in-plan-mode <true|false>\` optional. Default false. Set true only when explicitly requested.`;
}

/**
 * Builds the In-Place `task update` CLI reference section. The `--base-ref`
 * and `--auto-review-*` flags are dropped because they have no effect in
 * In-Place Mode.
 */
export function renderInPlaceTaskUpdateSection(kanbanCommand: string): string {
	return `## task update

Purpose: update an existing task, including prompt and plan mode.

Command:
\`${kanbanCommand} task update --task-id <task_id> [--title "<text>"] [--prompt "<text>"] [--project-path <path>] [--start-in-plan-mode <true|false>]\`

Parameters:
- \`--task-id <task_id>\` required task ID.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added.
- \`--title "<text>"\` optional replacement title.
- \`--prompt "<text>"\` optional replacement prompt text.
- \`--start-in-plan-mode <true|false>\` optional replacement of plan-mode behavior.

Notes:
- Provide at least one field to change in addition to \`--task-id\`.`;
}

/**
 * Builds the In-Place `task done` CLI reference section. Reworded so it does
 * not mention worktree cleanup.
 */
export function renderInPlaceTaskDoneSection(kanbanCommand: string): string {
	return `## task done

Purpose: move a task or an entire column to \`done\`, stop active sessions if needed, and auto-start any linked backlog tasks that become ready. \`task trash\` is also accepted as an alias.

Command:
\`${kanbanCommand} task done (--task-id <task_id> | --column backlog|in_progress|review|done) [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` optional single-task target.
- \`--column <value>\` optional bulk target. Allowed values: \`backlog\`, \`in_progress\`, \`review\`, \`done\` (\`trash\` is also accepted).
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added.

Notes:
- Provide exactly one of \`--task-id\` or \`--column\`.
- \`task done --column done\` is a no-op for tasks already in done.`;
}

/**
 * Builds the In-Place `task delete` CLI reference section. Reworded so it does
 * not mention worktree cleanup.
 */
export function renderInPlaceTaskDeleteSection(kanbanCommand: string): string {
	return `## task delete

Purpose: permanently delete a task or every task in a column, removing cards and dependency links.

Command:
\`${kanbanCommand} task delete (--task-id <task_id> | --column backlog|in_progress|review|done) [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` optional single-task target.
- \`--column <value>\` optional bulk target. Allowed values: \`backlog\`, \`in_progress\`, \`review\`, \`done\` (\`trash\` is also accepted).
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added.

Notes:
- Provide exactly one of \`--task-id\` or \`--column\`.
- \`task delete --column done\` is the way to clear the done column.`;
}

/**
 * Builds the In-Place `task start` CLI reference section. Reworded so it does
 * not mention ensuring a worktree.
 */
export function renderInPlaceTaskStartSection(kanbanCommand: string): string {
	return `## task start

Purpose: start a task by launching its agent session in the shared project folder and moving it to \`in_progress\`.

Command:
\`${kanbanCommand} task start --task-id <task_id> [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` required task ID.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added.`;
}
