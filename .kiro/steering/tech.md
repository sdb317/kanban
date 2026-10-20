# Tech Stack

## Runtime & language

- **Node.js >= 22**, ESM only (`"type": "module"`). All local imports use `.js` extensions.
- **TypeScript 5.9** (strict). No `any` unless unavoidable; prefer SDK-provided types over local redefinitions. No inline/dynamic imports — always top-level imports.

## Backend / CLI (`src/`)

- CLI framework: **commander**
- API layer: **tRPC** (`@trpc/server` / `@trpc/client`) over **ws** WebSockets
- Validation: **zod**
- Terminals: **node-pty**, `@xterm/headless`, `@xterm/addon-serialize`
- Agent SDK: `@clinebot/core`, `@clinebot/shared` (native Cline agent); `@modelcontextprotocol/sdk` for MCP
- Misc: `proper-lockfile`, `tree-kill`, `undici`, `ora`, `open`
- Telemetry/errors: `@sentry/node`

## Web UI (`web-ui/`)

- **React 18** + **Vite 6**
- **Tailwind CSS v4** (tokens in `globals.css` `@theme`), **Radix UI** primitives, **lucide-react** icons
- Terminals: `@xterm/xterm` + addons (fit, webgl, clipboard, web-links, unicode11)
- DnD: `@hello-pangea/dnd`; lists: `react-virtuoso`; hooks: `react-use`, `react-hotkeys-hook`
- Toasts: `sonner`; markdown: `react-markdown` + `remark-gfm`; animation: `motion`
- Always dark theme — never use `dark:` prefix or light-mode defaults.

## Desktop (`packages/desktop/`)

- **Electron 41** shell + **electron-builder**. Stages the CLI and wraps the runtime.

## Tooling

- **Biome** for lint + format (not ESLint/Prettier)
- **Vitest** for tests; **Playwright** for web-ui e2e
- **esbuild** for bundling; **Husky** pre-commit hooks

## Common commands

Run from repo root unless noted.

```bash
# Install everything (root + web-ui + desktop)
npm run install:all

# Dev
npm run dev            # CLI watch (tsx)
npm run web:dev        # web-ui dev server (Vite)
npm run dev:full       # full stack dev

# Build
npm run build          # clean, build web-ui, bundle CLI into dist/
npm run link           # build + npm link the `kanban` bin

# Quality (run before finishing work)
npm run check          # biome check + typecheck + test  ← full gate
npm run lint           # biome lint
npm run format         # biome check --write (autofix)
npm run typecheck      # tsc --noEmit (root)
npm run web:typecheck  # tsc --noEmit (web-ui)

# Tests
npm run test           # vitest run (all)
npm run test:fast      # runtime + utilities (used by pre-commit)
npm run test:integration
npm run web:test       # web-ui vitest
```

## Conventions

- Prefer well-maintained third-party packages over custom utilities.
- Small, single-responsibility files; extract shared logic into hooks/utilities (DRY).
- Avoid thin pass-through wrapper components; extract domain logic instead.
- Never commit unless the user explicitly asks.
- Don't downgrade/remove code to silence type errors from outdated deps — upgrade the dep.
