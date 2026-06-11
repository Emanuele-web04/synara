# Codex App Server Session Startup Latency Research

## Bottom Line

The 7s average is almost certainly real work inside Codex session construction, not stdio JSON-RPC overhead. `thread/start` is the wrong boundary to treat as a cheap "conversation record create." It loads config, applies permission/sandbox/session overrides, starts a Codex core session, initializes persistence/auth/MCP/plugin/skill-related state, and only then returns the thread response. Upstream source already has useful `session_init.*` tracing spans; Synara should instrument those before guessing.

The best path is:

1. **Ship the UX fix first:** render the user's first message immediately, show an assistant "starting agent..." placeholder, then stream when the session is ready.
2. **Stop running one app-server process per review thread:** run a long-lived app-server per stable workspace/repo/auth/config key. This is an **enabler** for thread reuse, not the fix itself -- it saves spawn+initialize (~0.5-1s) but does not attack the 7s `thread/start` cost.
3. **Reuse loaded Codex threads for review Q&A when isolation allows it.** This is the real backend fix. Process reuse alone will not eliminate the 7s if every review still calls `thread/start`.
4. **Test a review-only profile** (in parallel with 2/3): `ephemeral`, read-only/no-write sandbox, no required MCP, no nonessential plugins/skills/apps, low effort/faster model for the first answer.
5. **Use `thread/resume` only when you actually have a prior thread ID, ideally still loaded in the same process.** Cold resume can still pay most of the session init cost.

Source: upstream OpenAI Codex docs/source and CodexMonitor's public repo.

---

## Recommended Implementation Order

### Phase 0: Add measurement first

Before backend changes, add enough instrumentation to prove which path wins. Track:

```ts
{
  clickToUserMessageRenderedMs,
  clickToPlaceholderRenderedMs,
  sessionEnsureStartedMs,
  appServerProcessAgeMs,
  initializeMs,
  discoveryMs,
  threadStartMs,
  threadResumeMs,
  turnStartMs,
  firstDeltaMs,
  turnCompletedMs,
  usedThreadStart,
  usedThreadResume,
  threadWasAlreadyLoaded,
  ephemeral,
  sandboxMode,
  mcpServerCount,
  requiredMcpServerCount,
  pluginCount,
  skillCount,
  model,
  effort,
  repoId,
  baseSha,
  headSha,
}
```

Without this, the team will argue from vibes. This is cheap and prevents wasting time.

### Phase 1: Immediate message render

Ship this first. The UI should not wait for Codex session readiness to show the user's message. Persist/render the user message immediately, then show a transient assistant state:

```text
Starting review agent...
```

Then replace it with:

```text
Reading PR context...
Thinking...
Streaming response...
```

This is the highest ROI change because it turns dead air into visible progress. It also de-risks the rest: even if backend latency still exists, the product feels much less broken.

### Phase 2: Long-lived app-server pool

One `codex app-server` process per repo/workspace/auth/profile instead of per thread.

This does **not** solve the main 7.5s average by itself. It mainly removes process spawn + initialize + discovery/cache warmup (~0.5-1s). The real value is that it makes Phase 3 possible: a loaded/resumable thread only helps if the app-server process survives.

Key the pool by:

```ts
type CodexAppServerPoolKey = {
  userId: string;
  authAccountId: string;
  orgId: string;
  repoId: string;
  workspaceRoot: string;
  codexHome: string;
  modelProvider: string;
  permissionProfile: string;
};
```

Use a bounded idle TTL, probably 30 minutes to match Codex's own loaded-thread behavior.

### Phase 3: Thread reuse / loaded resume

This is the real backend fix. Reuse should be scoped to a stable PR context:

```ts
type ReviewCodexThreadKey = {
  userId: string;
  repoId: string;
  pullRequestId: string;
  baseSha: string;
  headSha: string;
  model: string;
  permissionProfile: string;
};
```

Invalidate on:

- new commits / force push
- base branch change
- repo checkout/worktree change
- model/profile change
- permission/sandbox config change
- user/auth change

Enforce one active turn per reused Codex thread unless you intentionally support concurrent queued questions. Do not let two UI chat threads race through the same Codex thread without a queue.

Context bleed risk: reusing one Codex thread across multiple review chats can leak prior review discussion into later answers. That may be desirable for a PR-level assistant, but bad for isolated review threads. Key strictly and invalidate aggressively.

### Phase 4: Review-only profile (parallel with Phase 2/3)

This is a benchmark/config experiment, not a huge architecture change. Run it in parallel.

Test:

```json
{
  "ephemeral": true,
  "sandbox": "readOnly",
  "approvalPolicy": "never",
  "serviceName": "synara_review_chat"
}
```

And test disabling nonessential MCP/plugins/skills/apps for review chat.

But be careful: "no MCP/plugins" is only safe if review chat truly does not depend on those paths. If PR context comes through MCP or a plugin, disabling it will break functionality.

Also, `ephemeral: true` has an audit/debug tradeoff. It may be fine if Synara already persists the transcript and review context. It is not fine if you rely on Codex's own persisted rollout for recovery, history, or compliance.

---

## Benchmark Matrix

Run at least 30 samples per cell, same host class, same repo size, same Codex version. **Pick the backend path based on p50/p95 data, not just architectural taste.**

| Experiment                                                       | Expected result                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A. Cold process + `thread/start`                                 | Baseline.                                                                                      |
| B. Warm process + `thread/start`                                 | Shows how much child process/init/discovery matters. Guess: helps, but does not remove the 7s. |
| C. Warm process + `thread/resume` on loaded thread               | Expected biggest win.                                                                          |
| D. Warm process + `thread/resume` on not-loaded persisted thread | May still be slow because session has to be reconstructed.                                     |
| E. Warm process + `thread/start` + ephemeral/read-only/no-MCP    | Measures how much persistence/state DB and plugin warmup cost.                                 |
| F. Warm process + loaded thread + review-only profile            | Combination of C + E; likely the fastest path.                                                 |

Also test:

- `thread/fork` from a loaded context thread (product isolation test; do not assume it is cheap)
- Required MCP on/off (slow MCP init may be part of tail latency)
- Model/effort/service tier variants (mostly affects first response latency, not start latency)

And collect/forward upstream spans:

```text
session_init.thread_persistence
session_init.state_db
session_init.auth_mcp
session_init.plugin_skill_warmup
session_init.thread_name_lookup
session_init.network_proxy
```

Those span names already exist upstream, so this should be measurement plumbing, not invasive instrumentation.

---

## What `thread/start` Actually Does

Public docs describe the protocol at a high level: clients initialize once per connection, then call `thread/start`, `thread/resume`, or `thread/fork`; `thread/start` creates a new thread and automatically subscribes the connection to that thread's events. ([OpenAI Developers][1])

Upstream app-server source shows `thread_start_inner` accepts a large `ThreadStartParams` surface: model, model provider, service tier, `cwd`, workspace roots, approval policy, sandbox, permissions, config overrides, service name, base/developer instructions, dynamic tools, personality, `ephemeral`, thread/session source, and environment selections. It rejects combined `sandbox` and `permissions`, builds config overrides, sets `ephemeral`, then spawns the actual `thread_start_task`. ([GitHub][2])

That task immediately loads effective config with the supplied overrides. This is a strong signal that `thread/start` includes configuration resolution and policy setup, not just "insert a row and return a thread id." ([GitHub][2])

Inside core session initialization, upstream source exposes spans for the main cold-start buckets:

| Bucket                             | What it implies                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `session_init.thread_persistence`  | Create/resume the live thread store; skipped when `config.ephemeral` is true.  |
| `session_init.state_db`            | Initialize local state DB; skipped when `config.ephemeral` is true.            |
| `session_init.auth_mcp`            | Resolve auth and effective MCP servers/statuses.                               |
| `session_init.plugin_skill_warmup` | Warm plugins and skills for the session.                                       |
| `session_init.network_proxy`       | Start managed network proxy if network permission requirements are configured. |
| `session_init.thread_name_lookup`  | Hydrate user-visible thread title from stored thread state.                    |

Those spans are visible in `codex-rs/core/src/session/session.rs`; the code joins persistence, state DB, auth/MCP, and plugin/skill warmup as independent futures before continuing session construction. ([GitHub][3])

Likely breakdown:

```text
thread/start
  -> parse and validate params
  -> load effective config + overrides
  -> resolve cwd/trust/permissions/sandbox
  -> create Codex core session
      -> thread persistence / state DB
      -> auth + MCP server resolution
      -> plugin + skill warmup
      -> shell/hooks/network proxy/session services
  -> emit/return configured thread
  -> subscribe client to thread events
```

It is probably **not** doing the first model generation. That happens after `turn/start`. But it can still touch network/auth/MCP/plugin paths depending on the config.

---

## Measured Data

From production logs (`codex app-server startup timings`):

| Phase          | Avg  | Min  | Max   | % of Total |
| -------------- | ---- | ---- | ----- | ---------- |
| `thread/start` | 7.0s | 1.6s | 15.4s | 93%        |
| `initialize`   | 0.5s | 0.2s | 0.9s  | 7%         |
| `discovery`    | ~0s  | 0s   | 0.01s | 0%         |

- 10 samples from review chat sessions (June 8, 2026)
- Discovery is fast because `usedDiscoveryCache=true` on most calls
- `thread/start` variance is high (1.6s to 15.4s) -- likely depends on model, system load, or cold-start state

---

## How Synara Starts a Codex Session

Full path in `apps/server/src/codexAppServer.sessionOpen.ts`:

1. **Spawn `codex app-server` process** (`createTransport`) -- spawns `codex` CLI as a child process with JSON-RPC over stdio
2. **`initialize` RPC** -- LSP-style handshake, sends `buildCodexInitializeParams()`, waits for response (~0.5s)
3. **`resolveStartupDiscovery`** -- calls `skills/list` and `model/list` on first start, caches for subsequent sessions (~0s when cached)
4. **`thread/start` or `thread/resume` RPC** -- tells the codex process to open a new agent thread (or resume an existing one). This is where the 2-15s delay occurs.
5. Session transitions: `connecting` -> `ready`

The `sendRequest` function (`codexAppServerManager.ts:835`) has a default 20s timeout per JSON-RPC call.

---

## Current Architecture Constraints

- Synara runs one `codex app-server` process per provider session (per thread)
- Session startup is triggered by `thread.session.ensure` (prewarm) or implicitly by `thread.turn.start` (cold start)
- The `ProviderCommandReactor` processes intent events through a serial `DrainableWorker` queue, so session ensure blocks turn start
- Review chats currently create a fresh session per review thread -- no session reuse across reviews of the same repo
- Every review chat discards process warmth, initialize handshake state, model/skills/discovery cache, loaded thread cache, and MCP/plugin/session warm state when the process exits

---

## Architecture Finding

The current architecture fights the app-server's own caching model.

The docs expose `thread/loaded/list`, and `thread/unsubscribe` keeps a no-subscriber thread loaded until it has no subscribers and no activity for **30 minutes** before unloading it. ([OpenAI Developers][1])

That cache only helps if the app-server process survives across chats. If Synara starts one child process per provider session/thread and tears it down with the review chat, then every review chat discards:

```text
process warmth
initialize handshake state
model/skills/discovery cache
loaded thread cache
MCP/plugin/session warm state
```

A better shape:

```text
Synara review chat thread(s)
        |
        v
ReviewAgentPool key:
  user + auth + org + repo + worktree + base/head SHA + model + permission profile
        |
        v
Long-lived codex app-server process
        |
        +-- repo/PR context thread, reused/resumed
        +-- optional forked threads when isolation is required
```

**Important:** a warm process is not enough. If the app-server is warm but every review creates a brand-new Codex thread via `thread/start`, you still pay most of the session construction cost. The real win is reusing or resuming an already-created/loaded thread.

---

## Research Answers

| Question                                                      | Answer                                                                                                                                                                                                                                                                                        | What Synara should do                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. What does `thread/start` do?**                           | Creates and configures a live Codex thread/session. Applies session params, loads config, then core session init performs persistence, state DB, auth/MCP, plugin/skill warmup, network proxy/hook setup.                                                                                     | Add timing around Codex's existing `session_init.*` spans. Without that, you only know the wrapper RPC is slow, not why.                                                                   |
| **2. Can it be made faster?**                                 | Yes, but not by optimizing stdio. The useful levers are removing work from session init: avoid required MCP, avoid plugin/skill warmup, test `ephemeral`, test read-only/external sandbox modes, use a faster model/low effort for first-token latency.                                       | Build a review-only start profile and benchmark it against current production params.                                                                                                      |
| **3. Can sessions be reused across review chat threads?**     | Yes, technically, but only if product semantics allow shared Codex state. A single repo/PR "review context thread" reused for Q&A can eliminate startup after the first load. Separate user-visible chat threads can still map to one Codex thread if Synara owns the UI transcript boundary. | Key reuse by user/auth/org/repo/worktree/base SHA/head SHA/model/permission profile. Add hard invalidation on PR context change.                                                           |
| **4. Can `thread/resume` replace `thread/start`?**            | Only when you already have a thread ID. `thread/resume` reopens an existing thread and accepts the same config overrides. It does not update `updatedAt` until a turn starts, and required MCP failure can still fail resume.                                                                 | Use `resume` for previously-created review threads. Expect the big win only when the same app-server process is still alive and the thread is still loaded.                                |
| **5. Is there lightweight context-only mode?**                | No official "context-only / no tools / answer-only" thread mode. There are lightweight read APIs, but they cannot answer: `thread/read` reads stored data without loading/resuming, and `thread/turns/list` pages history without resuming.                                                   | Approximate it with read-only sandbox, no required MCP/apps/plugins, no shell access, and possibly `ephemeral`.                                                                            |
| **6. What does CodexMonitor do?**                             | CodexMonitor is not one-process-per-thread. It spawns one `codex app-server` per workspace, resumes threads, tracks state, and selecting a thread always calls `thread/resume`. It also has an "Ask PR" flow that sends PR context into a new agent thread.                                   | Use CodexMonitor as evidence for workspace-level process lifetime. It does not appear to solve per-new-thread `thread/start` latency; it avoids paying process/initialize cost per thread. |
| **7. Startup-affecting config options?**                      | Meaningful knobs: `ephemeral`, `sandbox`/`permissions`, approval policy, model, service tier, dynamic tools, required MCP config, skills/plugin/app config, notification opt-outs, and `experimentalApi`. Lower-latency reasoning effort options exist in model metadata.                     | Add a "review chat start params" object and log it with every startup timing sample.                                                                                                       |
| **8. Can readiness be decoupled from first-message latency?** | Yes, and this should ship first. `thread/start`/`turn/start` readiness does not need to block rendering the user's message. The app can persist/render the user message immediately, create an assistant placeholder, then attach the Codex stream once ready.                                | Move UI state from "message sent only after provider ready" to "message accepted by Synara immediately; provider stream pending."                                                          |

---

## Hard Constraints / Risks

**Context bleed:** Reusing one Codex thread across multiple review chats can leak prior review discussion into later answers. That may be desirable for a PR-level assistant, but bad for isolated review threads.

**Stale PR context:** A reused thread must be invalidated on base/head SHA changes, force-pushes, repo checkout changes, or permission profile changes.

**Concurrency:** One loaded Codex thread probably should not run multiple independent turns concurrently. Queue per Codex thread or allocate a small pool of reusable threads.

**Audit/privacy:** If you switch to `ephemeral`, make sure Synara's own persistence is enough for audit/debug/compliance.

**Fork is not a free lunch:** `thread/fork` gives cleaner semantics, but docs describe it as creating a new thread from stored history, and source paths indicate it still creates a live thread. Benchmark it before relying on it as a speed optimization. ([OpenAI Developers][1])

---

## Key Source Files

- `apps/server/src/codexAppServer.sessionOpen.ts` -- `startSession()` function, the 5-step startup flow
- `apps/server/src/codexAppServer.turns.ts` -- `sendTurn()`, `injectThreadItems()`, `steerTurn()`
- `apps/server/src/codexAppServerManager.ts` -- `sendRequest()` (JSON-RPC over stdio, 20s default timeout), `createTransport()` (process spawn)
- `apps/server/src/codexAppServer.types.ts` -- `CodexAppServerStartSessionInput` and related types
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.session.ts` -- `ensureSessionForThread()`, `joinPendingSessionEnsure()`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.handlers.ts` -- `processSessionEnsureRequested()`
- `apps/web/src/lib/reviewChatThread.ts` -- `prewarmReviewChatThread()`, `sendReviewChatQuestion()`

## External References

[1]: https://developers.openai.com/codex/app-server "App Server -- Codex | OpenAI Developers"
[2]: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs "codex thread_processor.rs"
[3]: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/session.rs "codex session.rs"
[4]: https://github.com/Dimillian/CodexMonitor "CodexMonitor"
