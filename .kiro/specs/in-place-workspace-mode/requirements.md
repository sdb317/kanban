# Requirements Document

## Introduction

Kanban currently gives every task card its own git worktree under `~/.cline/worktrees/`, mirrors gitignored paths into it via symlinks, records per-turn checkpoint refs, and finishes work through Commit / Open PR actions (manual or automatic). This is complex and error-prone.

This feature introduces a boolean `worktreesEnabled` setting. The new default, `false`, selects In-Place Mode: every task agent runs directly in the project folder, and agents create, update, and delete files and folders in the current working copy, with no worktrees, branches, checkpoints, commits, or pull requests. Setting `worktreesEnabled` to `true` selects Worktree Mode, which keeps the existing behavior.

The tRPC API between the web UI and the runtime keeps its current shape. Endpoints that have no meaning in In-Place Mode become no-ops that return well-formed success responses. Version conflicts between concurrently running agents, or between agents and the user, are the user's responsibility. Any additional state is persisted under the `.cline/kanban` folder.

Decisions captured from clarification:

- Worktree usage is a single boolean setting, `worktreesEnabled`, with no separate "in-place" mode value. `false` (the default) means In-Place behavior; `true` means Worktree behavior.
- The setting has a global value with an optional per-project override.
- The setting is exposed in the web UI settings dialog (a "Use git worktrees" toggle, off by default, plus a per-project override) and in the config files.
- When worktrees are disabled, diff views and turn checkpoints are dropped entirely.
- When worktrees are disabled, Commit / Open PR actions are hidden and auto-review is disabled.
- When worktrees are disabled, all git UI (git history, branch switching, fetch/pull/push, discard) is hidden.
- When worktrees are disabled, non-git folders are accepted as projects, the base-branch picker is hidden, and `baseRef` stays in the data model but is ignored.
- Unlimited parallel tasks are allowed when worktrees are disabled.
- Changing the setting does not migrate or delete existing worktrees.
- Agent prompts are adjusted when worktrees are disabled.

## Glossary

- **Runtime**: The Kanban Node backend (`src/`) that serves the tRPC API, manages task sessions, terminals, and workspaces.
- **Web_UI**: The React frontend (`web-ui/`) that talks to the Runtime over tRPC.
- **CLI**: The `kanban` command-line interface (`src/commands/`), including `kanban task ...` subcommands.
- **Project**: A folder registered with Kanban as a workspace. Identified by its Project_Path.
- **Project_Path**: The absolute path of a Project's root folder.
- **Worktree_Setting**: The boolean config key `worktreesEnabled` that selects how task workspaces are provisioned. The only valid values are the JSON booleans `true` and `false`.
- **Global_Config**: The file `~/.cline/kanban/config.json`.
- **Project_Config**: The file `<Project_Path>/.cline/kanban/config.json`.
- **Global_Worktree_Setting**: The Worktree_Setting value stored under the `worktreesEnabled` key in Global_Config.
- **Project_Worktree_Override**: An optional Worktree_Setting value stored under the `worktreesEnabled` key in Project_Config.
- **Effective_Worktree_Setting**: The Worktree_Setting value that applies to a Project, resolved from the Project_Worktree_Override, then the Global_Worktree_Setting, then the default `false`.
- **In_Place_Mode**: The behavior that applies while the Effective_Worktree_Setting is `false`. Every task runs with the Project_Path as its working directory.
- **Worktree_Mode**: The behavior that applies while the Effective_Worktree_Setting is `true`. Every task runs in its own git worktree (the current behavior).
- **Setting_Resolver**: The Runtime component that computes the Effective_Worktree_Setting for a Project.
- **Settings_Dialog**: The existing runtime settings dialog in the Web_UI.
- **Task_Workspace_Provider**: The Runtime component that resolves, creates, and deletes the working directory of a task.
- **Task_Working_Directory**: The directory in which a task's agent session and task shell terminals are launched.
- **Task_Worktree**: A git worktree created for a task under `~/.cline/worktrees/`.
- **Worktree_Endpoints**: The tRPC procedures `workspace.ensureWorktree`, `workspace.deleteWorktree`, and `workspace.getTaskContext`.
- **Git_Endpoints**: The tRPC procedures `workspace.getGitSummary` (`loadGitSummary`), `workspace.runGitSyncAction`, `workspace.checkoutGitBranch`, `workspace.discardGitChanges`, `workspace.getGitLog` (`loadGitLog`), `workspace.getGitRefs` (`loadGitRefs`), and `workspace.getCommitDiff` (`loadCommitDiff`).
- **Diff_Endpoints**: The tRPC procedures `workspace.getChanges` (`loadChanges`) and `workspace.getWorkspaceChanges` (`loadWorkspaceChanges`).
- **Turn_Checkpoint**: A hidden git commit stored under `refs/kanban/checkpoints/...` that captures the working tree at the end of an agent turn.
- **Ignored_Path_Mirroring**: The Worktree_Mode behavior that symlinks gitignored paths from the Project into a Task_Worktree and maintains a managed block in `.git/info/exclude`.
- **Task_Patch**: The patch file captured from a Task_Worktree when the task is trashed, used to restore the task later.
- **Git_Action_Controls**: The Web_UI Commit, Open PR, agent-commit, and agent-open-PR controls on task cards and the task detail view.
- **Auto_Review**: The per-task automatic action (`autoReviewEnabled` / `autoReviewMode` of `commit` or `pr`) that runs when a task reaches the review column.
- **Git_UI**: The Web_UI git history view, branch selector and checkout, fetch/pull/push controls, and discard-working-changes control.
- **Diff_UI**: The Web_UI task diff / changes views, including "all changes" and "last turn" modes and line-comment-on-diff.
- **Base_Ref_Picker**: The Web_UI control for choosing a task's base branch (`baseRef`).
- **Task_Agent_Prompt**: The system prompt content and commit/PR prompt templates that the Runtime injects into task agent sessions.
- **Sidebar_Agent_Prompt**: The system prompt the Runtime injects into the Kanban sidebar (board management) agent.

## Requirements

### Requirement 1: Worktree setting and resolution

**User Story:** As a user, I want a global worktree setting with an optional per-project override, so that I can choose in-place or worktree behavior per repository while having a sensible default.

#### Acceptance Criteria

1. THE Runtime SHALL accept exactly two Worktree_Setting values, the JSON booleans `true` and `false`, stored under the `worktreesEnabled` key.
2. THE Runtime SHALL persist the Global_Worktree_Setting in Global_Config.
3. THE Runtime SHALL persist the Project_Worktree_Override in the Project_Config of the Project it applies to, and SHALL NOT write a Project_Worktree_Override into Global_Config or into the Project_Config of any other Project.
4. IF the Project_Config of a Project contains a valid Project_Worktree_Override, THEN THE Setting_Resolver SHALL return the Project_Worktree_Override as the Effective_Worktree_Setting, regardless of the Global_Worktree_Setting value.
5. IF the Project_Config of a Project contains no valid Project_Worktree_Override and Global_Config contains a valid Global_Worktree_Setting, THEN THE Setting_Resolver SHALL return the Global_Worktree_Setting as the Effective_Worktree_Setting.
6. IF neither a valid Project_Worktree_Override nor a valid Global_Worktree_Setting is present, including the case where Global_Config or Project_Config does not exist or does not contain the `worktreesEnabled` key, THEN THE Setting_Resolver SHALL return `false` as the Effective_Worktree_Setting without returning an error.
7. IF Global_Config or Project_Config contains a `worktreesEnabled` value that is not a JSON boolean (including the strings `"true"` and `"false"`, numbers such as `0` and `1`, `null`, objects, and arrays), THEN THE Setting_Resolver SHALL treat that value as unset, continue resolution with the next source in the order Project_Worktree_Override, Global_Worktree_Setting, default `false`, and leave the config file contents unchanged.
8. WHEN the Runtime config is loaded for a Project, THE Runtime SHALL include in the config response returned to the Web_UI the Global_Worktree_Setting (or an unset indication when no valid value is stored), the Project_Worktree_Override (or an unset indication when no valid value is stored), and the Effective_Worktree_Setting, which SHALL always be a boolean.
9. WHEN Global_Config is written while the Global_Worktree_Setting equals `false` and the `worktreesEnabled` key was absent from Global_Config before the write, THE Runtime SHALL omit the `worktreesEnabled` key from Global_Config.
10. FOR ALL valid Worktree_Setting configurations (each of Global_Worktree_Setting and Project_Worktree_Override being `true`, `false`, or unset), saving the configuration and then loading the configuration SHALL produce the same Global_Worktree_Setting, Project_Worktree_Override, and Effective_Worktree_Setting (round-trip property).
11. IF a request to save configuration specifies a Global_Worktree_Setting or Project_Worktree_Override value that is not a boolean, THEN THE Runtime SHALL reject the request with an error indicating an invalid `worktreesEnabled` value and SHALL leave both Global_Config and Project_Config unchanged.
12. WHEN a request to save configuration clears the Project_Worktree_Override of a Project, THE Runtime SHALL remove the `worktreesEnabled` key from that Project's Project_Config, and THE Setting_Resolver SHALL resolve the Effective_Worktree_Setting for that Project from the Global_Worktree_Setting or the default `false`.
13. WHEN a request to save a Global_Worktree_Setting or Project_Worktree_Override succeeds, THE Runtime SHALL return the new Effective_Worktree_Setting in every subsequent config response for the affected Projects without requiring a Runtime restart.

### Requirement 2: Worktree setting in the settings dialog

**User Story:** As a user, I want to turn git worktrees on or off from the settings dialog, so that I do not need to edit JSON by hand.

#### Acceptance Criteria

1. WHEN the Settings_Dialog is opened, THE Settings_Dialog SHALL display a "Use git worktrees" toggle for the Global_Worktree_Setting, shown as on when the Global_Worktree_Setting from the config response is `true` and shown as off when the Global_Worktree_Setting is `false` or unset.
2. WHILE a Project is selected, WHEN the Settings_Dialog is opened, THE Settings_Dialog SHALL display a single-selection control for the Project_Worktree_Override with exactly three options, Use global default, Off (in-place), and On (worktrees), with Off (in-place) pre-selected when the Project_Worktree_Override is `false`, On (worktrees) pre-selected when the Project_Worktree_Override is `true`, and Use global default pre-selected when the Project_Worktree_Override is unset.
3. WHILE no Project is selected, THE Settings_Dialog SHALL hide the Project_Worktree_Override control and display only the "Use git worktrees" toggle.
4. WHEN the user saves the Settings_Dialog with a Global_Worktree_Setting or Project_Worktree_Override selection that differs from the value loaded when the dialog was opened, THE Web_UI SHALL send the changed value through the existing config save procedure, sending the toggle state as a boolean Global_Worktree_Setting, Off (in-place) as `false`, On (worktrees) as `true`, and Use global default as an unset Project_Worktree_Override.
5. WHEN the user closes the Settings_Dialog without saving, THE Web_UI SHALL discard the unsaved Worktree_Setting selections and leave the Global_Worktree_Setting, the Project_Worktree_Override, and the Effective_Worktree_Setting unchanged.
6. WHEN a config save that changes the Effective_Worktree_Setting of the current Project succeeds, THE Web_UI SHALL show or hide the setting-dependent UI of Requirements 7 to 10 according to the new Effective_Worktree_Setting within 2 seconds and without a page reload.
7. IF a save would make the Effective_Worktree_Setting `true` for the current Project and that Project's Project_Path is not a git repository, whether through the Project_Worktree_Override or through the Global_Worktree_Setting while the override is Use global default, THEN THE Runtime SHALL reject the save without writing Global_Config or Project_Config, and THE Web_UI SHALL display an error message stating that git worktrees require a git repository.
8. IF the config save procedure fails for any reason, THEN THE Web_UI SHALL keep the Settings_Dialog open with the user's unsaved selections intact, display an error message indicating the save failed, and keep the previously active Effective_Worktree_Setting for all setting-dependent UI.

### Requirement 3: Task working directory in In-Place Mode

**User Story:** As a user, I want agents to edit files directly in my project folder, so that changes appear in my working copy without worktree indirection.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, THE Task_Workspace_Provider SHALL resolve the Task_Working_Directory of every task started while that setting is in effect to the Project_Path, including tasks that already have a Task_Worktree from an earlier Worktree_Mode run.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN a task agent session is started or resumed from the Web_UI or the CLI, THE Runtime SHALL launch the task agent session with the Project_Path as its working directory.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task shell terminal is opened from the Web_UI, THE Runtime SHALL launch the shell with the Project_Path as its working directory.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is started, THE Task_Workspace_Provider SHALL start the task without creating a Task_Worktree, without creating or switching a git branch, and without creating any directory under `~/.cline/worktrees/`.
5. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is started, THE Task_Workspace_Provider SHALL start the task without performing Ignored_Path_Mirroring, without creating symlinks in the Project_Path, and without modifying `.git/info/exclude`.
6. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is started while one or more other tasks of the same Project are running, THE Runtime SHALL start the task with no Runtime-imposed limit on the number of concurrently running tasks per Project_Path, such that starting at least 10 tasks concurrently in the same Project_Path results in 10 running task sessions.
7. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is started, THE Runtime SHALL start the task without inspecting or validating the task's `baseRef`, including when the `baseRef` is empty or names a branch that does not exist in the Project.
8. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is started in a Project whose Project_Path is not a git repository or has uncommitted changes, THE Runtime SHALL start the task with the Project_Path as its Task_Working_Directory without running any git command and without reporting an error about git state.
9. IF the Project_Path does not exist or is not a directory when a task is started in In_Place_Mode, THEN THE Runtime SHALL refuse to start the task agent session, SHALL return an error indicating that the project folder is unavailable to the Web_UI or the CLI caller, and SHALL leave the task card in the column it occupied before the start attempt.

### Requirement 4: Task completion, trash, and deletion in In-Place Mode

**User Story:** As a user, I want moving a task to Done or deleting it to require minimal cleanup, so that my working copy is left exactly as the agent left it.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved to the trash column (displayed as Done) from the Web_UI or the CLI (`task trash` / `task done`), THE Runtime SHALL stop that task's agent session and that task's shell terminals, and SHALL create, modify, or delete no file or folder in the Project_Path outside `<Project_Path>/.cline/kanban`.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is permanently deleted from the Web_UI (single delete or clear-trash) or the CLI, THE Runtime SHALL stop any running agent session and shell terminals of that task, remove the task card from the board, and remove every dependency link in which that task is either endpoint, and SHALL create, modify, or delete no file or folder in the Project_Path outside `<Project_Path>/.cline/kanban`.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved to trash or permanently deleted, THE Task_Workspace_Provider SHALL complete the operation without capturing a Task_Patch, without removing any Task_Worktree, and without running any git command against the Project_Path.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved from the review column to the trash column, THE Runtime SHALL auto-start every task in the backlog column that has a dependency link to the trashed task, with each started task using the Project_Path as its Task_Working_Directory, matching the Worktree_Mode linked-task selection rules.
5. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved to the trash column from the backlog or in-progress column, THE Runtime SHALL auto-start no linked backlog tasks, matching the Worktree_Mode behavior.
6. WHILE the Effective_Worktree_Setting is `false`, WHEN a trashed task is restored from the trash column, THE Runtime SHALL move the task card to the review column and resume the task's agent session with the Project_Path as its Task_Working_Directory, without creating a Task_Worktree and without applying a Task_Patch.
7. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved to trash, permanently deleted, or restored, THE Runtime SHALL leave the agent sessions and shell terminals of every other task in the same Project running and unchanged.

### Requirement 5: API compatibility and no-op endpoints

**User Story:** As a developer, I want the tRPC API to keep its current shape, so that the Web_UI, CLI, and existing clients keep working with worktrees enabled or disabled.

#### Acceptance Criteria

1. THE Runtime SHALL expose the same tRPC procedure names, input schemas, and response schemas in In_Place_Mode and Worktree_Mode, with exactly two schema changes from the current API: the Worktree_Setting fields of Requirement 1 added to the config schemas, and the `baseCommit` field of the `workspace.ensureWorktree` `ok: true` response widened to accept a string or null, where Worktree_Mode continues to return a string for `baseCommit`; and every In_Place_Mode response of criteria 2 to 6 SHALL validate against the response schema of its procedure as amended by these two changes.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN `workspace.ensureWorktree` is called, THE Runtime SHALL return `ok: true` with `path` set to the Project_Path, `baseRef` set to the requested `baseRef`, and `baseCommit` set to null, without creating any file, directory, git branch, or Task_Worktree.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN `workspace.deleteWorktree` is called, THE Runtime SHALL return `ok: true` with `removed: false`, without deleting or modifying any file or directory, including any existing Task_Worktree or Task_Patch.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN `workspace.getTaskContext` is called, THE Runtime SHALL return `path` set to the Project_Path, `exists: true`, `baseRef` set to the requested `baseRef`, `branch: null`, `isDetached: false`, and `headCommit: null`.
5. WHILE the Effective_Worktree_Setting is `false`, WHEN any Diff_Endpoint is called, THE Runtime SHALL return a changes response with `repoRoot` set to the Project_Path, `generatedAt` set to the response time in epoch milliseconds, and `files` set to an empty list.
6. WHILE the Effective_Worktree_Setting is `false`, WHEN any Git_Endpoint is called, THE Runtime SHALL return a response with `ok: true`, no `error` field, every list field set to an empty list, every numeric count field set to 0, every nullable field set to null, and every required string field set to the corresponding request value or, if the request has no corresponding value, an empty string.
7. WHILE the Effective_Worktree_Setting is `false`, WHEN any Worktree_Endpoint, Diff_Endpoint, or Git_Endpoint is called, THE Runtime SHALL return the response without spawning any git process and without modifying any file in the Project_Path, including when the call is `workspace.runGitSyncAction`, `workspace.checkoutGitBranch`, or `workspace.discardGitChanges`.
8. WHILE the Effective_Worktree_Setting is `false`, WHEN a Worktree_Endpoint, Diff_Endpoint, or Git_Endpoint is called for a Project_Path that is not a git repository, THE Runtime SHALL return the response defined in criteria 2 to 6 of this requirement.
9. WHEN a Worktree_Endpoint, Diff_Endpoint, or Git_Endpoint is called, THE Runtime SHALL select the In_Place_Mode or Worktree_Mode behavior using the Effective_Worktree_Setting of the target Project at the time of that call.
10. IF a Worktree_Endpoint, Diff_Endpoint, or Git_Endpoint receives input that fails its existing input schema, THEN THE Runtime SHALL reject the call with the same validation error behavior in In_Place_Mode as in Worktree_Mode.
11. WHILE the Effective_Worktree_Setting is `true`, THE Runtime SHALL process every Worktree_Endpoint, Diff_Endpoint, and Git_Endpoint with the current Worktree_Mode behavior.

### Requirement 6: Turn checkpoints in In-Place Mode

**User Story:** As a user, I want In-Place Mode to leave no hidden git objects behind, so that my repository is untouched by Kanban bookkeeping.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, WHEN an agent turn completes (through a runtime hook transition to the review column, a native Cline agent turn end, or a task session stop), THE Runtime SHALL apply the same task session state transition as in Worktree_Mode and SHALL create no Turn_Checkpoint, so that the number of refs under `refs/kanban/checkpoints/` in the Project repository is identical before and after the turn.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN an agent turn completes, THE Runtime SHALL run zero git commands for checkpoint capture or for deletion of stale Turn_Checkpoint refs.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task session starts or an agent turn completes, THE Runtime SHALL set `latestTurnCheckpoint` and `previousTurnCheckpoint` to null in the task session summary returned by the Runtime and broadcast to the Web_UI, including for tasks whose summary held Turn_Checkpoint values recorded earlier in Worktree_Mode.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is moved to trash or permanently deleted from the Web_UI or the CLI, THE Runtime SHALL complete the operation without running any git command that deletes Turn_Checkpoint refs, and SHALL leave every existing ref under `refs/kanban/checkpoints/` unchanged, including refs created earlier in Worktree_Mode.
5. IF the Effective_Worktree_Setting is `false` and the Project_Path is not a git repository, THEN THE Runtime SHALL complete every agent turn, trash operation, and delete operation without reporting a checkpoint-related error or warning in the task session summary or in the Web_UI.

### Requirement 7: Commit, Open PR, and Auto-Review in In-Place Mode

**User Story:** As a user, I want commit and pull-request features removed in In-Place Mode, so that Kanban never commits or pushes on my behalf.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL render zero Git_Action_Controls on task cards in every board column and zero Git_Action_Controls in the task detail view, including any keyboard shortcuts or context-menu entries that trigger a commit or open-PR action.
2. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL render zero Auto_Review controls (the auto-review toggle and the commit/PR mode selector) in the task create dialog and the task edit dialog.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task moves into the review column, THE Web_UI SHALL leave the task in the review column, run no commit or open-PR action, start no agent commit or PR prompt, and leave the task's column unchanged for any task whose stored `autoReviewEnabled` value is `true`.
4. WHILE the Effective_Worktree_Setting is `false`, THE Runtime and THE Web_UI SHALL keep each task's stored `autoReviewEnabled` and `autoReviewMode` values identical to their values before the task entered the review column, before it was moved to trash, and before it was restored from trash.
5. WHILE the Effective_Worktree_Setting is `false`, WHEN the CLI receives `--auto-review-enabled` or `--auto-review-mode` with a valid value on `task create` or `task update`, THE CLI SHALL store the provided values on the task and exit with a success status.
6. WHILE the Effective_Worktree_Setting is `false`, WHEN a task whose stored `autoReviewEnabled` value is `true` moves into the review column, THE Runtime SHALL create no git commit, push no branch, and open no pull request for that task.
7. WHILE the Effective_Worktree_Setting is `false`, THE Settings_Dialog SHALL render neither the commit prompt template editor nor the open-PR prompt template editor, and THE Runtime SHALL keep the stored commit and open-PR prompt template values unchanged when the Settings_Dialog is saved.
8. WHEN the Effective_Worktree_Setting of a Project changes from `false` to `true`, THE Web_UI SHALL run no Auto_Review action for tasks that were already in the review column at the time of the change, and SHALL apply Auto_Review only to tasks that move into the review column after the change.

### Requirement 8: Git UI in In-Place Mode

**User Story:** As a user, I want git controls hidden in In-Place Mode, so that the interface reflects that Kanban is not managing git.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL not render any Git_UI element (git history view, branch selector, branch checkout, fetch, pull, push, and discard-working-changes controls) on the board view, the home view, or the task detail view; a disabled or visually hidden element that remains in the rendered page counts as a failure.
2. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL not render the top bar git history toggle, the current branch label, or the working-copy addition and deletion counts.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN the user presses the keyboard shortcut that toggles the git history view in Worktree_Mode, THE Web_UI SHALL leave the current view unchanged and open no Git_UI element.
4. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL issue zero calls to Git_Endpoints, including periodic polling and calls triggered by document visibility changes, project switches, or task detail opening.
5. WHILE the Effective_Worktree_Setting is `true`, THE Web_UI SHALL render the Git_UI, the top bar git history toggle, the current branch label, and the working-copy change counts, SHALL enable the git history keyboard shortcut, and SHALL poll Git_Endpoints with the current Worktree_Mode behavior.
6. IF the git history view is open when the Effective_Worktree_Setting of the current Project changes from `true` to `false`, THEN THE Web_UI SHALL close the git history view and show the view that was underneath it (board, home, or task detail), with no page reload and with board and task state kept.
7. WHEN the Effective_Worktree_Setting of the current Project changes from `false` to `true`, THE Web_UI SHALL render the Git_UI entry points from criterion 5 and SHALL start calling Git_Endpoints, with no page reload.

### Requirement 9: Diff and review UI in In-Place Mode

**User Story:** As a user, I want diff views removed in In-Place Mode, so that I review changes with my own tools without misleading per-task diffs.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL omit the Diff_UI from the task detail view: the "all changes" and "last turn" diff modes, the changed-files list, the line-comment-on-diff controls, and every control that opens one of them are not rendered, cannot get keyboard focus, and are not reachable through any keyboard shortcut.
2. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL omit changed-file counts, added/removed line counts, and diff summaries from every task card in every board column.
3. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL send zero requests to the Diff_Endpoints for that Project, both on a polling interval and in response to task state changes, task selection, or opening the task detail view.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN the user opens a task's detail view, THE Web_UI SHALL show the task's agent terminal (for CLI agents) or chat view (for the native Cline agent) in the area the Diff_UI would otherwise occupy, with no empty placeholder left in place of the Diff_UI.
5. WHEN the Effective_Worktree_Setting of the open Project changes between `false` and `true`, THE Web_UI SHALL apply the visibility rules of criteria 1, 2, 4, and 6 and start or stop Diff_Endpoint requests within 2 seconds of the change being saved, without a page reload and without ending any running task agent session.
6. WHILE the Effective_Worktree_Setting is `true`, THE Web_UI SHALL show the Diff_UI, task card diff summaries, and Diff_Endpoint polling with the current behavior.
7. IF a Diff_Endpoint receives a request for a Project whose Effective_Worktree_Setting is `false`, THEN THE Runtime SHALL return a well-formed success response with an empty set of changes and leave every file in the Project_Path unchanged.

### Requirement 10: Base branch and non-git projects in In-Place Mode

**User Story:** As a user, I want to use Kanban on folders that are not git repositories, so that In-Place Mode works without any git setup.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, THE Web_UI SHALL hide the Base_Ref_Picker in the task create dialog and the task edit dialog, and SHALL submit those dialogs without requiring a `baseRef` selection.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is created from the Web_UI or the CLI with a caller-supplied `baseRef`, THE Runtime SHALL store the supplied `baseRef` string unchanged and without validating it against git branches.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task is created from the Web_UI or the CLI without a caller-supplied `baseRef`, THE Runtime SHALL store the name of the Project's currently checked-out git branch as the `baseRef` if the Project_Path is a git repository with a checked-out branch, and SHALL store an empty string as the `baseRef` otherwise (non-git folder, detached HEAD, or failed branch lookup).
4. WHILE the Global_Worktree_Setting resolves to `false` (stored as `false` or unset), WHEN the user adds a folder that is not a git repository as a Project from the Web_UI, THE Runtime SHALL register the Project without displaying a git initialization prompt and without creating a `.git` directory in the Project_Path.
5. WHILE the Global_Worktree_Setting is `true`, WHEN the user adds a folder that is not a git repository as a Project, THE Runtime SHALL keep the current git initialization prompt behavior, and SHALL not register the Project if the user declines git initialization.
6. WHILE the Global_Worktree_Setting resolves to `false` (stored as `false` or unset), WHEN the CLI is launched with a current working directory that is not a git repository, THE CLI SHALL start the Runtime and register that directory as a Project with its absolute path as the Project_Path, without exiting with a git-related error.
7. WHILE the Global_Worktree_Setting is `true`, WHEN the CLI is launched with a current working directory that is not a git repository, THE CLI SHALL keep the current non-git launch behavior.
8. WHILE the Effective_Worktree_Setting is `false`, WHEN `task create` runs with or without `--base-ref` in a Project whose Project_Path is not a git repository, THE CLI SHALL create the task, exit with status code 0, and print no git branch lookup error.
9. WHILE the Effective_Worktree_Setting is `false` and the Project_Path is not a git repository, WHEN the Web_UI loads the Project board, THE Web_UI SHALL display the board without showing any git-related error notification or error state.
10. IF a folder being added as a Project does not exist or is not readable, THEN THE Runtime SHALL reject the registration, leave the Project list unchanged, and return an error indicating the folder is inaccessible, regardless of the Effective_Worktree_Setting.

### Requirement 11: Agent prompts in In-Place Mode

**User Story:** As a user, I want agents told they share my working copy, so that they do not run git operations or assume an isolated worktree.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `false`, WHEN a task agent session starts, THE Runtime SHALL inject a Task_Agent_Prompt that states the agent works directly in the shared Project folder and includes the absolute path of that Project folder.
2. WHILE the Effective_Worktree_Setting is `false`, WHEN a task agent session starts, THE Runtime SHALL inject a Task_Agent_Prompt that instructs the agent to refrain from running each of the following git commands: commit, push, branch, checkout, stash, reset, and worktree.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task agent session starts, THE Runtime SHALL inject a Task_Agent_Prompt that states other agents and the user may be editing files in the same Project folder concurrently.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN a task agent session starts, THE Runtime SHALL inject a Task_Agent_Prompt that contains no instruction to create, use, or reference a worktree, operate on a detached HEAD, create a commit, or open a pull request; the prohibition list in criterion 2 is the only permitted mention of these git operations.
5. WHILE the Effective_Worktree_Setting is `false`, WHEN the Kanban sidebar agent session starts for a Project, THE Runtime SHALL inject a Sidebar_Agent_Prompt that describes tasks as running in the shared Project folder and contains no worktree, auto-commit, auto-PR, or `--base-ref` guidance.
6. WHILE the Effective_Worktree_Setting is `true`, WHEN a task agent session or Kanban sidebar agent session starts, THE Runtime SHALL inject Task_Agent_Prompt and Sidebar_Agent_Prompt content identical to the content injected before the Worktree_Setting feature existed.
7. WHILE the Effective_Worktree_Setting is `false`, THE Runtime SHALL withhold the commit and pull request prompt templates of the Task_Agent_Prompt from task agent sessions of that Project.
8. WHEN a task agent session or Kanban sidebar agent session starts, THE Runtime SHALL select the prompt variant using the Effective_Worktree_Setting resolved by the Setting_Resolver for that session's Project at session start time.
9. IF the Effective_Worktree_Setting of a Project changes while a task agent session or Kanban sidebar agent session of that Project is running, THEN THE Runtime SHALL leave the prompt of the running session unchanged and SHALL apply the prompt variant of the new Effective_Worktree_Setting to the next session started for that Project.

### Requirement 12: Changing the worktree setting with existing worktrees

**User Story:** As a user, I want turning worktrees on or off to be safe, so that I never lose work stored in existing worktrees.

#### Acceptance Criteria

1. WHEN the Effective_Worktree_Setting of a Project changes because the Global_Worktree_Setting or the Project_Worktree_Override is saved with a different value, THE Runtime SHALL leave every existing Task_Worktree directory (including all file contents and its checked-out branch or detached HEAD), every Task_Patch file, and every Turn_Checkpoint ref for that Project unchanged, with no file, directory, branch, or ref created, modified, or deleted as a result of the change.
2. WHEN the Effective_Worktree_Setting of a Project changes, THE Runtime SHALL resolve the Task_Working_Directory of every task session started, restarted, or resumed after the change using the new Effective_Worktree_Setting, including tasks that were previously started under the other Effective_Worktree_Setting value.
3. WHILE the Effective_Worktree_Setting is `false`, WHEN a task that has an existing Task_Worktree is started, restarted, or resumed, THE Runtime SHALL launch the task agent session and task shell terminals with the Project_Path as their working directory and SHALL leave the existing Task_Worktree unchanged.
4. WHILE the Effective_Worktree_Setting is `false`, WHEN a task that has an existing Task_Worktree or Task_Patch is moved to trash, restored from trash, or permanently deleted, THE Runtime SHALL leave that Task_Worktree, its Task_Patch files, and its Turn_Checkpoint refs unchanged.
5. WHILE the Effective_Worktree_Setting is `true`, WHEN a task that has an existing Task_Worktree is moved to trash or permanently deleted, THE Runtime SHALL capture the Task_Patch and remove that Task_Worktree with the current Worktree_Mode behavior, regardless of the Effective_Worktree_Setting that was in effect when the Task_Worktree was created.
6. IF the Effective_Worktree_Setting is `true` and a task that has no Task_Worktree (for example, a task that only ran in In_Place_Mode) is moved to trash or permanently deleted, THEN THE Runtime SHALL complete the trash or delete operation successfully without capturing a Task_Patch and without returning an error for the missing Task_Worktree.
7. WHILE the Effective_Worktree_Setting is `true`, WHEN a trashed task that has a Task_Patch captured before a setting change is restored, THE Runtime SHALL restore the task's Task_Worktree and apply the Task_Patch with the current Worktree_Mode behavior.
8. WHEN the Effective_Worktree_Setting of a Project changes while a task session is running, THE Runtime SHALL keep that session and its open task shell terminals running in their current Task_Working_Directory until the session stops, and SHALL apply the new Effective_Worktree_Setting only when that task's session is next started.

### Requirement 13: Worktree Mode preservation

**User Story:** As a user who relies on isolated worktrees, I want Worktree Mode to behave exactly as today, so that enabling worktrees restores the full git workflow.

#### Acceptance Criteria

1. WHILE the Effective_Worktree_Setting is `true`, WHEN a task is started from the Web_UI or the CLI, THE Task_Workspace_Provider SHALL either create a Task_Worktree under `~/.cline/worktrees/` from the task's `baseRef` or reuse that task's existing Task_Worktree, and THE Runtime SHALL launch the task agent session and task shell terminals with that Task_Worktree as the Task_Working_Directory, matching the Kanban release before this feature.
2. WHILE the Effective_Worktree_Setting is `true`, WHEN a Task_Worktree is created or reused, THE Task_Workspace_Provider SHALL perform Ignored_Path_Mirroring, producing the same symlinks and the same managed `.git/info/exclude` block as the Kanban release before this feature.
3. WHILE the Effective_Worktree_Setting is `true`, WHEN an agent turn completes, THE Runtime SHALL create a Turn_Checkpoint and report non-null `latestTurnCheckpoint` values in the task session summary, matching the Kanban release before this feature.
4. WHILE the Effective_Worktree_Setting is `true`, THE Web_UI SHALL display each of the following, matching the Kanban release before this feature: the Git_Action_Controls, the Auto_Review controls, the Git_UI, the Diff_UI, and the Base_Ref_Picker.
5. WHILE the Effective_Worktree_Setting is `true`, WHEN a task whose stored `autoReviewEnabled` value is true reaches the review column, THE Runtime SHALL run the commit or PR action selected by the task's stored `autoReviewMode`. This also applies when those values were stored while the Effective_Worktree_Setting was `false`.
6. WHILE the Effective_Worktree_Setting is `true`, WHEN a task that has a Task_Worktree is moved to trash, THE Runtime SHALL capture a Task_Patch before deleting the Task_Worktree. WHEN that task is later restored to the board, THE Runtime SHALL apply that Task_Patch to the recreated Task_Worktree, matching the Kanban release before this feature.
7. WHILE the Effective_Worktree_Setting is `true`, IF a task is started and its stored `baseRef` does not resolve to a ref in the Project's git repository (including a `baseRef` stored while the Effective_Worktree_Setting was `false`), THEN THE Runtime SHALL report an error identifying the unresolved `baseRef`, create no Task_Worktree, and leave the task in its current column with its stored fields unchanged.

### Requirement 14: State persistence

**User Story:** As a user, I want any Kanban bookkeeping for this feature kept in Kanban's own folder, so that my project files stay clean.

#### Acceptance Criteria

1. THE Runtime SHALL store all persisted state introduced by this feature only in Global_Config, in Project_Config, in other files under `~/.cline/kanban`, or in other files under `<Project_Path>/.cline/kanban`.
2. WHILE the Effective_Worktree_Setting is `false`, THE Runtime SHALL create, modify, rename, or delete no file or directory inside the Project_Path outside `<Project_Path>/.cline/kanban`, where this restriction covers file operations performed by the Runtime itself and excludes file operations performed by task agent sessions or by commands the user runs in task shell terminals.
3. WHILE the Effective_Worktree_Setting is `false`, THE Runtime SHALL create, modify, or delete no file under `<Project_Path>/.git`, including refs, objects, the index, and `.git/info/exclude`.
4. WHEN the Runtime writes Project_Config and the `<Project_Path>/.cline/kanban` folder does not exist, THE Runtime SHALL create that folder and write Project_Config inside it, and SHALL create no other file or folder in the Project_Path as part of that write.
5. IF writing Global_Config or Project_Config fails, THEN THE Runtime SHALL reject the config save with an error response indicating the persistence failure, SHALL leave the previous content of that config file unchanged, and SHALL keep the Effective_Worktree_Setting that was in effect before the save.

### Requirement 15: Test suite compatibility

**User Story:** As a developer, I want the existing test suites to keep passing, so that the new default does not regress existing behavior.

#### Acceptance Criteria

1. WHEN `npm run check` and `npm run web:test` are each run once against the implemented feature, THE test suites SHALL exit with code 0 and report zero failing tests.
2. THE test suites SHALL contain every test that existed before this feature was implemented, and no test that previously ran SHALL be removed, renamed to skip, or marked as skipped or todo.
3. THE tests that exercise Task_Worktree, Turn_Checkpoint, Task_Patch, Ignored_Path_Mirroring, commit, pull request, Git_UI, or Diff_UI behavior SHALL explicitly set the Worktree_Setting to `true` in their own setup, without relying on the default value, and SHALL pass with their assertions unchanged from before this feature was implemented.
4. THE test suite SHALL include at least one test per case for the Setting_Resolver and persistence rules of Requirement 1: a valid Project_Worktree_Override takes precedence over a Global_Worktree_Setting, covering both an override of `false` over a global `true` and an override of `true` over a global `false` (criterion 4); a valid Global_Worktree_Setting applies when no valid Project_Worktree_Override is set (criterion 5); `false` is returned when neither is set, including when a config file or the `worktreesEnabled` key is missing (criterion 6); a non-boolean `worktreesEnabled` value in either config file, including the strings `"true"` and `"false"`, numbers, and `null`, is treated as unset and resolution continues with the next source (criterion 7); the `worktreesEnabled` key is omitted from Global_Config when Global_Config is written with the Global_Worktree_Setting `false` and the key was absent before the write (criterion 9); a save with a non-boolean value is rejected (criterion 11); and clearing the Project_Worktree_Override removes the key from Project_Config (criterion 12).
5. THE test suite SHALL include at least one test per criterion for the In_Place_Mode responses of Requirement 5 criteria 2 to 6, asserting each response field value defined in those criteria and asserting that no git command is run for Git_Endpoint calls.
6. THE test suite SHALL include at least one test that calls a Worktree_Endpoint, a Diff_Endpoint, and a Git_Endpoint in In_Place_Mode for a Project_Path that is not a git repository and asserts the responses defined in Requirement 5 criterion 8.
7. THE test suite SHALL include tests that verify that, in In_Place_Mode, task start, move to trash, and permanent delete each leave the Project_Path with the same set of file and directory paths and byte-identical file contents as before the operation, leave `.git/info/exclude` unchanged, create no new git branch, and create no directory under `~/.cline/worktrees/`.
8. THE tests added for this feature SHALL use a temporary directory as the home directory and as the Project_Path, so that running the test suites creates, modifies, or deletes no file in the developer's real Global_Config or `~/.cline/worktrees/`.
