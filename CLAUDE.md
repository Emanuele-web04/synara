# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Treat `bun fmt`, `bun lint`, and `bun typecheck` as heavyweight workspace checks: bundle them into one final verification pass per task whenever possible, and avoid rerunning the full set repeatedly during iteration.
- If a user asks for a small follow-up right after a recent full verification pass, prefer no rerun or the smallest reasonable re-check unless the user explicitly asks for full validation again.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

Synara is a minimal web GUI for using coding agents. It is multi-provider: `ProviderKind` currently spans 9 providers — Codex, Claude (`claudeAgent`), Cursor, Gemini, Grok, Factory Droid (`droid`), Kilo, OpenCode, and Pi. Each provider has its own model options and capabilities (reasoning effort, thinking budget/level, context window, fast mode), defined in `packages/contracts` and resolved in `packages/shared/src/model.ts`.

Codex was the first integration and remains the most fleshed-out reference (see the Codex App Server section), but Synara is not Codex-only.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## UI Conventions

### Open/close (toggle) animations — single source

Any UI element with an open/close toggle (expand/collapse, show/hide, disclosure) MUST reuse the shared disclosure motion in `apps/web/src/lib/disclosureMotion.ts`. Never write bespoke height/opacity transitions or one-off `@keyframes` for a toggle — use the same logic and the same functions everywhere so every toggle feels identical (220ms `ease-out`, with `motion-reduce` fallbacks).

- Shell + content (used by open/close project, sidebar sections, composer suggestions): `disclosureShellClassName(open)` on the grid shell, `DISCLOSURE_INNER_CLASS` on the inner wrapper, `disclosureContentClassName(open)` on the content — or the ready-made `DisclosureRegion` component (`apps/web/src/components/ui/DisclosureRegion.tsx`).
- Base UI `<Collapsible>` panels: wrap with `CollapsiblePanel` (`apps/web/src/components/ui/collapsible.tsx`), which applies `DISCLOSURE_COLLAPSIBLE_PANEL_CLASS`.
- Rotating chevron affordance: `DisclosureChevron` / `disclosureChevronClassName(open)`.

Reference usage: opening/closing a project and the sidebar sections in `apps/web/src/components/Sidebar.tsx`. If you find a toggle that animates differently, migrate it to this module rather than duplicating logic.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

Codex was the first provider integration and is the most complete reference for how a provider session works end to end. For Codex sessions, the server starts `codex app-server` (JSON-RPC over stdio) per session, then streams structured events to the browser through WebSocket push messages. Other providers follow the same dispatch/event-projection shape but plug in their own runtimes.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
