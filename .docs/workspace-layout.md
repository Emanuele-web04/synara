# Workspace layout

Synara is a Bun/Turbo monorepo. Runtime ownership is split across the app workspaces, while shared schemas and cross-runtime helpers live under `packages`.

- `/apps/server` — The authoritative Synara backend and published `@synara/cli` package. Owns orchestration/persistence, provider adapters and health/discovery, Git/worktrees, terminals, automation, workspace files, HTTP/WebSocket RPC, and the bundled web client used outside Vite development.
- `/apps/web` — React + Vite application. Owns presentation, client transport/state coordination, chat/composer/editor/dock surfaces, and subscription-driven projection of server-authoritative state.
- `/apps/desktop` — Electron host for the shared web client. Supervises a desktop-scoped Synara server process and provides native window, update, and OS integration.
- `/apps/marketing` — Public marketing/download site. Kept separate from the product runtime and desktop/web application bundles.
- `/packages/contracts` — Shared Effect Schema and TypeScript contracts for orchestration, provider/session/model data, RPC methods, settings, keybindings, automation, device/browser surfaces, and other cross-process payloads.
- `/packages/shared` — Runtime-neutral helpers consumed by multiple apps/packages. Uses explicit subpath exports (for example `@synara/shared/git` and `@synara/shared/threadWorkspace`) rather than one catch-all barrel.
- `/scripts` — Repository-level development, packaging, release, migration-lineage, canary, and smoke-test tooling. Desktop artifact/release code lives here rather than inside the Electron app.

## Ownership rule of thumb

- Durable application truth or side effects belong in `apps/server`.
- Browser/Electron presentation belongs in `apps/web`; desktop-only native hosting belongs in `apps/desktop`.
- Cross-process data shapes belong in `packages/contracts`.
- Pure utilities shared across runtimes belong in `packages/shared`.
- Build/release/developer automation belongs in `scripts`.

See [architecture.md](./architecture.md) for the runtime/data-flow overview and [provider-architecture.md](./provider-architecture.md) for provider integration boundaries.
