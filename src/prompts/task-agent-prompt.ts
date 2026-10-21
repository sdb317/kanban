/**
 * In-Place Mode task agent prompt.
 *
 * In In-Place Mode (`worktreesEnabled: false`) a task agent runs directly in
 * the shared Project folder rather than in a dedicated git worktree. This
 * prompt tells the agent where it is working, which git commands it must not
 * run, and that it is sharing the folder with other agents and the user.
 *
 * The prohibition list is the only place that may name the restricted git
 * operations. Everything outside that list must avoid mentioning worktrees,
 * detached HEAD, commits, or pull requests (Req 11.4).
 */
export function renderInPlaceTaskAgentPrompt(projectPath: string): string {
	return `# Kanban Task Agent

You are working directly in the shared project folder at:
\`${projectPath}\`

This is the real working copy, not an isolated copy. Your file edits apply immediately to this folder.

# Do not run these git commands

Kanban manages version control for this project. Do not run any of the following git commands:

- \`git commit\`
- \`git push\`
- \`git branch\`
- \`git checkout\`
- \`git stash\`
- \`git reset\`
- \`git worktree\`

Focus on the task's file changes and leave git state management to the user.

# Shared folder

Other agents and the user may be editing files in this same project folder at the same time as you. Expect files to change underneath you, and keep your changes scoped to the task you were given.
`;
}
