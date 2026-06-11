# Oracle Handoff Packet: Review Chat Latency

## Goal

Investigate why review chat message-to-first-response latency is much slower than normal chat, even though response streaming is now wired correctly. We need a concrete patch plan to reduce review chat latency, ideally by about 10x for warm/reused paths.

## Project Briefing

Synara is a TypeScript monorepo using Bun, React/Vite frontend, Effect on the server, and shared contracts in `packages/contracts`. The server wraps provider runtimes, especially Codex app-server, and streams provider runtime events into orchestration domain events consumed by the web app over WebSocket.

Validation commands:

```bash
bun run typecheck
bun run lint
bun run fmt:check
cd apps/server && bun run test <test-file>
cd apps/web && bun run test <test-file>
cd apps/web && bun run test:browser <browser-test-file>
```

Do not use `bun test`; this repo uses `bun run test`.

## Current State

Already implemented:

1. Review chat optimistic user message and progressive placeholder in `ReviewSidechat`.
2. Review chat thread matching includes PR `headSha`.
3. Review-only Codex profile options: `ephemeral: true`, `serviceName: "synara_review_chat"`, `approvalPolicy: "never"`, `sandbox: "read-only"`.
4. Codex startup instrumentation: `threadStartMs`, `threadResumeMs`, `usedThreadStart`, `usedThreadResume`, `reusedPooledAppServer`.
5. App-server pool foundation: reuse idle discovery app-server for same `cwd`.
6. Non-blocking prewarm/session ensure: separate session ensure worker, in-flight session ensure `Deferred` join, visible send can join in-flight prewarm.
7. Streaming correctness fix: `ProviderRuntimeIngestion` tracks assistant delivery mode per thread/turn, not globally.

Focused validations passed:

```bash
cd apps/server && bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts
cd apps/server && bun run test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
cd apps/server && bun run typecheck --pretty false
bun run lint
bun run fmt:check
```

## Observed Problem

Normal chat responses appear fast. Review chat still spends too long showing “Starting review agent...” before first assistant content appears.

Current understanding: streaming is not the main issue anymore. The likely delay is before first provider delta: review thread resolution/create, prewarm/session ensure, cold Codex `thread/start`, first review prompt includes PR context, missed reuse of loaded provider thread/resume cursor, or prewarm not happening early enough in `ReviewPrView`/`ReviewPrSidebar`.

## Exact Questions

1. What is the actual critical path from clicking send in review chat to first assistant delta?
2. Where does review chat differ from normal chat in ways that explain latency?
3. Is prewarm triggered early enough and does it actually warm the same provider session used by visible send?
4. Are we reusing/resuming Codex provider threads correctly for review chat, or still paying `thread/start` too often?
5. What minimal implementation would produce a 10x improvement on the warm path?
6. What tests should be added or changed to lock this down?

## Constraints

- Preserve normal chat behavior.
- Preserve review chat PR-head invalidation semantics.
- Do not reintroduce context injection that blocks visible turns.
- Must keep streaming assistant deltas immediate.
- Prefer focused, deterministic tests over broad e2e.
- Avoid broad architecture rewrites unless clearly necessary.
- Keep public contracts backward-compatible unless essential.

## Desired Output

Return:

1. Critical path map with file/function names and where latency can accrue.
2. Ranked bottlenecks with evidence from code.
3. Minimal concrete patch plan.
4. Regression tests, exact files and scenarios.
5. Risky assumptions and unknowns, especially around Codex app-server behavior.
6. Timing instrumentation plan for UI send click, review thread resolved, session ensure start/end, provider `sendTurn`, Codex `thread/start`/`thread/resume`, first `content.delta`, and first rendered assistant text.
