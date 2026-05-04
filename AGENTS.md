# AGENTS.md

## Task Completion Requirements

- Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless the user explicitly asks for them in the current conversation.
- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Treat `bun fmt`, `bun lint`, and `bun typecheck` as heavyweight workspace checks: bundle them into one final verification pass per task whenever possible, and avoid rerunning the full set repeatedly during iteration.
- If a user asks for a small follow-up right after a recent full verification pass, prefer no rerun or the smallest reasonable re-check unless the user explicitly asks for full validation again.
- If the user asks to focus on code only, do not run `bun fmt`, `bun lint`, or `bun typecheck` automatically. In that mode, make the code changes first and only run verification if the user explicitly asks for it.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

DP Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Transcript Performance Guardrails

- Treat transcript auto-scroll as a live-output feature, not a generic "working" feature. Buffering, reconnecting, pending approvals, and tool-only activity must not be wired as if assistant text is actively streaming.
- When wiring scroll-follow logic, count real transcript messages only. Tool/work rows must not retrigger the same "new content arrived" auto-stick path.
- Prefer the simpler fork-style transcript path for the common case. Small and medium transcripts should avoid virtualization churn unless there is a clear measured need.
- If virtualization is used, never couple `rowVirtualizer.measure()` directly to another bottom-stick or height-follow cycle. Height-follow for live output should stay one-way to avoid measure/scroll feedback loops.
- Preserve these behaviors with focused transcript tests when changing chat scrolling, timeline measurement, or sidebar-driven transcript updates.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Local Dev Instance Isolation

- Never start the default `bun run dev` while another DP Code instance is running unless the user explicitly wants shared ports/state.
- Use an isolated home dir and non-default ports when running alongside the user's own DP Code instance, for example: `env -u T3CODE_AUTH_TOKEN T3CODE_PORT_OFFSET=3158 T3CODE_NO_BROWSER=1 bun run dev -- --home-dir ./.dpcode-pr84 --port 58090`.
- Always dry-run first when avoiding conflicts: `env -u T3CODE_AUTH_TOKEN T3CODE_PORT_OFFSET=3158 bun run dev -- --home-dir ./.dpcode-pr84 --port 58090 --dry-run`.
- Unset `T3CODE_AUTH_TOKEN` for browser dev instances unless the web app is also configured to connect with that token. If auth is accidentally inherited, the browser WebSocket can be rejected and the UI will show no threads even though SQLite has projects/threads.
- Check both server and web ports with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. A desktop app can bind `127.0.0.1:<port>` while the dev server binds IPv6 `*:<port>`, and `localhost` may still hit the wrong process.
- If the UI shows no threads, verify the server path before changing SQL: inspect the isolated `state.sqlite`, then probe `orchestration.getSnapshot` over WebSocket. A healthy snapshot with projects/threads means the issue is client connection/hydration, not empty history.

## Codex App Server (Important)

DP Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

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
