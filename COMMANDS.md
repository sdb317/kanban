# Commands & Debugging

## Full-stack dev vs. dogfood

### `npm run dev:full` — iterate on Kanban's own code

- Runs the runtime via `tsx watch src/cli.ts` (restarts on backend source changes) and the web UI via Vite (`npm run web:dev`, with HMR).
- Picks free ports automatically (runtime from 3484, web UI from 4173) and opens the Vite URL.
- Bootstraps deps (`npm ci` in root + `web-ui`) if `node_modules` is missing.
- Defaults to `--skip-shutdown-cleanup` (override with `--with-shutdown-cleanup`).
- Runs from the current working directory — no `--project` flag.

### `npm run dogfood` — run Kanban as a real tool

- Runs `npm run build` first (unless `--skip-build`), then launches the built `dist/cli.js` — no watch/HMR, so rebuild to pick up changes.
- Flags: `--project <path>`, `--port <number|auto>`, `--open`, `--skip-build`, `--host`, `--https`, `--cert`, `--key`. Does not open a browser tab unless `--open` is passed.
- Strips repo-local `node_modules/.bin` from PATH so globally installed agent CLIs aren't shadowed.

To debug the full stack against a real project folder, dogfood is the right tool (it accepts `--project`):

```powershell
npm run dogfood -- --project C:\path\to\real\project
```

## Logging

Logging is produced by the shared runtime logger in `src/cline-sdk/cline-runtime-logger.ts`. It is **off by default** and gated by a single master switch.

### Environment variables

| Variable            | Effect                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `CLINE_LOG_ENABLED` | Master switch. Set to `1`/`true`/`yes`/`on` to enable logging. Off otherwise. |
| `CLINE_LOG_LEVEL`   | `debug` \| `info` \| `warn` \| `error` (default `info`).               |
| `CLINE_LOG_PATH`    | Full **file** path for the log file. Default `<clineDataDir>/logs/kanban.log`. |

When enabled, logs go to **both** the console (stdout/stderr via `console.debug/info/warn/error`) and the file at `CLINE_LOG_PATH`. Both sinks share the `CLINE_LOG_ENABLED` switch and the `CLINE_LOG_LEVEL` filter.

> `CLINE_LOG_PATH` must be a file path, not a directory. Pointing it at a folder makes file writes fail silently (console logging still works).

### PowerShell usage

`set NAME=value` is cmd syntax and does not create an environment variable in PowerShell. Use `$env:`:

```powershell
$env:CLINE_LOG_ENABLED = "1"
$env:CLINE_LOG_LEVEL   = "debug"
$env:CLINE_LOG_PATH    = "$PWD\kanban.log"   # optional; a file, not a folder
$env:KANBAN_CLINE_OLLAMA_BASE_URL=http://...:11434

npm run build                                 # dogfood runs the built CLI
npm run dogfood -- --project C:\path\to\real\project

# in another terminal
Get-Content .\kanban.log -Wait
```

Verify the vars reach the spawned runtime before launching:

```powershell
Get-ChildItem Env:CLINE_LOG_*
```

### What gets logged

Logging is wired at central chokepoints rather than scattered per call site:

- **User interactions** — a tRPC middleware on the base procedure in `src/trpc/app-router.ts` logs every query/mutation: `trpc.call.start`, `trpc.call.ok` (with `durationMs`), and `trpc.call.error` (with error `code`/`message`). This covers task start/stop, chat send, board saves, git actions, project add/remove, config/provider/MCP changes, hooks ingest, etc.
- **Major state changes** — `src/state/workspace-state.ts` logs board state transitions: `workspace.saveState` (UI snapshot save) and `workspace.mutate` (CLI atomic mutation) with `fromRevision`/`toRevision` and a per-column card-count summary, `workspace.saveState.conflict` on revision mismatch, and `workspace.mutate.noop` when a mutation makes no change.
- **Server lifecycle** — `src/server/runtime-server.ts` logs `runtime.server.started`, `runtime.server.closing`, and `runtime.server.closed`.

Log lines in the file are JSON (one object per line: `ts`, `level`, `message`, `metadata`).

## Common commands

```bash
npm run check          # biome + typecheck + test (full gate)
npm run typecheck      # tsc --noEmit (root; includes tests)
npm run test           # vitest run
npm run build          # build web-ui + bundle CLI into dist/
set HUSKY=0
```

