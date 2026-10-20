# Product

**Kanban** (`npx kanban`) is a kanban foundation for running many coding agents in parallel. It is a research preview by Cline that serves as a lightweight replacement for an IDE when orchestrating autonomous agent work and reviewing diffs.

## Core idea

Each task card on the board gets its own terminal and git worktree, created and managed automatically. Agents run in isolated worktrees so they work in parallel without merge conflicts. Gitignored files (e.g. `node_modules`) are symlinked into each worktree to avoid repeated installs.

## Key features

- **Task cards with worktrees** — hit play on a card to spin up an ephemeral worktree and agent session; resume later via tracked resume IDs.
- **Linking & automation** — link cards into dependency chains. With auto-commit/auto-PR, a completed card commits and auto-starts linked tasks for end-to-end autonomy.
- **Agent monitoring** — runtime hooks surface each agent's latest message/tool call on its card, so hundreds of agents can be watched at a glance.
- **Review** — per-card TUI plus a worktree diff and a built-in checkpointing system; click lines to leave comments that go back to the agent.
- **Ship** — Commit or Open PR converts a worktree into a commit or PR branch, resolving conflicts intelligently.
- **Git interface** — browse history, switch branches, fetch/pull/push without leaving Kanban.

## Important notes

- Runs locally from the root of any git repo; launches a local web server in the browser. No account or setup required.
- Detects the user's installed CLI agent (Cline, Claude Code, Codex, Gemini, opencode, etc.). Native Cline agent is powered by `@clinebot/core`.
- Experimental: relies on bypassing agent permissions and runtime hooks for autonomy. Not suitable for repos where gitignored files are actively modified (symlink assumption).
