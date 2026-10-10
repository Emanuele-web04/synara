# Synara PR #357 — Final code-quality, ACP, and provider audit

**Audit date:** 2026-07-15
**PR:** [#357 — Audit and harden code quality across desktop and server paths](https://github.com/Emanuele-web04/synara/pull/357)
**Remote head reconciled before closeout:** `e864533a3400a3cdcfb4102ff356088a1c48fdd7`
**Base:** `main`
**Status:** the verified closeout was published in `b92f585f4`. The PR becomes merge-ready when
replacement CI is green on the final head. A real Computer Use rerun remains pending because the
backend was unavailable; Playwright fallback evidence is recorded below.

## Executive decision

The branch is materially better than the baseline. It removes competing owners, makes provider and
orchestration delivery more durable, centralizes process teardown, moves ACP wire ownership to the
official SDK, and adds broad regression coverage. The remaining risks are no longer vague
“spaghetti code” complaints; they are specific lifecycle and resource-boundary problems.

The ACP architecture should remain:

```text
Provider subprocess
        │ ACP over stdio
        ▼
Official @agentclientprotocol/sdk
  - NDJSON framing
  - JSON-RPC correlation and dispatch
  - ACP validation and cancellation
        │ narrow Synara adapter
        ▼
Effect runtime
  - process Scope and teardown proof
  - bounded queues and backpressure
  - typed application errors
  - provider policy and normalized events
        │
        ▼
Durable orchestration journal → projections → WebSocket → UI
```

This is not a dirty dual stack. It becomes dirty only if the official SDK and `effect-acp` both own
wire parsing, JSON-RPC, or protocol evolution. The production wire has already been cut over to the
official SDK. `effect-acp` now survives only as a generated schema/error compatibility layer and can
be removed in a later, contained cleanup.

## Scope and evidence

This report combines:

- repository inspection across server, web, desktop, contracts, shared packages, migrations, and
  the residual `effect-acp` package;
- the historical audit and branch handoff, reconciled against the current code instead of copied;
- the PR diff: 429 files, +46,499 / -15,489 lines at the reconciled remote head;
- focused and full browser regression work around orchestration, attachments, migrations, provider
  lifecycle, RPC negotiation, reconnects, and multi-socket fixtures;
- live browser-controlled provider smoke tests against an isolated dev instance;
- server logs and per-process CPU/RSS samples;
- the recorded synthetic ACP wire benchmarks under `benchmarks/acp-wire/`;
- the official ACP protocol and TypeScript SDK documentation.

The requested Computer Use backend could not start (`Sky Computer Use service startup request
failed`). The UI matrix below therefore used the repository's Playwright browser-control workflow as
a fallback. Results are real end-to-end browser interactions, but they must not be described as a
successful Computer Use run.

## Merge-readiness summary

| Area                 | Result                                                                          | Merge interpretation                               |
| -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Git mergeability     | GitHub reports `MERGEABLE`                                                      | No branch conflict at the audited head             |
| CI at audit snapshot | Main CI failed in browser fixtures; Windows and release smoke passed            | Local closeout contains the matching fixture fixes |
| Workspace suite      | All packages passed; server: 210 files and 2,125 tests passed, 7 skipped        | Pass                                               |
| Stable browser suite | Exact synced tree: 24 files; 157 passed; 11 skipped                             | Pass                                               |
| Provider UI smoke    | 6 passed, 1 runtime-auth failure, 2 unavailable                                 | Functionality is broad; health semantics need work |
| ACP providers        | Cursor, Droid, and Grok returned exact expected replies                         | Shared official-SDK foundation works               |
| Shutdown             | Server, Vite, and every tested provider child exited after Ctrl-C               | Pass                                               |
| Resource behavior    | OpenCode peaked at four processes in the broad run; clean reload reused one PID | Follow-up measurement; not a PR regression         |
| Local closeout diff  | Regression and browser-fixture improvements published in `b92f585f4`            | Await replacement CI                               |

### Verification chronology

- The full `bun run test` workspace gate passed on `8afe33d` plus the local closeout diff: all nine
  tasks succeeded. The serial server suite passed 210 files and 2,123 tests, with two files and
  seven tests skipped by platform/probe policy.
- The PR advanced several times during verification, ending at `e864533a3`. This worktree was
  fast-forwarded without losing the local closeout. The incoming commits make WebSocket disposal
  await Effect scope/runtime teardown and strengthen browser readiness/optional-store fixtures.
- On the combined `8bb6c1c` tree, `ProviderCommandReactor.test.ts` passed 79/79,
  `wsTransport.test.ts` passed 9/9, and the stable browser suite passed 157/157 with 11 skipped.
- The remote main CI at `8bb6c1c` failed seven assertions across `ChatView.browser.tsx` and
  `EventRouter.browser.tsx`. All failures are in the fixture ownership/hydration paths already
  covered by the local closeout. After reconciling `e864533a3`, the exact combined stable suite
  passed again: 24/24 files, 157/157 tests, and 11 skipped.
- The ACP closeout replaced the unscoped incoming reader with a scope-owned 64-chunk queue, added an
  8 MiB incoming-frame limit, and propagated Web Stream cancellation back to the Effect fiber. The
  ACP and OpenCode focused suites pass 54/54 after this change.
- The first bundled post-ACP run passed eight of nine Turborepo tasks, including all non-server
  package tests. The server task was interrupted with code 130 when the wrapper shut down after
  14 minutes; no assertion had failed. The exact combined tree then passed the server suite in
  isolation: 210 files and 2,125 tests passed, with two files and seven tests skipped.
- After reconciling the final remote WebSocket teardown commit, the full web unit suite also passed:
  219 files and 2,681 tests. This separates the earlier wrapper interruption from product behavior.
- Final exact-tree static checks passed: `bun fmt`; `bun lint` with 223 warnings and zero errors;
  and `bun typecheck` with all eight workspace tasks successful.
- The first browser attempt on the exact tree was terminated by resource contention with a browser
  suite in another worktree. No tests had run. After that unrelated suite exited, the isolated retry
  passed; this is recorded as environment noise, not a product failure.

## Provider smoke-test matrix

Each runnable provider received a harmless prompt asking for one exact token and no tool use. The
browser header was checked after dispatch so a sticky draft model from the previous provider could
not be mistaken for the active provider.

| Provider     | Path/model exercised            | Result                            | Observed process/resource notes                                                                                                                                                                                            |
| ------------ | ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex        | GPT-5.5, medium                 | **Pass** — `PROVIDER_OK_CODEX`    | Multiple app-server wrapper/native pairs appeared during discovery and session use; individual wrappers were about 35–37 MiB RSS and native children about 48–76 MiB in sampled idle states.                               |
| Claude       | Claude Sonnet 5, high           | **Pass** — `PROVIDER_OK_CLAUDE`   | About 346 MiB RSS shortly after launch and 244 MiB idle in a later sample. The SDK logged that `canUseTool` is shadowed by `bypassPermissions`; expected in full-access mode, but noisy.                                   |
| Cursor (ACP) | OpenAI GPT-5.6 Sol              | **Pass** — `PROVIDER_OK_CURSOR`   | A transient launch sample showed two ACP roots plus two worker servers (roughly 940 MiB combined); one pair later remained near 64–66 MiB each and eventually exited. Treat as suspected overlap, not a proven leak.       |
| Droid (ACP)  | Auto Model                      | **Pass** — `PROVIDER_OK_DROID`    | Roughly 230 MiB during the turn; later idle samples ranged around 59–93 MiB.                                                                                                                                               |
| Grok (ACP)   | Grok Composer 2.5 Fast          | **Pass** — `PROVIDER_OK_GROK`     | Roughly 55–78 MiB RSS after the turn.                                                                                                                                                                                      |
| OpenCode     | OpenAI GPT-5.6 Luna Fast        | **Pass** — `PROVIDER_OK_OPENCODE` | The broad run observed four warm `opencode serve` processes (~1.56 GiB aggregate). A clean recheck of the saved thread plus two reloads reused one PID; RSS moved from ~426 to 651 MiB, then ~135 MiB after browser close. |
| Pi           | ChatGPT Plus/Pro → GPT-5.6 Luna | **Fail**                          | UI advertised the model, but dispatch failed with `No API key for provider: openai-codex`.                                                                                                                                 |
| Gemini       | Disabled in UI: “Sign in”       | **Not runnable**                  | Health cache reported installed but unauthenticated.                                                                                                                                                                       |
| Kilo         | Disabled in UI: “Unavailable”   | **Not runnable**                  | Health command failed under Bun with `SyntaxError: Exported binding 'G9' needs to refer to a top-level declared variable`.                                                                                                 |

### CPU and memory interpretation

These are diagnostic samples, not production benchmarks:

- the isolated dev tree was about 2.3 GiB RSS before all providers were exercised, including roughly
  1.1 GiB for Vite and already-warm provider discovery processes;
- selected dev processes were about 6.6% CPU at the baseline sample;
- Cursor launch briefly showed ACP roots at about 20.5% and 7.2% CPU, with one worker near 59.5%;
- after all tests, direct children of the Synara server totalled about 1.84 GiB RSS, dominated by
  OpenCode;
- a clean OpenCode-only recheck retained one server PID across two page reloads. The process remains
  warm for the configured five-minute TTL, which predates this PR's merge-base, and server shutdown
  still removed it;
- RSS double-counts shared pages and dev-mode Vite is not representative of the packaged app;
- provider/model network latency dominates user-visible response time, so protocol throughput alone
  cannot establish that the app “feels twice as fast.”

### Log result

The isolated `server.log` showed successful migrations, projection bootstrap, server startup, and
provider starts. Browser console capture reported zero errors. Provider protocol event logging was
disabled by the default dev configuration, so this run does not certify raw ACP frame logs. Shutdown
removed all sampled provider children and released both isolated ports.

## ACP decision: official SDK or Effect ACP?

### Decision

Use the official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
as the sole protocol/wire authority and keep Effect above it as Synara's lifecycle and application
runtime. Do not restore the deleted `effect-acp` wire/client implementation and do not add a
provider-selectable fallback.

The current repository already follows this decision:

- `apps/server/package.json` pins `@agentclientprotocol/sdk` at `1.2.1`;
- `AcpSessionRuntime.ts` constructs `OfficialAcp.client({ name: "synara" })`, registers client
  handlers, and connects through `OfficialAcp.ndJsonStream(...)`;
- Cursor, Droid, and Grok all build on that shared runtime;
- production imports from `effect-acp` are limited to `schema` and `errors` compatibility types;
- the previous custom agent/client/protocol/RPC/terminal/stdio implementation has been deleted.

This matches upstream guidance: ACP wire compatibility is negotiated using `protocolVersion` and
capabilities, not inferred from a package version. The official TypeScript library exposes the
client/agent builders, handlers, streams, validation, and connection lifecycle that Synara would
otherwise have to maintain itself.

### What changes compared with the old Effect ACP implementation?

| Concern                        | Before                                          | Current target                                                      |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------- |
| ACP schemas and method names   | Generated/private `effect-acp` ownership        | Official SDK                                                        |
| NDJSON and JSON-RPC            | Private framing/correlation/dispatch            | Official SDK                                                        |
| Protocol upgrades              | Synara had to regenerate and reconcile behavior | Follow the official SDK and negotiate protocol capabilities         |
| Process lifecycle              | Effect                                          | Effect, unchanged                                                   |
| Backpressure and queue budgets | Effect/custom transport                         | Synara-owned bounded bridge around the official SDK                 |
| Canonical provider events      | Synara adapters                                 | Synara adapters, unchanged                                          |
| Error surface                  | Effect ACP errors                               | One small local Effect error translation around official SDK errors |

### Is it faster, better, and lighter?

- **Better:** yes for compatibility, maintenance, ecosystem behavior, and removing duplicated
  protocol ownership.
- **Faster:** often for small normal ACP traffic, but not universally. Recorded synthetic results
  show +124.6% throughput for sequential 256-byte requests and +110.2% for 32-way concurrent small
  requests. Large 64 KiB notifications were 48.6% slower.
- **Lighter:** not consistently. The official SDK used less peak RSS in the recorded slow-consumer
  and large-notification cases, but the concurrent-request run reached 784.8 MiB versus 225.6 MiB for
  the old Effect implementation.
- **Visible app speed:** likely little direct difference because provider/model latency, process
  startup, persistence, and React rendering dominate. The OpenCode subprocess problem is much more
  important than choosing between two TypeScript JSON-RPC parsers.

## Prioritized findings and implementation plans

### P1 follow-up — OpenCode warm pools can retain high RSS across configurations

**Evidence**

- The broad live run observed four simultaneous `opencode serve` processes and about 1.56 GiB
  aggregate RSS while several provider/discovery paths were warm.
- A clean OpenCode-only recheck loaded the saved thread and reloaded it twice. All three operations
  reused PID `37404`; no per-reload multiplication occurred.
- `apps/server/src/provider/opencodeRuntime.ts` intentionally retains an idle server for five minutes
  and keys pools by binary/spec/cwd/server options. Both the pool and TTL already exist at PR
  merge-base `511a2eb5feb80ead47152d10797c6052ed036a67`.
- Closing the browser reduced the retained process from roughly 651 MiB to 135 MiB; stopping Synara
  removed it and released both isolated ports.

**Risk**

Each distinct normalized configuration can retain a heavy warm process. This deserves packaged-mode
measurement and a product memory budget, but current evidence does not prove a same-key leak and it
is not a regression introduced by PR #357.

**Plan**

- [ ] Add structured spawn/reuse/release logs containing a redacted pool identity, normalized cwd,
      caller purpose,
      refcount, PID, and idle deadline.
- [ ] Reproduce in a packaged or server-only build and record process count/RSS after: initial
      health, model picker, agent list, command list, first turn, and five-minute idle expiry.
- [ ] Normalize the pool key once; omit values that do not change server identity and resolve cwd
      consistently before key construction.
- [ ] Confirm concurrent acquisition coalesces by normalized identity and share one discovery
      snapshot for
      models, agents, commands, providers, and credentials.
- [ ] Reuse an active thread's server for matching discovery requests.
- [ ] Add an integration test proving concurrent model/agent/command discovery plus session start
      spawns at most one local server for one normalized configuration.
- [ ] Acceptance: one live server per normalized configuration, no orphan after runtime shutdown,
      and a measured idle RSS budget documented for packaged mode.

### Resolved P0 — ACP incoming transport is scope-bound and backpressured

**Evidence**

- The outgoing path remains bounded to 256 chunks.
- The incoming producer now runs with `Effect.forkIn(runtimeScope)` and feeds a bounded 64-chunk
  queue. `ReadableStream.pull` takes one queued chunk per demand signal.
- `ReadableStream.cancel` interrupts the producer fiber and shuts down the queue; runtime scope
  finalization also shuts the queue down.
- A stateful guard rejects any incoming unterminated ACP frame above 8 MiB before the official SDK's
  line buffer can grow without limit.
- ACP runtime/conformance and OpenCode focused suites pass 54/54 after the change.

**Risk**

The unscoped `Effect.runFork` and eager `controller.enqueue` path have been removed. The raw bridge
now has explicit lifecycle, chunk-admission, and maximum-frame boundaries.

**Plan**

- [x] Replace `ReadableStream.start` + `Effect.runFork` with one scope-owned adapter whose producer
      pauses when the Web Stream high-water mark is reached.
- [x] Propagate SDK cancellation/stream cancel back to the Effect fiber and child stdout.
- [x] Define chunk and frame budgets: 64 queued raw chunks and an 8 MiB maximum incoming frame.
- [x] Test split-frame accounting and oversized unterminated-frame rejection; retain the existing
      production-adapter coverage for child exit, stream error, pending request rejection, and scope
      teardown.
- [ ] Optional follow-up: add a slow/no-consumer heap soak to the ACP benchmark harness.
- [x] Acceptance: admission is bounded and no bridge fiber is created outside `runtimeScope`.

### P1 — Pi advertises models that cannot authenticate at dispatch

**Evidence**

- `apps/server/src/provider/Layers/ProviderHealth.ts:1567-1622` deliberately performs only an
  advisory CLI version probe and returns `available: true`, `authStatus: "unknown"` even when it
  cannot validate credentials.
- `apps/server/src/provider/Layers/PiAdapter.ts:2349-2390` lists discoverable registry models without
  returning per-model credential readiness.
- The browser offered “ChatGPT Plus/Pro (Codex Subscription) → GPT-5.6 Luna”; the first turn failed
  with `No API key for provider: openai-codex`.

**Plan**

- [ ] Separate `installed`, `discoverable`, and `runnable` in provider/model capability results.
- [ ] Ask Pi's auth storage/model registry for credential readiness without starting a session.
- [ ] Disable or annotate models that need missing credentials; expose the exact remediation.
- [ ] Revalidate at server dispatch so stale UI state fails before a thread is published as ready.
- [ ] Add tests for missing, expired, custom-provider, OAuth/subscription, and environment-key auth.
- [ ] Acceptance: every enabled Pi model either completes a no-tool smoke prompt or is visibly
      unavailable before send.

### P1 — Provider health conflates “binary installed” with “usable”

OpenCode, Droid, Grok, and Pi can be marked available with authentication `unknown`. This is useful
for discovery but too weak for the model picker. Generalize the Pi plan into a shared capability
state without forcing every provider into the same authentication mechanism.

- [ ] Preserve raw health diagnostics but expose `installed`, `authenticated`, and `runnable`
      independently.
- [ ] Make UI enablement depend on `runnable` when it is known; use a warning state when it is not.
- [ ] Keep dispatch-side validation authoritative.

### P2 — Finish the ACP compatibility-layer deletion

`packages/effect-acp` now contains only generated schemas and errors, but about two dozen server and
test imports still depend on those paths. This is not a runtime dual wire, yet it leaves two type
authorities and a 10k-line generated schema in the repository.

- [ ] Introduce one local `AcpRuntimeError` translation module based on official SDK errors.
- [ ] Use official SDK request/response types at the runtime seam; keep Effect codecs only where
      runtime decoding is genuinely needed for extensions or persisted data.
- [ ] Migrate adapters in this order: shared runtime/model helpers, Grok, Droid, Cursor, tests.
- [ ] Delete `packages/effect-acp`, its workspace dependency, and generated schema only after zero
      imports and the ACP conformance suite pass.
- [ ] Do not recreate official SDK types in a new Synara package.

### P2 — Split responsibility hotspots only at stable seams

The largest remaining runtime files are `ChatView.tsx` (11,401 lines), `Sidebar.tsx` (7,769),
`composerDraftStore.ts` (5,168), `store.ts` (4,664), `OpenCodeAdapter.ts` (4,608),
`ClaudeAdapter.ts` (4,522), `ProviderRuntimeIngestion.ts` (3,546), and `ProviderHealth.ts` (2,608).
File size alone is not the task; mixed ownership is.

- [ ] Extract OpenCode pure model/inventory normalization from process/session ownership first, then
      share one discovery result as required by `P0-OPENCODE`.
- [ ] Split provider health into provider-specific probes plus one cache/merge coordinator; retain a
      single public service and shared stabilization policy.
- [ ] Move ChatView's draft-project synchronization, attachment upload lifecycle, provider discovery,
      and composer keyboard/voice controllers into tested hooks/modules only where the extracted owner
      has its own inputs and lifecycle.
- [ ] Keep transcript live-scroll ownership one-way and preserve the repository's scroll guardrails.
- [ ] Require every extraction to delete duplicate state/effects from the original file and remain
      net-neutral or net-negative in runtime lines.

### P2 — PR reviewability is itself a correctness risk

At the reconciled remote head the PR changes 429 files and is net +31,010 lines. Tests and
documentation account for a substantial share, but the change remains hard to verify as one unit
even when each subsystem is locally correct.

- [ ] Produce a subsystem review ledger: release/desktop security, persistence/migrations,
      orchestration/delivery, provider lifecycle, ACP, web transport/state, and automation/Git.
- [ ] Record reviewer sign-off and focused commands per subsystem.
- [ ] If the branch cannot be split safely because migrations and contracts are already coupled,
      merge only after every subsystem has an explicit reviewer and rollback note.

## Completed closeout work

The following are fixes, not open audit items:

- [x] Projection snapshots tolerate nullable legacy sequence rows and tests use the canonical shape.
- [x] Provider runtime journal ingestion does not kill the stream on a recoverable append/drain
      failure and logs the failure with event identity.
- [x] Managed attachments support edit/resend for the same message while rejecting cross-message
      reuse; retry validates ownership before dispatch.
- [x] Migration, provider-service, Cursor, and Droid fixtures match the current environment and
      lifecycle contracts.
- [x] Browser fixtures implement Effect RPC negotiation, keep long-lived streams open, bind stream
      request IDs to the correct feature socket, and stop reconnecting disposed sockets.
- [x] Chat browser tests wait for real hydration/index readiness and provide managed upload/cancel
      handlers instead of racing an incomplete mock.
- [x] ACP incoming stdout is scope-owned, demand-driven through a bounded queue, cancellable, and
      protected by an 8 MiB maximum-frame guard.
- [x] Isolated dev shutdown proved that all sampled provider process trees exit.

## Integrated TODO and merge gate

### Required before merging PR #357

- [x] Publish the reconciled local closeout diff and this audit document to the PR branch
      (`b92f585f4`).
- [x] Re-run and record the final repository unit/integration suite after the ACP transport
      closeout. Eight bundled tasks passed before the wrapper interrupted the serial server task;
      the server then passed in isolation (210 files, 2,125 passed, 7 skipped), and the reconciled
      web package passed in full (219 files, 2,681 passed).
- [x] Run one final bundled `bun fmt`, `bun lint`, and `bun typecheck` pass on the publishable tree:
      formatting passed, lint reported 223 warnings and zero errors, and typecheck passed 8/8 tasks.
- [x] Run the stable browser suite: 24 files, 157 passed, 11 skipped.
- [x] Diagnose the failed remote browser job: seven fixture assertions across `ChatView` and
      `EventRouter`; the local closeout contains the matching hydration/RPC ownership fixes.
- [ ] Confirm replacement GitHub CI, Windows Process Regression, and required review checks are green
      on the exact final head.
- [x] Recheck OpenCode in isolation and classify the high-RSS warm pool as a pre-existing follow-up,
      not a same-key multiplication regression or PR merge blocker.
- [x] Fix `P0-ACP` incoming scope/backpressure with bounded admission, scope ownership,
      cancellation, and a maximum-frame guard.
- [x] Document Pi's false-positive availability as a pre-existing capability/preflight gap. The
      missing local credential does not make the PR's lifecycle fixes unsafe to merge.

### Follow-up order

1. `P1-OPENCODE` packaged-mode memory measurement and normalized pool telemetry.
2. `P1-PI` and shared runnable/auth capability semantics.
3. ACP slow/no-consumer heap soak in the benchmark harness.
4. Residual `effect-acp` schema/error deletion.
5. Responsibility-based hotspot splits.
6. A real Computer Use provider rerun when the backend is available.

## Definition of done

The audit is closed only when:

- the official SDK is the single ACP wire authority;
- all provider child processes have explicit owners, bounded admission, and proven teardown;
- the UI never labels a provider/model runnable when the server already knows it cannot dispatch;
- one OpenCode configuration cannot multiply local server processes through parallel discovery;
- final checks are green on the exact commit being merged;
- each remaining large file has one coherent owner or a measured reason to stay combined.
