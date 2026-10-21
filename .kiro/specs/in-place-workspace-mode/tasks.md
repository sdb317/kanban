# Implementation Plan: In-Place Workspace Mode

## Overview

Implement a per-project `worktreesEnabled` setting (global value plus optional project override, default `false`). The plan builds bottom-up: a pure resolver and config persistence first, then git-free workspace identity and pure In-Place response builders, then mode dispatch at every runtime entry point, then prompts and session-start wiring, then the CLI, and finally the web UI gates and settings dialog. Worktree Mode code paths (`task-worktree.ts`, `turn-checkpoints.ts`, `git-sync.ts`, `git-history.ts`, `get-workspace-changes.ts`) are not modified; In-Place behavior lives in new, small modules selected at call time.

All code is TypeScript (strict, Node 22 ESM with `.js` import extensions in `src/`, `@/` alias in `web-ui/`). Validation uses zod, formatting and linting use Biome, tests use Vitest, property tests use fast-check. Web UI work uses Tailwind tokens (dark theme only), Radix primitives, lucide-react, and `react-use` via `@/kanban/utils/react-use`.

Existing tests that exercise worktrees, checkpoints, patches, mirroring, commit/PR, Git UI, or Diff UI are updated only to set `worktreesEnabled: true` explicitly in their setup. Their assertions stay unchanged, and no test is removed, skipped, or marked todo.

## Tasks

- [x] 1. Set up test tooling and baselines
  - [x] 1.1 Add fast-check as an exact-pinned devDependency
    - Run `npm install --save-dev --save-exact fast-check` in the repo root and in `web-ui/`, using the current 4.x release
    - Confirm `package.json` and `web-ui/package.json` list an exact version (no `^` or `~`) and lockfiles are updated
    - _Requirements: 15.4, 15.5_

  - [x] 1.2 Create temp-home and worktree-mode test helpers
    - Create `test/utilities/temp-kanban-home.ts` with `withTempKanbanHome()` (temp dir used as `HOME`/`USERPROFILE` and for `os.homedir()` via `vi.spyOn`) and `createTempProject({ git: boolean })` (temp folder, optional `git init` plus initial commit), both with cleanup
    - Create `test/utilities/worktree-mode.ts` with `enableWorktreesForTest(homeDir)` that writes `{"worktreesEnabled": true}` into the temp Global_Config (merging with any existing content)
    - _Requirements: 15.3, 15.8_

  - [x] 1.3 Capture a golden snapshot of the current sidebar prompt
    - Before `append-system-prompt.ts` is changed, add `test/runtime/prompts/append-system-prompt-golden.test.ts` that renders `renderAppendSystemPrompt` for every agent id and a few command prefixes and stores the output in `test/runtime/prompts/__snapshots__/`
    - This baseline is what Property 18 compares against
    - _Requirements: 11.6, 15.2_

- [x] 2. Implement the worktree setting, resolver, and config persistence
  - [x] 2.1 Create the pure setting module `src/config/worktree-setting.ts`
    - Implement `parseWorktreeSettingValue` (only JSON booleans valid, everything else `null`), `resolveEffectiveWorktreesEnabled` (project → global → `false`), `resolveInPlaceDefaultBaseRef` (`git?.currentBranch ?? ""`), and the constants `DEFAULT_WORKTREES_ENABLED`, `INVALID_WORKTREES_ENABLED_MESSAGE`, `WORKTREES_REQUIRE_GIT_MESSAGE`
    - Expose the module to the web UI as `@runtime-worktree-setting` in the web-ui Vite, Vitest, and tsconfig path aliases, following the existing `@runtime-task-state` alias pattern
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 10.3_

  - [x] 2.2 Write property test for effective resolution
    - File: `test/runtime/config/worktree-setting.property.test.ts`
    - Generate raw `g` / `p` values including absent, booleans, `"true"`, `"false"`, numbers, `null`, objects, arrays; assert result equals the reference model and is always a boolean
    - **Property 1: Effective resolution matches the reference model**
    - **Validates: Requirements 1.1, 1.4, 1.5, 1.6, 1.7, 1.8**

  - [x] 2.3 Create `src/config/effective-worktree-mode.ts`
    - Implement `loadWorktreeSettingSources(projectPath | null)`, `loadEffectiveWorktreesEnabled(projectPath)`, and `loadGlobalWorktreesEnabled()`
    - Read both config files directly with no locks and no agent detection; missing or unparsable files count as unset; reuse `getRuntimeGlobalConfigPath` / `getRuntimeProjectConfigPath` and the home-dir equality rule from `resolveRuntimeConfigPaths`
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.13, 5.9, 11.8_

  - [x] 2.4 Extend `src/config/runtime-config.ts` with the worktree fields
    - Add `worktreesEnabled?: unknown` to both file shapes; add `globalWorktreesEnabled`, `projectWorktreesEnabled`, and effective `worktreesEnabled` to `RuntimeConfigState`, populated in `toRuntimeConfigState`, `createRuntimeConfigStateFromValues`, and `toGlobalRuntimeConfigState` (global state ignores project override)
    - Add `worktreesEnabled?: boolean` and `projectWorktreesEnabled?: boolean | null` to `RuntimeConfigUpdateInput`; include them in `hasChanges`
    - `writeRuntimeGlobalConfigFile`: write provided value but omit the key when writing `false` and the key was absent; when not updated, copy any existing raw value unchanged
    - `writeRuntimeProjectConfigFile`: write `shortcuts` when non-empty and `worktreesEnabled` when boolean or preserved raw; delete the file only when both are absent; create only `<project>/.cline/kanban` when the folder is missing
    - `updateRuntimeConfig`: before any write, reject a project override with no project config path, and reject with `WORKTREES_REQUIRE_GIT_MESSAGE` when the next effective value is `true` and the project is not a git repository; keep writes inside `lockedFileSystem.withLocks` and let write failures propagate
    - `updateGlobalRuntimeConfig`: accept `worktreesEnabled` only
    - _Requirements: 1.2, 1.3, 1.7, 1.9, 1.12, 1.13, 2.7, 14.1, 14.4, 14.5_

  - [x] 2.5 Extend the API contract and config response
    - In `src/core/api-contract.ts` add `globalWorktreesEnabled`, `projectWorktreesEnabled`, `worktreesEnabled` to `runtimeConfigResponseSchema`; add `worktreesEnabled` and nullable `projectWorktreesEnabled` (both with `INVALID_WORKTREES_ENABLED_MESSAGE`) to `runtimeConfigSaveRequestSchema`; widen the `runtimeWorktreeEnsureResponseSchema` `ok: true` branch to `baseCommit: z.string().nullable()`
    - Pass the new save fields through `parseRuntimeConfigSaveRequest` (`src/core/api-validation.ts`)
    - Copy the three new state fields in `buildRuntimeConfigResponse` (`src/terminal/agent-registry.ts`)
    - _Requirements: 1.8, 1.11, 2.4, 5.1_

  - [x] 2.6 Write property test for config save/load round trip
    - File: `test/runtime/config/runtime-config-worktree-roundtrip.property.test.ts` (temp HOME and project via 1.2 helpers)
    - Also assert the loaded response validates against `runtimeConfigResponseSchema`
    - **Property 2: Config save/load round trip**
    - **Validates: Requirements 1.2, 1.8, 1.10, 1.12, 1.13**

  - [x] 2.7 Write property test for project override isolation
    - File: `test/runtime/config/runtime-config-worktree-isolation.property.test.ts`
    - **Property 3: Project override isolation**
    - **Validates: Requirements 1.3**

- [x] 2.8 Write property test for invalid stored values
    - File: `test/runtime/config/runtime-config-worktree-invalid-stored.property.test.ts`
    - Assert byte-identical files after load and after saving an unrelated field
    - **Property 4: Invalid stored values are ignored and preserved**
    - **Validates: Requirements 1.7**

  - [x] 2.9 Write property test for invalid save rejection
    - File: `test/runtime/config/runtime-config-worktree-invalid-save.property.test.ts`
    - **Property 5: Invalid saves are rejected without writes**
    - **Validates: Requirements 1.11**

  - [x]* 2.10 Write property test for the worktrees-require-git guard
    - File: `test/runtime/config/runtime-config-worktree-git-guard.property.test.ts` (non-git temp project)
    - **Property 6: Worktrees require git**
    - **Validates: Requirements 2.7**

  - [x]* 2.11 Write config example tests
    - File: `test/runtime/config/runtime-config-worktree.test.ts`
    - Cover: override `false` over global `true` and override `true` over global `false`; global applies without override; default `false` with missing files/keys; string, number, and `null` values treated as unset; key omitted when writing `false` with key absent; non-boolean save rejected; clearing override removes the key and deletes an otherwise empty file; `.cline/kanban` is the only folder created; injected `lockedFileSystem` write failure leaves the old file and effective value
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.9, 1.11, 1.12, 14.4, 14.5, 15.4, 15.8_

- [x] 3. Make workspace identity work without git
  - [x] 3.1 Update `src/state/workspace-state.ts`
    - `resolveWorkspacePath`: return canonical `realpath(cwd)` when `detectGitRoot` returns null instead of throwing
    - `detectGitRepositoryInfo`: return `{ currentBranch: null, defaultBranch: null, branches: [] }` for non-git folders
    - Add `loadWorkspaceScopeById(workspaceId)` that reads only the workspace index (no git, no stat)
    - _Requirements: 3.8, 5.7, 5.8, 10.3, 10.9_

  - [x] 3.2 Resolve tRPC scope without git in `src/server/runtime-server.ts`
    - `resolveWorkspaceScopeFromRequest` uses `loadWorkspaceScopeById` instead of `loadWorkspaceContextById`; board snapshots keep using `loadWorkspaceState`
    - _Requirements: 5.7, 5.8_

  - [x] 3.3 Write unit tests for git-free workspace identity
    - File: `test/runtime/state/workspace-state-non-git.test.ts`
    - Non-git folder resolves to its realpath, returns empty git info, and `loadWorkspaceScopeById` spawns no git process
    - _Requirements: 3.8, 5.7, 10.9_

- [x] 4. Implement In-Place workspace modules
  - [x] 4.1 Create pure response builders `src/workspace/in-place-responses.ts`
    - Implement `createInPlaceGitSyncSummary`, `createInPlaceGitSummaryResponse`, `createInPlaceGitSyncResponse`, `createInPlaceGitCheckoutResponse`, `createInPlaceGitDiscardResponse`, `createInPlaceGitLogResponse`, `createInPlaceGitRefsResponse`, `createInPlaceCommitDiffResponse`, `createInPlaceWorkspaceChangesResponse(projectPath, now)`
    - `ok: true`, no `error`, empty lists, zero counts, null nullables, required strings echoed from the request or `""`; do not reuse `createEmptyWorkspaceChangesResponse`
    - _Requirements: 5.5, 5.6, 5.7, 9.7_

  - [x] 4.2 Create `src/workspace/in-place-task-workspace.ts`
    - Define `ProjectFolderUnavailableError` ("Project folder is unavailable: <path>")
    - `resolveTaskCwd` stats the project path and returns it, throwing the error when missing or not a directory; `ensureTaskWorkspace` returns `{ ok: true, path, baseRef, baseCommit: null }`; `deleteTaskWorkspace` returns `{ ok: true, removed: false }`; `getTaskWorkspaceInfo` returns `exists: true`, `branch: null`, `isDetached: false`, `headCommit: null`
    - No git, no file writes, never reads `~/.cline/worktrees`
    - _Requirements: 3.1, 3.4, 3.5, 3.7, 3.8, 3.9, 4.3, 5.2, 5.3, 5.4, 12.3, 12.4_

  - [x] 4.3 Create `src/workspace/task-workspace-provider.ts`
    - Define `WorkspaceMode`, `TaskWorkspaceProvider`, `createTaskWorkspaceProvider(projectPath, worktreesEnabled)`, and `resolveTaskWorkspaceProvider(projectPath)` (uses `loadEffectiveWorktreesEnabled`)
    - Worktree implementation forwards to the existing `resolveTaskCwd`, `ensureTaskWorktreeIfDoesntExist`, `deleteTaskWorktree`, `getTaskWorkspaceInfo`, and hosts the existing-or-ensure logic currently in `runtime-api.ts` (`resolveExistingTaskCwdOrEnsure`), copied verbatim; `runtime-api.ts` switches to it in task 8.3
    - _Requirements: 3.1, 12.2, 12.5, 12.6, 13.1, 13.2, 13.7_

  - [x] 4.4 Create `src/workspace/turn-checkpoint-policy.ts`
    - Implement `createTurnCheckpointPolicy({ loadEffectiveWorktreesEnabled? })` with `shouldCaptureTurnCheckpoint(projectPath)` and pure `clearTurnCheckpoints(summary)`
    - _Requirements: 6.1, 6.2, 6.3, 14.3_

  - [x] 4.5 Add `allowEmptyBaseRef` to request parsers in `src/core/api-validation.ts`
    - `parseWorktreeEnsureRequest`, `parseTaskSessionStartRequest`, `parseShellSessionStartRequest` accept optional `{ allowEmptyBaseRef?: boolean }` (default `false` keeps current errors); `taskId` stays required
    - _Requirements: 3.7, 5.10, 10.2_

  - [x] 4.6 Write property test for In-Place task cwd
    - File: `test/runtime/workspace/in-place-task-workspace.property.test.ts`
    - Generate task ids and `baseRef`s (`""`, whitespace, nonexistent branches), with and without a pre-existing worktree folder; assert result is the project path and no git process is spawned; add an example for the missing-folder error
    - **Property 8: In-Place task cwd is always the project folder**
    - **Validates: Requirements 3.1, 3.7, 3.9, 12.3**

  - [x] 4.7 Write property test for checkpoint clearing
    - File: `test/runtime/workspace/turn-checkpoint-policy.property.test.ts`
    - **Property 12: Checkpoint clearing is targeted**
    - **Validates: Requirements 6.3**

- [x] 5. Checkpoint - Ensure all tests pass
  - Run `npm run check`; ensure all tests pass, ask the user if questions arise.

- [x] 6. Dispatch runtime entry points by mode
  - [x] 6.1 Add mode dispatch to `src/trpc/workspace-api.ts`
    - Add required `loadEffectiveWorktreesEnabled` to `CreateWorkspaceApiDependencies` and wire it in `createWorkspaceApi(...)` inside `src/server/runtime-server.ts`
    - Add a local `byMode(scope, inPlace, worktree)` helper; route `ensureWorktree`, `deleteWorktree`, `loadTaskContext` through the In-Place provider and `loadChanges`, `loadWorkspaceChanges`, all Git endpoints through the 4.1 builders, per the design table
    - In-Place path uses `parseWorktreeEnsureRequest(input, { allowEmptyBaseRef: true })`, skips the empty-`baseRef` scope check, and makes no broadcasts; Worktree path keeps the current function bodies
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 9.7_

  - [x] 6.2 Write property test for In-Place endpoint no-ops
    - File: `test/runtime/trpc/workspace-api-in-place-noop.property.test.ts`
    - Generate inputs accepted by each endpoint's zod input schema; assert response parses with the response schema, field values match Requirement 5, and mocked `runGit` / `node:child_process` and filesystem writes are never called
    - **Property 9: In-Place endpoints are schema-valid, fully specified no-ops**
    - **Validates: Requirements 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 9.7**

  - [x] 6.3 Write property test for per-call mode selection
    - File: `test/runtime/trpc/workspace-api-in-place-dispatch.property.test.ts`
    - **Property 10: Mode is chosen per call**
    - **Validates: Requirements 5.9, 5.11**

  - [x] 6.4 Write example tests for In-Place endpoints on non-git folders
    - File: `test/runtime/trpc/workspace-api-in-place-non-git.test.ts`
    - One test per Requirement 5 criteria 2 to 6 asserting each field, plus a Worktree, Diff, and Git endpoint call on a non-git temp folder; assert no git process spawned
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 15.5, 15.6_

  - [x] 6.5 Gate checkpoints in `src/trpc/hooks-api.ts`
    - Add `turnCheckpointPolicy` to `CreateHooksApiDependencies` and wire it in `createHooksApi(...)` in `src/server/runtime-server.ts`
    - In the `to_review` branch, capture and delete stale refs only when `shouldCaptureTurnCheckpoint(workspacePath)` is true; keep the state transition and broadcasts unconditional; in In-Place Mode emit cleared checkpoint fields
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 14.3_

  - [x] 6.6 Write property test for hook ingestion without checkpoints
    - File: `test/runtime/trpc/hooks-api-in-place.property.test.ts`
    - **Property 11: Turn completion never checkpoints in In-Place Mode**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 6.7 Skip git polling in `src/server/workspace-metadata-monitor.ts`
    - Add `loadEffectiveWorktreesEnabled` to `CreateWorkspaceMetadataMonitorDependencies` and wire it in `src/server/runtime-state-hub.ts`
    - Re-read the mode on every tick; when `false`, skip `loadHomeGitMetadata` and `loadTaskWorkspaceMetadata` and publish `createEmptyWorkspaceMetadata()`
    - _Requirements: 8.4, 9.2, 9.3, 10.9, 14.3_

  - [x] 6.8 Make project add/remove and shutdown cleanup mode-aware
    - `src/trpc/projects-api.ts` `addProject`: keep `assertPathIsDirectory` first; when `loadGlobalWorktreesEnabled()` is `false`, register without `requiresGitInitialization`, `initializeGitRepository`, or `ensureInitialCommit`; otherwise keep today's flow. Wire any new dependency in `createProjectsApi(...)` in `src/server/runtime-server.ts`
    - `removeProject` and `src/server/shutdown-coordinator.ts` trash cleanup call `deleteTaskWorktree` only for projects whose effective setting is `true`
    - _Requirements: 4.3, 10.4, 10.5, 10.10, 12.4, 12.5, 14.3_

  - [x] 6.9 Accept non-git launch folders in `src/server/workspace-registry.ts` and `src/cli.ts`
    - `createWorkspaceRegistry`: when `cwd` is not git and the global setting is `false`, register via `loadWorkspaceContext(cwd)`; otherwise keep today's flow
    - `resolveWorkspaceForStream`: remove "not a git repository" workspaces only when that project's effective setting is `true`; missing-folder removal unchanged
    - `tryOpenExistingServer` in `src/cli.ts` resolves a workspace id for non-git `cwd` the same way
    - _Requirements: 10.6, 10.7, 10.9, 10.10_

  - [x] 6.10 Accept empty `baseRef` in `src/core/task-board-mutations.ts`
    - `createTask` / `updateTask` store `baseRef.trim()` (possibly `""`) without branch validation; trash, restore, delete, and linked-task auto-start logic stay mode-independent and unchanged
    - _Requirements: 4.2, 4.4, 4.5, 7.4, 10.2, 10.3_

  - [x] 6.11 Write property test for auto-review field preservation
    - File: `test/runtime/core/task-board-mutations-auto-review.property.test.ts`
    - **Property 13: Auto-review fields survive board operations**
    - **Validates: Requirements 7.4**

  - [x] 6.12 Write property test for In-Place `baseRef` storage
    - File: `test/runtime/core/task-board-mutations-base-ref.property.test.ts`
    - Cover supplied values stored trimmed and defaults from `resolveInPlaceDefaultBaseRef` for `null`, `currentBranch: null`, and named branches
    - **Property 15: In-Place `baseRef` storage**
    - **Validates: Requirements 10.2, 10.3**

  - [x] 6.13 Write example tests for projects API and workspace registry
    - File: `test/runtime/trpc/projects-api-in-place.test.ts`
    - Global `false`: non-git add returns no `requiresGitInitialization` and creates no `.git`; global `true`: today's prompt; missing folder rejected in both modes; registry registers non-git launch cwd when global is `false`
    - _Requirements: 10.4, 10.5, 10.6, 10.10_

- [x] 7. Implement mode-aware agent prompts
  - [x] 7.1 Create `src/prompts/task-agent-prompt.ts`
    - `renderInPlaceTaskAgentPrompt(projectPath)` states the agent works in the shared project folder with its absolute path, prohibits `git commit`, `push`, `branch`, `checkout`, `stash`, `reset`, `worktree`, and warns about concurrent edits; no other mention of worktrees, detached HEAD, commits, or PRs
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 7.2 Add the In-Place sidebar variant
    - Create `src/prompts/sidebar-prompt-in-place-sections.ts` with shared-folder intro and reworded `task create` / `task update` / `task start` / `task done` / `task delete` references (no `--base-ref`, `--auto-review-*`, auto-review paragraph, or worktree cleanup)
    - Add `worktreesEnabled?: boolean` (default `true`) to `RenderAppendSystemPromptOptions` in `src/prompts/append-system-prompt.ts`; `false` swaps in the In-Place sections; `true` output must match the 1.3 golden snapshot
    - _Requirements: 11.5, 11.6_

  - [x] 7.3 Create `src/prompts/resolve-agent-append-prompt.ts`
    - `resolveAgentAppendSystemPrompt({ taskId, projectPath, worktreesEnabled, commandPrefixOptions })`: home session → sidebar prompt with `{ worktreesEnabled }`; task + `false` → `renderInPlaceTaskAgentPrompt`; task + `true` → `null`
    - _Requirements: 11.5, 11.6, 11.7, 11.8_

  - [x] 7.4 Write property test for the In-Place task prompt
    - File: `test/runtime/prompts/in-place-task-prompt.property.test.ts`
    - **Property 16: In-Place task prompt content**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**

  - [x] 7.5 Write property test for the In-Place sidebar prompt
    - File: `test/runtime/prompts/in-place-sidebar-prompt.property.test.ts`
    - **Property 17: In-Place sidebar prompt has no worktree guidance**
    - **Validates: Requirements 11.5**

  - [x] 7.6 Write property test for unchanged Worktree Mode prompts
    - File: `test/runtime/prompts/worktree-mode-prompts.property.test.ts`
    - Compare against the 1.3 golden snapshot; assert `resolveAgentAppendSystemPrompt` returns `null` for non-home tasks with `worktreesEnabled: true`
    - **Property 18: Worktree Mode prompts are unchanged**
    - **Validates: Requirements 11.6**

- [x] 8. Wire task and shell session start
  - [x] 8.1 Pass resolved prompts through terminal adapters and the session manager
    - Add `appendSystemPrompt?: string | null` to `AgentAdapterLaunchInput` in `src/terminal/agent-session-adapters.ts`; Claude, Codex, Droid, Kiro, and Cline adapters use `input.appendSystemPrompt ?? null` instead of calling `resolveHomeAgentAppendSystemPrompt`; Gemini and OpenCode prepend the task prompt to the initial prompt for task sessions only
    - Add optional `appendSystemPrompt` to `StartTaskSessionRequest` and a `clearTurnCheckpoints(taskId)` method to `TerminalSessionManager` that emits a summary with both checkpoint fields `null`; restarts reuse the stored request
    - _Requirements: 6.3, 11.1, 11.5, 11.6, 11.9, 12.8_

  - [x] 8.2 Update `src/cline-sdk/cline-task-session-service.ts`
    - Accept the turn checkpoint policy and project path in the scoped constructor; `captureReviewCheckpoint` checks the policy first
    - Use `request.appendSystemPrompt` (new optional field on `StartClineTaskSessionRequest`) instead of calling `resolveHomeAgentAppendSystemPrompt`; add `clearTurnCheckpoints(taskId)`
    - Wire the new constructor inputs at the service's creation site
    - _Requirements: 6.1, 6.2, 6.3, 11.5, 11.6, 11.8_

  - [x] 8.3 Update `src/trpc/runtime-api.ts`
    - `startTaskSession`: resolve `worktreesEnabled`, parse with `allowEmptyBaseRef: !worktreesEnabled`, get task cwd from `provider.resolveTaskCwd({ ensure: true })` (home sessions keep `workspacePath`), capture checkpoints only when `worktreesEnabled`, clear checkpoints after start in In-Place Mode, compute `appendSystemPrompt` via `resolveAgentAppendSystemPrompt` and pass it to the terminal manager or Cline service; return `{ ok: false, error }` for `ProjectFolderUnavailableError`
    - Remove the local existing-or-ensure helper now hosted by the provider (4.3)
    - `startShellSession`: task-scoped cwd from the provider
    - `saveConfig`: pass the new fields; map the git-repo guard to `BAD_REQUEST` and persistence failures to `INTERNAL_SERVER_ERROR`
    - _Requirements: 2.7, 3.1, 3.2, 3.3, 3.6, 3.7, 3.9, 6.3, 11.7, 11.8, 12.2, 12.3, 12.8, 14.5_

  - [x] 8.4 Write runtime API example tests
    - File: `test/runtime/trpc/runtime-api-in-place.test.ts` (mocked managers)
    - Cover: task and shell sessions use the project path; ten concurrent starts give ten sessions; missing project folder rejected with "Project folder is unavailable"; In-Place prompt passed and no commit/PR template; running session keeps cwd and prompt after a mode flip; save guard and persistence error codes
    - _Requirements: 2.7, 3.2, 3.3, 3.6, 3.9, 11.7, 11.8, 11.9, 12.8, 14.5_

- [x] 9. Update the CLI
  - [x] 9.1 Make `task create` mode-aware in `src/commands/task.ts`
    - Add `loadWorkspaceWorktreesEnabled(runtimeClient)` reading `runtime.getConfig`
    - In In-Place Mode, default `baseRef` with `resolveInPlaceDefaultBaseRef(state.git)` and skip the "Could not determine task base branch" error; Worktree Mode keeps `resolveTaskBaseRef`; `--auto-review-*` flags stored unchanged
    - _Requirements: 7.5, 10.2, 10.3, 10.8_

  - [x] 9.2 Write CLI integration tests
    - File: `test/integration/cli-in-place.integration.test.ts` (temp HOME, global `false`)
    - Launch from a non-git cwd registers it; `task create` with and without `--base-ref` in a non-git project exits 0 with no branch lookup error; `--auto-review-*` values are stored
    - _Requirements: 7.5, 10.6, 10.8_

- [x] 10. Opt existing backend tests into Worktree Mode
  - [x] 10.1 Set `worktreesEnabled: true` explicitly in existing worktree-dependent backend tests
    - Integration tests (`test/integration/task-worktree.integration.test.ts`, `runtime-state-stream.integration.test.ts`, and others exercising worktrees, checkpoints, patches, mirroring, or commit/PR) call `enableWorktreesForTest(homeDir)` before starting the runtime
    - Unit tests that build `createWorkspaceApi`, `createHooksApi`, the metadata monitor, the projects API, or the Cline service pass `loadEffectiveWorktreesEnabled: async () => true` or an always-`true` `turnCheckpointPolicy`
    - Prompt tests call `renderAppendSystemPrompt` without the new option
    - Do not change assertions, remove, rename-to-skip, skip, or todo any test
    - _Requirements: 13.1, 13.2, 13.3, 13.5, 13.6, 13.7, 15.2, 15.3_

- [x] 11. Checkpoint - Ensure all tests pass
  - Run `npm run check`; ensure all tests pass, ask the user if questions arise.

- [x] 12. Add web UI mode state
  - [x] 12.1 Create `web-ui/src/runtime/worktree-mode.tsx` and a test helper
    - `WorktreeModeProvider` and `useWorktreeMode()` returning `{ worktreesEnabled: boolean | null, isWorktreeMode }` where `isWorktreeMode` is `worktreesEnabled === true`
    - Add `renderWithWorktreeMode(ui, { worktreesEnabled })` in `web-ui/src/test-utils/`
    - _Requirements: 8.4, 9.3, 13.4_

  - [x] 12.2 Provide mode in `web-ui/src/App.tsx`
    - Derive the value from `runtimeProjectConfig?.worktreesEnabled ?? null` and wrap the board and detail tree in `WorktreeModeProvider`; ensure the settings dialog `onSaved` triggers `refreshRuntimeProjectConfig()`
    - _Requirements: 2.6, 7.8, 8.7, 9.5_

  - [x] 12.3 Accept empty `baseRef` in `web-ui/src/state/board-state.ts`
    - Card normalizer and draft-update check accept `""`
    - _Requirements: 10.1, 10.2_

  - [x] 12.4 Surface config save errors from `useRuntimeConfig.save`
    - Return `{ ok: false, error }` instead of swallowing errors and returning `null`; update existing callers to the new result shape
    - _Requirements: 2.7, 2.8, 14.5_

- [x] 13. Gate web UI hooks
  - [x] 13.1 Add `enabled` to `web-ui/src/runtime/use-runtime-workspace-changes.ts`
    - Fold `enabled` into `hasWorkspaceScope` so polling and state-version refetch stop
    - _Requirements: 9.3, 9.5, 9.6_

  - [x] 13.2 Add `enabled` to `web-ui/src/hooks/use-git-actions.ts`
    - When false, sync, checkout, discard, and commit/PR actions are no-ops and history refresh is skipped
    - _Requirements: 7.1, 8.4, 8.5_

  - [x] 13.3 Add mode gating to `web-ui/src/hooks/use-review-auto-actions.ts`
    - New `enabled` and `worktreesEnabled: boolean | null` inputs; when disabled, clear timers and skip evaluation; on a loaded `false → true` transition, snapshot current review task ids into a suppressed set and drop each id when its task leaves review
    - _Requirements: 7.3, 7.6, 7.8, 13.5_

  - [x] 13.4 Write property test for auto-review gating
    - File: `web-ui/src/hooks/use-review-auto-actions.property.test.tsx` (fake timers, generated boards)
    - **Property 14: No auto-review while disabled or for pre-existing review tasks**
    - **Validates: Requirements 7.3, 7.6, 7.8**

  - [x] 13.5 Add `isGitHistoryEnabled` to `web-ui/src/hooks/use-app-hotkeys.ts`
    - Skip the git-history hotkey binding when false
    - _Requirements: 8.3, 8.5_

- [x] 14. Gate web UI components
  - [x] 14.1 Gate `web-ui/src/components/top-bar.tsx`
    - Do not render the git history toggle, branch label/selector, or working-copy counts when `!isWorktreeMode` (conditional render, not CSS hiding)
    - _Requirements: 8.1, 8.2, 8.5, 8.7_

  - [x] 14.2 Gate git history and wire hook flags in `web-ui/src/App.tsx`
    - `handleToggleGitHistory` no-op in In-Place Mode; effect closes git history when `isWorktreeMode` becomes false and shows the underlying view; do not mount `GitHistoryView`; pass `enabled` / `isGitHistoryEnabled` / `worktreesEnabled` to the hooks from task 13
    - _Requirements: 8.1, 8.3, 8.4, 8.6, 8.7, 9.3, 9.5_

  - [x] 14.3 Gate `web-ui/src/components/card-detail-view.tsx`
    - Skip `DiffModeButton`s, `DiffViewerPanel`, `FileTreePanel`, the resize handle, the git history panel, and commit/PR buttons; the agent terminal or Cline chat fills the content area at full width
    - _Requirements: 7.1, 9.1, 9.4, 9.5, 9.6_

  - [x] 14.4 Gate `web-ui/src/components/board-card.tsx`
    - Skip `reviewChangeSummary`, Commit/Open PR buttons, and the cancel-automatic-action control
    - _Requirements: 7.1, 9.2, 9.6_

  - [x] 14.5 Gate task create and inline create dialogs
    - In `web-ui/src/components/task-create-dialog.tsx` and `task-inline-create-card.tsx`, skip the base-ref `BranchSelectDropdown` and auto-review controls; submit with `resolveInPlaceDefaultBaseRef(workspaceGit)`; edit keeps stored `baseRef` and auto-review values
    - _Requirements: 7.2, 7.4, 10.1, 10.3_

- [x] 15. Add worktree settings to the settings dialog
  - [x] 15.1 Create `web-ui/src/components/settings/worktree-settings-section.tsx`
    - Add `@radix-ui/react-radio-group` as an exact-pinned dependency in `web-ui/package.json`
    - Radix `Switch` "Use git worktrees" styled like the notifications switch (`bg-surface-4`, `data-[state=checked]:bg-accent`); when a project is selected, a Radix `RadioGroup` with "Use global default", "Off (in-place)", "On (worktrees)"
    - Export a pure `buildWorktreeSaveRequest(loaded, draft)` helper (in its own file, e.g. `build-worktree-save-request.ts`) mapping `{ global → null, off → false, on → true }` and including only changed fields
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 15.2 Integrate the section into `web-ui/src/components/runtime-settings-dialog.tsx`
    - Own drafts, include them in `hasUnsavedChanges`, reset on close without saving, merge `buildWorktreeSaveRequest` output into `handleSave`
    - On save error, keep the dialog open with drafts and show the runtime message (including `WORKTREES_REQUIRE_GIT_MESSAGE`)
    - Hide the commit/PR prompt template editors when the effective setting is false while still sending loaded template values unchanged
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 2.8, 7.7_

  - [x] 15.3 Write property test for the settings save request
    - File: `web-ui/src/components/settings/worktree-settings-section.property.test.tsx`
    - **Property 7: Settings draft maps to the minimal save request**
    - **Validates: Requirements 2.4**

- [x] 16. Update and extend web UI tests
  - [x] 16.1 Opt existing worktree-dependent web UI tests into Worktree Mode
    - Wrap renders in `board-card`, `card-detail-view`, `top-bar`, `git-history-view`, `use-git-actions`, `use-review-auto-actions`, `use-board-interactions`, and `runtime-settings-dialog` tests with `renderWithWorktreeMode(..., { worktreesEnabled: true })` or `WorktreeModeProvider value={true}`, and pass `enabled: true` to gated hooks
    - Do not change assertions, remove, skip, or todo any test
    - _Requirements: 13.4, 15.2, 15.3_

  - [x] 16.2 Write web UI In-Place example tests
    - Settings dialog toggle/radio rendering, save, cancel, error states, and hidden template editor
    - Board card, detail view, create/edit dialogs, and top bar render no git, diff, change-count, base-ref, or auto-review elements (`queryBy…` returns `null`); hotkey is a no-op
    - Mocked tRPC client records zero Git and Diff calls across board load, task selection, visibility change, and project switch
    - Mode switch closes git history and toggles UI without reload; Worktree Mode renders everything as today
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.8, 7.1, 7.2, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 13.4_

- [x] 17. Add end-to-end filesystem guarantees
  - [x] 17.1 Write the In-Place filesystem snapshot integration test
    - File: `test/integration/in-place-mode.integration.test.ts` (temp HOME with global `false`, temp git repo)
    - Snapshot all project paths and contents (including `.git/info/exclude`, refs, `git branch --list`) and `~/.cline/worktrees`; run task start, hook `to_review`, trash, restore, permanent delete through the runtime; assert equality apart from `.cline/kanban` and unchanged `refs/kanban/checkpoints/*`
    - Second variant on a non-git folder asserts no checkpoint or git errors and a clean board load
    - _Requirements: 3.4, 3.5, 3.8, 4.1, 4.2, 4.3, 4.6, 4.7, 5.8, 6.4, 6.5, 10.9, 12.1, 12.4, 14.2, 14.3, 15.6, 15.7, 15.8_

- [x] 18. Final checkpoint - Ensure all tests pass
  - Run `npm run check` and `npm run web:test`; ensure all tests pass with zero failures and no skipped or removed tests, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; tasks 10.1 and 16.1 are required because the existing suites must stay green.
- Each task references requirements for traceability; property test tasks reference the design's Correctness Properties.
- Property tests run at least 100 iterations and carry the tag comment `// Feature: in-place-workspace-mode, Property {n}: {property title}`.
- New tests use a temp HOME and temp project folders via `test/utilities/temp-kanban-home.ts`.
- Task 1.3 must run before task 7.2 so the golden snapshot reflects pre-feature output.
- New required dependencies on the API factories (task 6.x) break existing unit-test setup until task 10.1; checkpoint 11 is the first gate after both land.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "3.1", "4.1", "7.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "3.2", "4.2", "4.5", "6.10", "7.4"] },
    { "id": 2, "tasks": ["2.4", "3.3", "4.3", "4.4", "6.11", "6.12"] },
    { "id": 3, "tasks": ["2.5", "4.6", "4.7", "6.5", "6.7", "7.2"] },
    { "id": 4, "tasks": ["2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "6.1", "6.6", "7.3", "7.5", "7.6"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.8", "6.9", "8.1", "8.2"] },
    { "id": 6, "tasks": ["6.13", "8.3"] },
    { "id": 7, "tasks": ["8.4", "9.1"] },
    { "id": 8, "tasks": ["9.2", "10.1", "12.1", "12.3", "12.4"] },
    { "id": 9, "tasks": ["12.2", "13.1", "13.2", "13.3", "13.5", "15.1"] },
    { "id": 10, "tasks": ["13.4", "14.1", "14.3", "14.4", "14.5", "15.2", "15.3"] },
    { "id": 11, "tasks": ["14.2"] },
    { "id": 12, "tasks": ["16.1", "17.1"] },
    { "id": 13, "tasks": ["16.2"] }
  ]
}
```
