# Project Structure

Monorepo-style layout: a Node CLI/runtime at the root, a React web UI, and an Electron desktop shell, each with its own `package.json` and `tsconfig`.

## Top level

```
src/            Backend CLI + runtime (Node, ESM, TypeScript)
web-ui/         React + Vite frontend (served by the runtime / desktop)
packages/desktop/  Electron shell wrapping the runtime
test/           Backend tests (vitest): integration, runtime, utilities
scripts/        Build/dev/release scripts (.mjs)
docs/           User-facing documentation
man/            Generated man page
.plan/          Planning docs & investigation notes (handy historical context)
```

Config at root: `biome.json`, `vitest.config.ts`, `tsconfig.base.json` / `tsconfig.json` / `tsconfig.build.json`.

## Backend (`src/`)

- `cli.ts` — CLI entrypoint (the `kanban` bin → `dist/cli.js`); `index.ts` — library entry.
- `commands/` — commander command definitions.
- `server/` — runtime web server, WebSocket/state hub, workspace registry, shutdown coordination, browser launch.
- `trpc/` — tRPC routers and procedures (the API surface).
- `core/` — domain logic: agent catalog, API contract/validation, task board mutations, task id/title, graceful shutdown, shell/env helpers.
- `cline-sdk/` — boundary layer over `@clinebot/core`; inspect here for native Cline agent behavior.
- `terminal/` — node-pty / xterm terminal management.
- `workspace/`, `projects/`, `state/`, `config/`, `fs/` — workspace & worktree handling, project/board state, persistence, filesystem helpers.
- `prompts/` — dynamic prompts injected into agent sessions (board management, commit/PR).
- `security/`, `telemetry/`, `update/` — guards, Sentry/analytics, self-update.

## Web UI (`web-ui/src/`)

- `App.tsx`, `main.tsx` — app root.
- `components/` — React components; shared UI primitives in `components/ui/` (`button`, `dialog`, `tooltip`, `kbd`, `spinner`, `cn`).
- `hooks/`, `utils/` — shared logic (prefer `react-use` via `@/kanban/utils/react-use`).
- `state/`, `stores/`, `data/`, `storage/` — client state and persistence.
- `runtime/` — tRPC/WebSocket client to the backend.
- `terminal/` — xterm integration; `git-actions/` — git UI; `resize/` — pane sizing.
- `styles/` — `globals.css` with Tailwind `@theme` design tokens (dark-only).
- `telemetry/`, `types/`, `assets/`.
- Imports use the `@/` alias.

## Desktop (`packages/desktop/`)

- `src/main.ts`, `src/preload.ts` — Electron main/preload; stages the built CLI (`scripts/stage-cli.mjs`) and loads the runtime.

## Conventions

- Keep files small and single-responsibility; group by domain, not by type.
- Backend is ESM with explicit `.js` import extensions; web-ui uses the `@/` path alias.
- Tests mirror the area under test (`test/runtime`, `test/integration`, `test/utilities` for backend; `web-ui/tests` for frontend).
