# Plan: Execution-Runtime Abstraction (local · worktree · remote)
> Status: design, reviewed, approved-with-changes (rated 8.5/10). Code not yet written. Supersedes the intent of `.plans/03-split-codex-app-server-manager.md` and `.plans/10-unify-process-session-abstraction.md` (both predate the Effect / event-sourced rewrite and still reference `apps/desktop/`). Grounded in the current `apps/server` Effect architecture via a full codebase map (file:line citations throughout).
## Review outcome (incorporated below)
Direction approved. Six changes were required before building, all now folded into this revision:

1. **Sequencing:** extract the Codex transport **first** (PR 1), before contracts/projections. The highest risk is detaching the 3,353-line manager from local-process semantics, not schema design — prove the seam before building on it.
  
2. **Storage:** dedicated `projection_thread_runtime` + operational runtime tables, **not** a JSON `runtime` column on the wide/hot `projection_threads`. `OrchestrationThread.runtime` stays in the contract but is hydrated from a separate repository.
  
3. **Contract split:** only the read-model/plan-input types go in `packages/contracts`; the richer adapter/descriptor capability model stays server-internal initially so the API isn't locked too early.
  
4. **Defer** `runtimePlan`**:** prove the internal runtime mechanism (incl. fake remote) before exposing `runtimePlan` on public create/handoff/fork commands.
  
5. **Reactor purity:** `ProviderCommandReactor` must never know provider-specific ids/states (Daytona/Vercel/Modal/Cloudflare) — only `ExecutionRuntimeService` + `ProviderService`.
  
6. **Reconciler:** design `ExecutionRuntimeReconciler` for partial-failure recovery before real providers ship.
  
## Goal
Let a thread run its coding-agent provider inside a **local dir**, a **local git worktree**, or a **remote ephemeral/persistent runtime** (Daytona, Vercel Sandbox, Modal, Cloudflare). Agent providers (`ProviderKind`: Codex, Claude, …) stay exactly as they are. We add a separate **execution-runtime** axis describing _where_ the agent process runs.

Three axes that must never be conflated:

| Axis | Meaning | Where it lives today |
|---|---|---|
| `ProviderKind` | which coding agent | `orchestration.ts:50-60` (8 providers) |
| `RuntimeMode` | permission/sandbox policy | `orchestration.ts:197-199` (`approval-required` \| `full-access`) |
| **ExecutionTarget (new)** | where the agent process runs | does not exist yet |

`RuntimeMode` is permission policy, confirmed: it maps to Codex `approvalPolicy`+`sandbox` (`codexAppServerManager.ts:460-498`), Gemini mode id (`GeminiAdapter.ts:430-438`), Claude `bypassPermissions` (`ClaudeAdapter.ts:3092-3098`). It is **not** execution location. The execution location today is `cwd`, resolved separately in the reactor (`ProviderCommandReactor.ts:696-728` → `threadEnvironment.ts:34-44`).

* * *
## 0. The one keystone
Everything hinges on a single change:

> **Codex stops calling** `child_process.spawn` **directly. It receives an Effect-native JSON-RPC line transport from an execution target.**

Once a provider session can run against a _supplied_ transport instead of a locally-spawned process, "remote runtime" stops being an invasive rewrite and becomes a transport implementation + provider integration.

The codebase **already owns** the pieces this needs (the original handoff missed this): `packages/effect-acp` ships a stdio JSON-RPC transport (`_internal/stdio.ts` `makeChildStdio` → `RpcServer`/`RpcClient`) **and** an in-memory fake (`makeInMemoryStdio` returning input/output `Queue`s for process-free tests). Cursor/Grok/OpenCode/ACP already run JSON-RPC over Effect's `ChildProcessSpawner` (`effect/unstable/process`). Codex and Gemini are the only two raw-`node:child_process` holdouts.

Implementation principle for the extraction: **do not rewrite Codex protocol logic; replace only the process boundary.**

* * *
## Build order (authoritative)
Phases in §4 are a capability catalog. This is the order code lands. Each slice ≈ one PR. Prove the keystone, then build internal-first; public surface (`runtimePlan`) and real providers come last.

| PR | Slice | Gate before merge |
|---|---|---|
| 1 | **Codex transport extraction, local-only** (§3, catalog Phase 5). Manager off `node:child_process`; 3 spawn sites collapse to one transport-create; imperative bridge keeps protocol logic intact. | Codex works locally; all Codex tests green via local transport; no contracts/migrations/remote yet. |
| 2 | **In-memory / fake process transport** (catalog Phase 6, transport half). `makeInMemoryStdio`-driven Codex tests replace the `vi.spyOn`-on-privates seam. | Codex protocol exercised end-to-end against a scripted transport — proves the seam is transport-agnostic. |
| 3 | **`executionRuntime` public contracts + server-internal descriptors/registry/planner** (catalog Phases 1+3, split per review). | `bun typecheck`; planner rejects unsupported plans against descriptors; no provider calls. |
| 4 | **Runtime projection + persistence** (catalog Phases 2+7). Dedicated `projection_thread_runtime` + operational tables + migrations; `OrchestrationThread.runtime` hydrated from the new repo; runtime lifecycle events via the Appendix-B checklist. | Runtime state survives WS reconnect (snapshot + replay); shell snapshot shows status without full thread detail; existing thread projection untouched. |
| 5 | **Execution runtime service + fake remote runtime via an internal command path** (catalog Phase 6, runtime half). `ProviderCommandReactor` provisions via `ExecutionRuntimeService.ensureTargetForThread` then `ProviderService.startSession` — reactor stays provider-agnostic. | A `remote-runtime` thread provisions a fake instance through an **internal** command, runs Codex through the in-memory transport, streams logs, destroys cleanly. Tests cover PTY-like and non-PTY fakes. No public `runtimePlan` yet. |
| 6 | **Expose `runtimePlan`** on `ThreadCreate/Handoff/Fork` (catalog Phase 8) — only now that the internal mechanism is proven. | Existing callers unchanged; invalid plans rejected pre-provision; import/fork/handoff/snapshot paths handle the new field. |
| 7 | **Cross-cutting remote concerns** (catalog Phases 9–11): runtime-neutral git v1, activity leases, credential broker. | Private-repo clone works remotely; logs redact credentials; leases acquire/release on turn/terminal/route. |
| 8 | **`ExecutionRuntimeReconciler`** (new, see §5). Design + fakes here; real-provider reconnect coverage ships with each adapter. | Partial-failure matrix (below) handled deterministically against fakes. |
| 9 | **Real providers**, gated by descriptor + contract tests + reconciler: Daytona → Vercel → Modal → Cloudflare (catalog Phases 12–15). | Each passes the Phase-17 baseline + capability suites. |
| 10 | **UI** (catalog Phase 16). | Default creation stays local; remote opt-in; runtime UI infra-focused. |

* * *
## 1. Corrections to the original handoff
The handoff was written against a stale mental model. Fix these before trusting any of its file paths or snippets.

| Handoff assumed | Reality (cited) |
|---|---|
| `apps/server/src/wsServer.ts`, `providerManager.ts` | Don't exist. WS routing is `apps/server/src/wsRpc.ts`; provider dispatch is `orchestration/Layers/ProviderCommandReactor.ts` + `provider/Layers/ProviderService.ts`. |
| One Codex spawn site, clean before/after | **Three** near-identical sites: `startSession` (728-736), `forkThread` (1346-1354), discovery (1930-1936) — plus `spawnSync` version gate (3291-3333) and Windows `killChildTree` taskkill (535-552). |
| Invent `JsonRpcLineProcess` + `LocalSpawnJsonRpcProcess` from scratch | Mirror `packages/effect-acp/_internal/stdio.ts` (`makeChildStdio` / `makeInMemoryStdio`) over `ChildProcessSpawner`. The pattern + test fake already exist. |
| Manager cleanly "receives a process" | `CodexAppServerManager extends EventEmitter` with **Promise** methods, holding an optional `ServiceMap` (`codexAppServerManager.ts:681,691`). It is *not* an Effect Service. Real difficulty = bridging imperative async ↔ Effect-native Stream transport. |
| `processRunner.ts` as the process base | One-shot Promise runner for git/version checks (`processRunner.ts:128`), buffers full stdout — **not** a streaming transport. Do not build on it. |
| New runtime events extend the runtime event system | `ProviderRuntimeEvent` is a 47-member **agent-activity** union keyed on `threadId` with no process/instance id (`providerRuntime.ts:969-1021,255-267`). Extending it forces every exhaustive switch to handle infra events and conflates two state machines. Infra lifecycle gets its **own** contract type. |
| (unstated) | `ServiceMap.Service` is the only tag convention (`Effect.Service` used 0× vs 72×). New code: `class X extends ServiceMap.Service<X, Shape>()("t3/…")` + `Layer.effect`. |
| (unstated) | Adding a thread field or an event type is a wide, fixed multi-file checklist (Appendices A/B). Miss one site → events silently no-op. This is the argument for keeping runtime state off `projection_threads` (see Phase 2). |

* * *
## 2. Conceptual model → real code
```
Thread ─▶ ExecutionTarget ─▶ RuntimeInstance ─▶ RuntimeProcess ─▶ AgentProviderSession
```

| Layer | Definition | Today | New home |
|---|---|---|---|
| Thread | durable conversation/task | `OrchestrationThread` (`orchestration.ts:492-554`) | + optional `runtime` field, **hydrated from `projection_thread_runtime`** |
| ExecutionTarget | where the thread runs | implicit in `envMode`+`cwd` | `ExecutionTargetKind` = `local`\|`worktree`\|`remote-runtime` |
| RuntimeInstance | provider-backed infra instance | none (local cwd is implicit) | `execution_runtime_instances` + `RuntimeInstanceSummary` |
| RuntimeProcess | a process inside the instance | the raw `child` on `CodexSessionContext` (101-116) | `JsonRpcLineTransport` + `execution_runtime_processes` |
| AgentProviderSession | the agent protocol session | `ProviderSession` (`provider.ts:37-50`), Codex thread/turn lifecycle | unchanged |

Local and worktree are **compatibility execution targets** that reproduce current behavior; `cwd` resolution already distinguishes them (`threadEnvironment.ts:34-44`: worktree→`worktreePath`, local→project root).

* * *
## 3. The keystone in detail (PR 1, catalog Phase 5)
Stream-native seam. Define the transport as a value a `ServiceMap.Service` can hand out, mirroring `effect-acp`:

```
// packages/contracts: schema-only ids only (ExecutionInstanceId, RuntimeProcessId…)
// apps/server/src/provider/process/JsonRpcLineTransport.ts  (Effect-native)
interface JsonRpcLineTransport {
  readonly send: (message: unknown) => Effect.Effect<void, TransportClosedError>  // writes JSON + "\n"
  readonly inbound: Stream.Stream<JsonRpcMessage>      // parsed, line-framed (request|notification|response)
  readonly stderr: Stream.Stream<string>               // line-framed side channel (or empty for remote)
  readonly exit: Deferred.Deferred<ProcessExit>        // {code, signal} once
  readonly isAlive: Effect.Effect<boolean>             // replaces child.killed liveness reads
  readonly close: Effect.Effect<void>                  // reject pending + teardown (scope finalizer)
}
```

Two implementations, both already templated in-repo:

- **Local** — `makeChildStdio`-style over `ChildProcessSpawner.spawn(ChildProcess.make(cmd, args, {cwd, env, shell}))` under a `Scope` (the `AcpSessionRuntime.ts:203-220` pattern). Line-frame stdout (and, fixing a latent bug, stderr — see note) into the `inbound`/`stderr` Streams.
  
- **In-memory / remote** — `makeInMemoryStdio`-style: `inbound` fed by a `Queue` the runtime adapter pushes remote stdout lines into; `send` enqueues to the outbound `Queue` the adapter forwards to the remote exec/stdin channel. Both the **test fake** (PR 2) and the **remote** path (PR 5).
  
### The impedance bridge (the actual risk)
`CodexAppServerManager` is imperative/Promise/EventEmitter. **Imperative bridge first** (resolved decision #1): keep the manager owning request ids, the pending map, approval/user-input handling, and all protocol semantics. The transport only sends/receives framed JSON-RPC and process-lifecycle signals. Concretely, replace the `child` + `readline` + direct `child.stdin/stderr/on(exit)` on `CodexSessionContext` (101-116) with a transport handle the manager consumes via small adapters (`inbound` → existing `handleStdoutLine`; `send` → existing `writeMessage` body; `exit` → existing exit handler). Build the transport with Effect at the manager's scope boundary (`CodexAdapter.ts:1553-1569` already owns the manager via `Effect.acquireRelease` and can supply `ChildProcessSpawner`). Do **not** push JSON-RPC correlation into the transport now.
### Semantics that MUST survive the extraction
Each is a regression trap (from the map):

- Per-session `nextRequestId` (from 1) + `pending` Map keyed `String(id)` + **20 000 ms** timeout; reject-all on stop (`2441-2470`, `1624-1652`).
  
- `writeMessage` carries **four** JSON-RPC kinds: request `{method,id,params}`, `initialized` notification `{method}`, approval reply `{id,result:{decision}}`, user-input reply `{id,result:{answers}}`, plus error replies (`2472-2479`).
  
- Inbound shape guards: `isServerRequest` (method+id), `isServerNotification` (method, **no** `id` key), `isResponse` (id, no method) (`2641-2671`). Server→client **requests** (approvals, `item/tool/requestUserInput`) require the reverse reply channel — a one-way push transport breaks approvals.
  
- `stopping` flag gates every callback (line/stderr/exit early-return) to avoid double-delete on intentional kill (`2075-2095`, `1624-1652`).
  
- `killChildTree`: Windows `taskkill /T /F` (because `shell:true` on win32), else `child.kill()` (`535-552`). Local-only; remote has no pid.
  
- Liveness reads `child.killed` at `1864`/`1920` → must become `transport.isAlive`.
  
- Stderr classification (`classifyCodexStderrLine` 646-666) + non-fatal `write_stdin closed` tolerance (`codexErrorClassification.ts:5-12`). Remote has no stderr stream — this error-surfacing path needs an alternative or it goes silent.
  
- **Local-only gates to relocate/skip for remote:** `assertSupportedCodexCliVersion` `spawnSync(codex --version)` (3291-3333); `buildCodexProcessEnv` login-shell PATH/`SSH_AUTH_SOCK` + `CODEX_HOME` symlink overlay (`codexProcessEnv.ts:177-239`); `ensureIsolatedScratchWorkspace` tmpdir fallback (517-522). These assume the agent shares this host's FS/OS.
  
### Stderr framing bug to fix while here
stdout uses `readline` (correct cross-chunk buffering); stderr is split per-chunk with `raw.split(/\r?\n/g)` and **no** cross-chunk buffer (`2048-2062`) — a stderr line split across two `data` chunks is mis-classified. The unified transport should line-buffer both.
### Test seam
`codexAppServerManager.test.ts` currently `vi.spyOn`s privates (`sendRequest`, `writeMessage`, `requireSession`) and never spawns (`test:44-89,672-743`). Extracting the transport breaks those spies. Replace with `makeInMemoryStdio` injection (PR 2): drive scripted inbound lines, assert outbound frames. This also gives the fake-remote path (PR 5) for free.

**PR 1 acceptance:** Codex works locally; three spawn sites collapse to one transport-create; `CodexAppServerManager` no longer imports `node:child_process` (except inside the local transport impl); existing Codex tests pass via the in-memory fake.

* * *
## 4. Slice catalog (ordered by the build table, not by number)
### Phase 1 — Public contracts: `executionRuntime.ts` (schema-only)
New `packages/contracts/src/executionRuntime.ts`, one barrel line in `index.ts` (`export * from "./executionRuntime"`). Mirror `providerRuntime.ts` house style; import branded ids from `baseSchemas.ts`, `ProviderKind` from `orchestration.ts`. Add branded ids via `makeEntityId` (`ExecutionInstanceId`, `RuntimeProcessId`, `RuntimeRouteId`, `RuntimeSnapshotId`).

**Public read-model + input only** (resolved decision: contract split). These live in contracts:

```
ExecutionTargetKind  ExecutionRuntimeProvider  RuntimeRole  RuntimeInstanceStatus (15-value set)
RuntimeInstanceSummary  RuntimeProcessSummary  RuntimeRouteSummary  RuntimeSnapshotSummary
RuntimeActivityLeaseSummary  OrchestrationThreadRuntime  RuntimePlan (input)
```

The richer adapter capability model stays **server-internal** (Phase 3). Do **not** add these providers to `ProviderKind`. Do **not** extend `ProviderRuntimeEvent`. **Acceptance:** `bun typecheck`; barrel exports resolve.
### Phase 3 — Server-internal descriptors + registry + planner
`apps/server/src/executionRuntime/Services/` (interfaces) + `Layers/` (impls), `ServiceMap.Service` + `Layer.effect`. Server-internal contracts:

```
ExecutionRuntimeProviderAdapter  RuntimeProviderDescriptor  ExecutionRuntimePlanner
RuntimeProcessTransport  RuntimeCredentialBroker  RuntimeGitWorkspace  RuntimeActivityLeaseManager
```

Descriptors declare capabilities (lifecycle/exec/fs/git/ingress/persistence/network/quirks). `ExecutionRuntimePlanner` validates a `RuntimePlan` against the descriptor **before** provisioning. Keep the rich descriptor server-internal initially; promote a slimmed subset to contracts only when the UI needs it. **Acceptance:** unsupported plan/role combos fail early; no provider calls.
### Phase 2 — Thread `runtime` state, stored in a dedicated table
Add `runtime: Schema.optional(Schema.NullOr(OrchestrationThreadRuntime)).pipe(Schema.withDecodingDefault(() => null))` (the `lastKnownPr` pattern, `orchestration.ts:516-519`) to `OrchestrationThread` and `OrchestrationThreadShell`. Keep all existing `envMode`/worktree fields.

**Storage = dedicated tables** (resolved decision #3 — reversed from the first draft). Do **not** add a JSON column to `projection_threads`: that table is wide and hot, and its repository mirrors every column across insert/update/select (`Layers/ProjectionThreads.ts:42-225`). Instead:

```
projection_thread_runtime              -- read-model row per thread (hydrates OrchestrationThread.runtime)
  thread_id PK, target_kind, provider, role, runtime_instance_id, status,
  root_path, routes_json, processes_json, snapshots_json, leases_json,
  last_activity_at, updated_at

execution_runtime_instances            -- operational
execution_runtime_processes
execution_runtime_routes
execution_runtime_snapshots
execution_runtime_activity_leases
```

`ProjectionSnapshotQuery` hydrates `OrchestrationThread.runtime` and the shell's runtime status via a **second repository/query** (left join or follow-up read), leaving the existing thread projection path untouched. New migrations (next free number, register in `Migrations.ts:64-102`). Why a separate table: runtime state changes more often than thread metadata, is optional and independently lifecycle-managed, and stays isolated from thread-projection churn. **Acceptance:** existing persisted threads decode with `runtime = null`; local/worktree behavior unchanged; thread projection queries unchanged; `bun typecheck` + projection tests pass.
### Phase 7 — Event-sourced runtime lifecycle (folds into PR 4)
Runtime state must survive reconnect, so it rides the existing command→event→projection pipeline. A **separate** event family (not on `ProviderRuntimeEvent`):

- Commands: `thread.runtime.provision|destroy|stop|snapshot|expose-port|exec|lease.acquire|lease.release`.
  
- Events: `thread.runtime-provision-requested`, `-instance-created`, `-instance-state-changed`, `-process-started`, `-process-output`, `-process-completed`, `-route-exposed`, `-snapshot-created`, `-lease-renewed`, `-destroyed`, `-failed`.
  

Each event is the fixed multi-file touch in **Appendix B**, projected into `projection_thread_runtime` + the operational tables. Decide hot vs deferred phase per event (`ProjectionPipeline.ts`): instance-state → hot; `-process-output` **is stream-only, not event-sourced** (resolved decision #5) — log to a ring/stream and persist lifecycle + exit code + failure reason + short log tail, never every line, to protect dispatch-transaction latency. Add runtime-affecting types to `isThreadDetailEvent` (`wsRpc.ts:144-172`) and the shell refresh allow-list (`ProjectionPipeline.ts:163-180`).
### Phase 4 — Local + worktree execution providers (lands with PR 1/5)
`executionRuntime/providers/{local,worktree}/`. Common `ExecutionRuntimeProviderAdapter`; local resolves `cwd` to project root, worktree to `worktreePath` — reuse `resolveThreadWorkspaceCwd` (`checkpointing/Utils.ts:28-52`), do not re-derive. The local adapter's transport is the local `JsonRpcLineTransport` from PR 1. **Acceptance:** existing local + worktree threads unchanged.
### Phase 6 — Fake remote runtimes (PR 5)
`fake-pty-workspace`, `fake-command-workspace`, `fake-job-runtime`, `fake-service-runtime`, `fake-ephemeral-runtime`. Run commands locally in temp dirs but via the **remote** path: real `RuntimeInstance` records, `makeInMemoryStdio` transport, runtime lifecycle events, destroy cleanup — all driven through an **internal** orchestration command (no public `runtimePlan` yet). **Acceptance:** see PR 5 gate.
### Phase 8 — `runtimePlan` on create/handoff/fork (PR 6, deferred)
Extend `ThreadCreateCommand`/`ThreadHandoffCreateCommand`/`ThreadForkCreateCommand` (`orchestration.ts:695-793`) + their `thread.created` decider blocks (`decider.ts:278-539`) with optional `runtimePlan`. No plan / `local` / `worktree` → current behavior. Remote → planner validates, then `ProviderCommandReactor` provisions before `ProviderService.startSession`. **Only after PR 5 proves the internal mechanism** — once `runtimePlan` is public it must be honored across import/fork/handoff/snapshot/projection/UI. **Acceptance:** existing callers unchanged; invalid plans rejected pre-provision.
### Reactor purity rule (resolved decision)
`ProviderCommandReactor` may call only:

```
ExecutionRuntimeService.ensureTargetForThread(...)
ProviderService.startSession(...)
ProviderService.sendTurn(...)   (and the existing steer/interrupt/etc.)
```

It must **not** reference Daytona/Vercel/Modal/Cloudflare instance ids, states, or routes. All provider-specific knowledge lives under `ExecutionRuntimeService` + the adapters. This keeps the orchestration seam provider-agnostic (matching how it is agent-provider-agnostic today).
### Phases 9–15 — Remote concerns + real providers (PR 7–9 roadmap)
Each validated against its capability descriptor, the Phase-17 contract tests, and the reconciler.

- **9 Git sync v1:** `RuntimeGitWorkspace` via `exec` (`clone`/`checkout -B`/`status --porcelain`/`diff --binary`). Local git WS RPCs unchanged.
  
- **10 Activity leases:** `RuntimeActivityLeaseManager` hides per-provider keepalive (Daytona refresh, Vercel timeout-extend, Modal idle-timeout respect, Cloudflare renew). Lease on active turn/terminal/preview; release on exit/close.
  
- **11 Credential broker:** `RuntimeCredentialBroker` (env-var / provider-secret / mounted-file / ssh-agent / git-credential-helper / outbound-proxy / worker-broker). Never persist raw tokens in runtime metadata; never log tokenized clone URLs; setup commands get fewer secrets than agent processes; snapshots flagged secret-tainted.
  
- **12 Daytona** (first real provider): create → clone → setup → `codex app-server` → stream stdio → diff → preview → activity refresh → stop/archive/snapshot/delete.
  
- **13 Vercel Sandbox:** command/log/file/preview-first (not PTY); declare ports at create; ephemeral FS unless snapshotted.
  
- **14 Modal:** job/service-first; logs as process output; `Finished` terminal; volume sync ≠ snapshot; do not fake PTY.
  
- **15 Cloudflare:** `apps/cloudflare-runtime-bridge/` Worker + Durable Object maps `runtimeInstanceId` → instance; Synara adapter talks authenticated HTTP/WS. Raw Containers stay a lower-level service runtime, not the default workspace.
  

Terminal note: do not remote-enable `TerminalManager` first — it assumes local cwd/PID/PTY/history/kill (`terminal/Layers/Manager.ts`). Stream provider/runtime logs initially; grow a terminal transport later.
### Phase 16 — UI (PR 10)
`apps/web` thread creation: Environment (Local/Worktree/Remote) + provider + advanced (resources/timeout/ports/persistence/egress/secrets). Header shows `Runtime: <provider> · <status>`. Runtime panel: processes, routes, actions (stop/destroy/snapshot/refresh). Default creation stays local; remote opt-in.
### Phase 17 — Provider contract tests
`describeRuntimeProviderContract(provider, …)` baseline (capabilities honest, rejects unsupported plans pre-create, creates/reports status/executes/streams/exit-code/handles failure/collects diff/destroys idempotently) + capability suites (PTY, filesystem, preview, persistence/snapshot, lease, credential redaction). Fakes run in CI; real providers opt-in via env.

* * *
## 5. Reconciliation (new — PR 8, before real providers)
Remote providers introduce partial failure the local path never had:

```
instance created but event not appended        event appended but provider call failed
server crashed after instance create            destroy called but provider timed out
provider instance exists but DB says failed     DB row exists but provider instance is gone
```

Design `ExecutionRuntimeReconciler` (a `ServiceMap.Service` forked into the server scope like the other reactors, `effectServer.ts:117-124`):

```
ExecutionRuntimeReconciler
  list active execution_runtime_instances
  reconnect / getStatus where the provider supports it
  mark lost / failed / destroyed
  retry pending destroy
  enforce TTL / idle policies
```

Ships with fakes in PR 8; real-provider reconnect/getStatus coverage is part of each adapter's acceptance (PR 9), not the fake milestone.

* * *
## Appendix A — "add a thread field" checklist (reference)
The general pattern (still useful), and why `runtime` deliberately avoids most of it. All sites must stay in lockstep or reads diverge between `getSnapshot` (in-memory model) and `getShellSnapshot` (SQL projection):

1. `OrchestrationThread` (`orchestration.ts:492-554`) — **yes**, add `runtime`
  
2. `OrchestrationThreadShell` (`:556-613`) — **yes**
  
3. `ThreadCreateCommand` (`:695-732`) — only in PR 6 (`runtimePlan`, not `runtime`)
  
4. `ThreadHandoffCreateCommand` (`:744-767`) — PR 6
  
5. `ThreadForkCreateCommand` (`:769-793`) — PR 6
  
6. `ThreadMetaUpdateCommand` (`:813-833`) — N/A (runtime mutates via runtime events, not meta-update)
  
7. `ThreadCreatedPayload` (`:1202-1249`) / `ThreadMetaUpdatedPayload` (`:1271-1290`) — runtime is **not** seeded here
  
8. `decider.ts` `thread.created` blocks (278-539) — no runtime payload
  
9. `projector.ts` `thread.created` (282-335) — runtime defaults null
  
10. `ProjectionPipeline.ts` thread upsert (596-630) — **unchanged**
  
11. `Services/ProjectionThreads.ts` row schema (27-62) — **unchanged**
  
12. `Layers/ProjectionThreads.ts` INSERT/SELECT (42-225) — **unchanged**
  
13. `ProjectionSnapshotQuery.ts` (367-506) — hydrate `runtime` via the **separate** `projection_thread_runtime` repo
  

Sites 10–12 stay untouched precisely because runtime lives in its own tables. That avoidance is the point of resolved decision #3.
## Appendix B — "add an orchestration event" checklist (Phase 7 / PR 4)
1. Contracts (`orchestration.ts`): literal in `OrchestrationEventType` (1141-1170); `XPayload` struct; union member `{...EventBaseFields, type: Literal, payload}` (1452-1583).
  
2. If command-produced: command schema + union membership (`Client`/`Internal` 995-1139) + RPC schema.
  
3. `orchestration/Schemas.ts`: re-export payload alias for the projector.
  
4. `decider.ts`: `case` emitting via `withEventBase`.
  
5. `projector.ts`: `case` in `projectEvent` (in-memory model, used in dispatch txn + reconcile).
  
6. `ProjectionPipeline.ts`: handling in the relevant `applyXProjection` (here, the new runtime projectors); if sidebar-affecting, add to `shouldRefreshThreadShellSummary` (163-180); pick hot vs deferred phase.
  
7. `wsRpc.ts`: add to `isThreadDetailEvent` (144-172) so per-thread subscribers receive it; `toShellStreamEvent` if it changes shell rows.
  
8. New persisted state: migration + register; add the runtime `Projection*Repository` + `ProjectionSnapshotQuery` hydration; decide membership in `REQUIRED_SNAPSHOT_PROJECTORS` (affects `snapshotSequence` MIN) / `PROJECT_METADATA_SNAPSHOT_PROJECTORS`.
  

Use stable `commandId`s for internal reactor commands (receipts dedupe on `commandId`, not events) so reconnect/crash retries don't double-append.

* * *
## Milestones (map to the handoff's six)
1. Codex runs locally via a supplied transport; manager off `child_process` (PR 1; PR 2 fake).
  
2. A fake remote runtime runs Codex through the same path (PR 4–5).
  
3. Daytona runs a real Codex thread (PR 6–9, Daytona).
  
4. Vercel via command/log/file/preview (PR 9, Vercel).
  
5. Modal validation jobs/services without forced PTY (PR 9, Modal).
  
6. Cloudflare via Runtime Bridge Worker (PR 9, Cloudflare).
  
## Resolved decisions
| #   | Decision | Call |
| --- | --- | --- |
| 1   | Transport bridge style | **Imperative bridge first.** Manager keeps protocol/correlation; transport only frames + lifecycle. |
| 2   | Migrate Gemini too? | **Defer.** Codex first; Gemini validates transport generality afterward. |
| 3   | Runtime storage shape | **Dedicated** `projection_thread_runtime` **+ operational tables.** Not a JSON column on `projection_threads`. |
| 4   | Remote discovery sessions | **Local-only discovery for v1.** Don't provision a remote instance just to list metadata. |
| 5   | `-process-output` persistence | **Stream-only + persisted summaries** (lifecycle/exit/failure/tail). Never event-source every line. |
| 6   | `runtimePlan` exposure timing | **After fake remote works** (PR 6), via an internal command path first. |
| 7   | Reconciler | **Design before real providers** (PR 8); per-adapter reconnect coverage in PR 9. |
| 8   | Contract surface | **Split:** read-model/plan-input in contracts; rich adapter/descriptor model server-internal. |
