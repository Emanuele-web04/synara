# Synara Code-Quality Branch — Complete Review Handoff

> **Purpose:** give a human reviewer or another AI enough context to audit this branch without
> reconstructing the entire conversation that produced it.
>
> **Prepared:** 2026-07-14  
> **Branch:** `codex/audit-code-quality`  
> **Baseline:** `5056e395e` (`v0.5.2`)  
> **Current committed HEAD:** `9780ff8bb`  
> **Important:** the working tree contains substantial uncommitted pruning and benchmark work.

---

## 1. Executive summary

This branch started as a code-quality audit: find spaghetti code, duplicated logic, oversized
owners, weak failure boundaries, and an insufficient ACP foundation. The work then expanded into a
large reliability and architecture pass before being deliberately stopped and redirected toward
deletion and consolidation.

The result is **not merely a cosmetic refactor**. It changes ownership across orchestration,
persistence, provider lifecycle, WebSocket transport, desktop IPC/security, settings, automation,
Git handoff, frontend state, and ACP. It also adds recovery migrations and a large amount of focused
test coverage.

The most important architectural decision is the ACP cutover:

- `@agentclientprotocol/sdk` version `1.2.1` is the only production ACP wire implementation.
- Grok, Droid, and Cursor all use that same official SDK boundary.
- Effect remains in Synara for lifecycle, cancellation, queues, errors, and application policy.
- The private `effect-acp` wire/client/protocol implementation is deleted from the current working
  tree; only still-consumed Effect schema/error adapters remain.
- There is no provider-selectable fallback to the legacy wire implementation.

The branch is large because the initial implementation added durability, recovery, security, and
tests across many subsystems. The current pruning checkpoint has already removed **4,618 tracked net
lines** from committed HEAD, but the complete tracked diff against `v0.5.2` is still **+29,453 net
lines**.

### Bottom-line status

| Area                         | Current status                               | Reviewer interpretation                                           |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Architecture workstreams     | Recorded as code-complete                    | Broad changes exist and require subsystem review                  |
| ACP production wire          | Cut over to official SDK                     | Correct strategic direction; inspect resource bounds carefully    |
| Legacy ACP wire              | Deleted in local working tree                | Strong consolidation win; currently uncommitted                   |
| Hotspot pruning              | Implemented incrementally                    | Net-negative runtime work, with focused evidence recorded         |
| ACP benchmarks               | Implemented and run                          | Useful synthetic evidence, not an end-to-end app benchmark        |
| Full repository verification | Not performed after the latest local changes | `fmt`, `lint`, and `typecheck` remain mandatory before completion |
| Browser verification         | Partially blocked                            | Existing welcome fixture lacks `protocolEpoch`                    |
| Release readiness            | Not established                              | This is a review handoff, not a release sign-off                  |

---

## 2. What is committed and what is still local

Reviewers must not treat the remote branch and the local working tree as the same artifact.

### Committed branch: `5056e395e..9780ff8bb`

| Commit              | Summary                                       |                                         Size |
| ------------------- | --------------------------------------------- | -------------------------------------------: |
| `0e5f6af9c`         | Refactor Synara orchestration and web UI flow |                  387 files, +43,323 / -9,299 |
| `9780ff8bb`         | Consolidate desktop IPC channel constants     |                        14 files, +287 / -240 |
| **Committed total** | Two commits after `v0.5.2`                    | **394 files, +43,571 / -9,500; net +34,071** |

### Current tracked working-tree changes: `HEAD..working tree`

- 33 tracked files changed.
- 620 additions and 5,238 deletions.
- **Net -4,618 tracked lines.**
- Most deletions remove the private Effect ACP wire stack and duplicate provider/web ownership.

### Current untracked review artifacts

| Path                                                 | Purpose                                                    | Approximate lines |
| ---------------------------------------------------- | ---------------------------------------------------------- | ----------------: |
| `apps/server/scripts/acp-wire-benchmark.ts`          | Shared Effect-vs-official benchmark runner                 |               414 |
| `apps/server/scripts/compare-acp-wire-benchmarks.ts` | Result comparison generator                                |                88 |
| `apps/web/src/test/browserHarness.ts`                | Shared browser-test fixture helper                         |                35 |
| `benchmarks/acp-wire/*.json`                         | Four recorded benchmark comparisons                        |               720 |
| **Total**                                            | Untracked files are excluded from normal `git diff --stat` |         **1,257** |

### Complete tracked diff against the baseline

- 406 unique tracked files changed.
- 43,541 additions and 14,088 deletions.
- **Net +29,453 tracked lines.**
- Including the current untracked files as raw line counts gives approximately **net +30,710**.
  This is only a scale indicator: JSON samples, documentation, tests, generated code, and runtime
  code do not have equal maintenance or runtime cost.

---

## 3. Why the branch grew instead of shrinking

The original intent was cleanup, but the first implementation phase also introduced missing
reliability architecture. That is why additions exceeded deletions.

Approximate classification of the current tracked diff:

| Category                 | Files |  Added | Deleted |         Net | What it means                                                                  |
| ------------------------ | ----: | -----: | ------: | ----------: | ------------------------------------------------------------------------------ |
| Tests and fixtures       |   128 | 16,827 |   2,962 | **+13,865** | The largest source of growth; recovery and concurrency invariants gained tests |
| Runtime and contracts    |   236 | 20,233 |  10,379 |  **+9,854** | New durable owners, admission paths, lifecycle rules, and shared contracts     |
| Documentation            |     3 |  2,603 |       0 |  **+2,603** | Audit/controller/handoff documentation                                         |
| Migrations and recovery  |    21 |  1,628 |      66 |  **+1,562** | Durable delivery, identity, attachments, and Git recovery                      |
| Tooling, CI, and scripts |    17 |  1,952 |     383 |  **+1,569** | Release validation and operational tooling                                     |
| Generated files          |     1 |    298 |     298 |       **0** | Regenerated schema output                                                      |

This means “+29k LOC” does **not** mean the chat UI now executes 29,000 more lines for every message.
Much of the increase is tests, documentation, migrations, recovery handling, and explicit failure
paths. However, it also means this is an unusually large review surface and should not be accepted as
a simple refactor without a staged audit.

Concrete deletion evidence:

- `packages/effect-acp` is currently **net -3,964 tracked lines** against the baseline.
- The local pruning checkpoint is **net -4,618 tracked lines** relative to committed HEAD.
- The five named complexity hotspots have had repeated duplicated paths merged or deleted.
- The audit records **-1,004 runtime LOC** across the targeted pruning sequence before the later
  cross-subsystem closeout.
- `wsNativeApi` now owns one listener registry/reset path instead of repeated listener plumbing.
- Three browser tests share their identical host/server harness.

---

## 4. Goal and scope evolution

### Initial goal

1. Find low-quality and spaghetti code.
2. Split oversized responsibilities.
3. Remove duplicated logic and competing owners.
4. Improve the ACP provider foundation.
5. Produce an actionable audit and execute its shorter checklist.

### Scope problem discovered

The initial change grew to more than +34k committed net lines. That made the result difficult to
review and drifted away from consolidation. A pruning checkpoint was imposed with these rules:

- no new roadmap scope;
- no new abstraction unless it replaced existing ownership;
- work only in already changed code;
- prefer deletion, merging, and extraction of duplicated ownership;
- aim for net-negative runtime LOC per phase;
- treat `ProviderRuntimeIngestion`, `ProviderCommandReactor`, `ProjectionPipeline`,
  `ProviderService`, and `wsRpc` as hotspots;
- do not expand `effect-acp`;
- define the official SDK boundary and delete the custom wire it replaces;
- keep focused tests, but avoid building large new test frameworks.

### Final intended shape

The branch now tries to establish one owner per concern:

```text
Provider process stdout/stdin
        │
        ▼
AcpSessionRuntime
  ├─ official ACP SDK: NDJSON, JSON-RPC, validation, correlation, cancellation
  └─ Synara: lifecycle, bounds, logging, policy, normalized events
        │
        ▼
Provider runtime ingestion
        │
        ▼
Durable orchestration event/delivery stores
        │
        ▼
Projection pipeline
        │
        ▼
Cursor-safe WebSocket stream
        │
        ▼
Normalized web state and transcript UI
```

---

## 5. Detailed workstream recap

The existing audit consolidated 206 historical finding sections into 17 actionable workstreams.
The table below explains what each workstream was trying to fix and what a reviewer should inspect.

### P0 — trust and security boundaries

| Workstream                           | Why it was needed                                                                        | Main change                                                    | Result to verify                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `P0-REL-01` Release/update authority | Release artifacts and updater decisions could derive authority from inconsistent sources | Exact-source provenance and fail-closed updater/release checks | A release must only trust the expected repository, tag, platform, and artifact identity |
| `P0-SEC-01` Provider credentials     | Credentials and child-process capabilities were spread across callers                    | Server-only credential owner and minimized child environment   | Browser/client code cannot become a second secrets authority                            |
| `P0-SEC-02` Outbound HTTP            | Credential-bearing calls needed pinned destinations and policy                           | Shared outbound HTTP policy/owner                              | Redirects or caller-controlled URLs cannot exfiltrate credentials                       |

### P1 — durable correctness and lifecycle

| Workstream                            | Why it was needed                                                                          | Main change                                                                                          | Result to verify                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `P1-PERSIST-01` Persistence           | Migration, projection, SQLite lifecycle, and recovery had overlapping responsibilities     | Database lifecycle lock, migration backup/recovery, consolidated projection ownership                | Failed migrations recover predictably and only one DB lifecycle owner mutates state        |
| `P1-DELIVERY-01` Durable delivery     | Accepted provider intent/output could be lost or duplicated across crashes                 | Durable command delivery, runtime events, queued promotions, terminal evidence                       | Restart resumes/reconciles accepted work without silent replay or loss                     |
| `P1-IDENTITY-01` Durable identity     | Command/message/interaction identity was not sufficiently scoped                           | Thread/lifecycle-scoped identities and fingerprints                                                  | Replayed events cannot collide across threads or provider generations                      |
| `P1-PROVIDER-01` Provider lifecycle   | Session, turn, teardown, and process ownership was duplicated                              | One per-thread provider lifecycle owner and supervised teardown                                      | Overlapping sends/restarts/cancellation cannot create competing live sessions              |
| `P1-RUNTIME-01` Runtime pipelines     | Queues and shutdown paths could be unbounded or unordered                                  | Bounded workers/pipelines and staged shutdown                                                        | Slow consumers and shutdown do not leak work or reorder terminal events                    |
| `P1-TRANSPORT-01` WebSocket transport | Snapshot/live boundaries and request admission needed exact cursors and limits             | Compatibility negotiation, request/stream admission, snapshot-live cursor                            | Reconnect does not miss or duplicate orchestration events                                  |
| `P1-FILE-01` Attachments              | Upload, ownership, cleanup, and process-loss behavior were split                           | Managed attachment store, principal, cleanup, migration                                              | Only the owning thread/process may access files; cleanup is crash-safe                     |
| `P1-DESKTOP-SEC-01` Desktop boundary  | Browser-control pipe, IPC, schemes, and partitions needed explicit authority               | Private pipe leases, bounded clients/output, fail-closed Windows behavior, centralized IPC constants | A stale renderer/tab/lease cannot control a newer desktop generation                       |
| `P1-SETTINGS-01` Settings             | Disk state, browser state, and provider launch state could diverge                         | Revisioned server-owned settings commits, quarantine, atomic write                                   | Provider launch always sees the committed server state                                     |
| `P1-AUTO-01` Automation               | Scheduling, iteration reservation, result settlement, and recovery were duplicated         | Revision-fenced automation saga and bounded keyset recovery                                          | A crash cannot run the same scheduled iteration twice                                      |
| `P1-GIT-01` Git handoff               | Mutating RPCs, worktree setup, status parsing, and restart behavior needed one coordinator | Canonical repository mutation coordinator plus durable Git handoff journal                           | Destructive or interrupted mutations fail closed and completed results replay idempotently |

### P2 — protocol and frontend consolidation

| Workstream                              | Why it was needed                                                                   | Main change                                                             | Result to verify                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `P2-ACP-01` ACP foundation              | Synara maintained a custom wire stack beside the official SDK                       | Official SDK owns all production ACP wire behavior; custom wire deleted | Grok, Droid, and Cursor have one wire implementation and no fallback   |
| `P2-WEB-STATE-01` Web state             | Thread data had normalized and derived/legacy owners that required synchronization  | Normalized slices became the runtime authority                          | Chat/thread updates cannot diverge between duplicate stores            |
| `P2-PROVIDER-META-01` Provider metadata | Ordering, labels, discovery, health, usage, and settings visibility were duplicated | Shared exhaustive provider descriptor and revision-aware health         | Every provider surface uses consistent identity and presentation rules |

---

## 6. Complexity-hotspot cleanup

The pruning pass deliberately avoided adding another architectural layer. It merged ownership inside
the existing hotspot files.

### `ProviderCommandReactor`

Consolidated or removed:

- duplicate approval/user-input claim and failure envelopes;
- repeated durable intent classification;
- duplicate first-turn/title/branch inputs;
- repeated provider start/restart session configuration;
- duplicate rollback completion dispatch;
- redundant wrappers, aliases, guards, and payload reconstruction.

Expected improvement: fewer branches can disagree about claim state, lifecycle generation, replay
safety, or settlement. Review this area for exact-once behavior and error classification.

### `ProviderRuntimeIngestion`

Consolidated or removed:

- duplicated synthetic turn-start and buffered-message flush tails;
- repeated tool lifecycle activity constructors;
- repeated assistant delivery state envelopes;
- separate approval/user-input requested/resolved activity shells;
- pass-through aliases that obscured runtime state.

Expected improvement: runtime events pass through fewer competing mapping paths. Review ordering,
context-compaction behavior, and unmatched-delivery debt.

### `ProjectionPipeline`

Consolidated or removed:

- third copy of hot/deferred projector selection;
- duplicated revert/rollback replacement logic for activities, plans, messages, and turns;
- repeated pinned-message/mode/lifecycle persistence shells;
- duplicate pending-interaction upsert tails;
- repeated thread metadata/timestamp update ownership.

Expected improvement: fewer projection paths can rebuild the same history differently. Review
transaction boundaries, rollback no-op cases, attachment retention, and snapshot cursor advancement.

### `ProviderService`

Consolidated or removed:

- parallel approval and structured-input routing/lifecycle locks;
- duplicate stop-all writers;
- dead `adapterReturned` state;
- repeated live binding/session aliases;
- duplicated send/steer/review dispatch-generation shells.

Expected improvement: one lifecycle generation and lock policy controls provider interactions.
Review overlapping turn dispatch, session restart, and adapter cleanup failure.

### `wsRpc`

Consolidated or removed:

- repeated Git mutation status-refresh tails;
- duplicate shell/thread high-water and error mapping;
- invalid Effect ServiceMap tag execution paths;
- browser-side handoff dispatch and optimistic metadata duplication;
- repeated listener/reset ownership moved into `wsNativeApi`.

Expected improvement: fewer RPC handlers silently apply different admission, refresh, or stream
cursor policies. Review authentication, negotiation, cancellation, and reconnect behavior.

---

## 7. ACP decision: official SDK versus Effect ACP

### The decision

Use the official TypeScript SDK for the protocol wire, while keeping Effect for Synara's application
lifecycle.

This is not “remove Effect from ACP.” It is a division of responsibility:

| Responsibility                                | Owner after the change |
| --------------------------------------------- | ---------------------- |
| ACP schemas and protocol validation           | Official SDK           |
| NDJSON framing and encoding                   | Official SDK           |
| JSON-RPC request correlation and cancellation | Official SDK           |
| Client handler dispatch                       | Official SDK           |
| Provider process supervision                  | Synara/Effect          |
| Queue and resource limits                     | Synara/Effect          |
| Session/product policy                        | Synara/Effect          |
| Normalized Synara events                      | Synara/Effect          |
| Error translation into Synara domain errors   | Thin local adapter     |

### Why this choice was made

1. Maintaining two production wire implementations is the dirtiest long-term option.
2. The official SDK follows upstream ACP behavior and reduces custom protocol ownership.
3. Provider adapters should depend on a stable Synara runtime interface, not choose a protocol
   implementation.
4. Effect remains useful where it provides real value: scopes, interruption, supervision, bounded
   application queues, and typed domain failures.
5. A hard cutover with no fallback makes errors visible instead of silently masking incompatibility.

### Production boundary

- `AcpSessionRuntime.ts` is the wire construction seam.
- Provider layers consume `AcpSessionRuntimeShape`; they do not select an SDK.
- Grok, Droid, and Cursor all fail through the same official path.
- The mock ACP agent also uses the official SDK, so tests do not validate a private wire against
  itself.
- `@agentclientprotocol/sdk` is pinned exactly at `1.2.1` and included in the server build.

### Custom wire code deleted in the local working tree

- `packages/effect-acp/src/agent.ts` and its tests;
- `packages/effect-acp/src/client.ts` and its tests;
- `packages/effect-acp/src/protocol.ts` and its large protocol test suite;
- `packages/effect-acp/src/rpc.ts`;
- `packages/effect-acp/src/terminal.ts`;
- private shared/stdio helpers;
- protocol diagnostic and mock-peer fixtures;
- Cursor client example.

The package currently retains only generated/schema/error adapters still imported by Synara. A
future deletion may replace those imports with official SDK types plus one local Effect error
translation, but that should happen only when it removes the remaining package rather than creates a
second compatibility layer.

### Important open ACP issue

The production stdout-to-`ReadableStream` bridge is not yet proven bounded:

- it uses a push-driven `ReadableStream.start` path;
- an unscoped `Effect.runFork` drains child stdout;
- it can enqueue without respecting `controller.desiredSize`;
- the official SDK line buffer may retain an unterminated line without a local byte ceiling;
- the existing conformance fixture uses a different pull-driven stream and therefore does not prove
  production backpressure.

Required closeout:

1. Replace the current bridge with one scope-bound, backpressured raw-byte admission path.
2. Delete the old bridge in the same change.
3. Add one focused production-adapter integration test with explicit byte/frame/queue limits.
4. Fail closed on oversized or unterminated input.
5. Do not parse JSON-RPC locally and do not restore `effect-acp` as fallback.

---

## 8. ACP benchmark methodology

The new benchmark uses the same runner and scenarios for both engines:

- **Effect baseline:** commit `5056e395e` (`v0.5.2`).
- **Official SDK current:** commit `9780ff8bb` plus the SDK-backed implementation.
- **Runtime:** Bun `1.3.12`, macOS ARM64.
- The stored result arrays contain 20 timed samples per scenario; the recorded operation counts use
  scale 5.
- Requests use an in-memory peer which returns a minimal JSON-RPC success response.
- Notifications use a request barrier so writes are observed before a sample completes.
- The slow-consumer case adds 1 ms of peer delay per message.
- RSS and heap values are process-level measurements, not allocations attributed to a single class.

The benchmark measures **wire machinery**, not model latency, provider process CPU, React rendering,
SQLite persistence, or the full Synara app.

---

## 9. ACP benchmark results

Lower latency is better. Higher operations/second is better. Percentage changes describe the
official SDK relative to Effect ACP.

### Throughput and latency

| Scenario                                |    Effect ACP |  Official SDK | Throughput change | p50 change | p95 change | Interpretation                                                    |
| --------------------------------------- | ------------: | ------------: | ----------------: | ---------: | ---------: | ----------------------------------------------------------------- |
| Sequential 256 B requests               |  69,132 ops/s | 155,289 ops/s |       **+124.6%** | **-55.5%** | **-39.6%** | Official SDK is clearly faster for small request/response traffic |
| Sequential 64 KiB requests              |  33,278 ops/s |  38,776 ops/s |        **+16.5%** | **-14.2%** |     +18.2% | Median improves, tail latency regresses slightly                  |
| Concurrent 32× 256 B requests, isolated |  77,706 ops/s | 163,361 ops/s |       **+110.2%** | **-52.4%** | **-19.4%** | Official SDK handles small concurrent requests much faster        |
| 256 B notifications                     | 180,836 ops/s | 198,403 ops/s |         **+9.7%** |  **-8.9%** |    +111.1% | Median improves, but this run shows substantial tail jitter       |
| 64 KiB notifications, isolated          |  54,950 ops/s |  28,232 ops/s |        **-48.6%** |     +94.6% |    +183.4% | Effect ACP is much faster for very large one-way messages         |
| Slow peer, 1 ms, 256 B                  |     635 ops/s |     670 ops/s |         **+5.5%** |  **-5.2%** | **-18.1%** | Official SDK is slightly smoother under downstream pressure       |

### Memory observations from isolated scenarios

| Scenario                       | Effect peak RSS | Official peak RSS | Official change | Interpretation                                                   |
| ------------------------------ | --------------: | ----------------: | --------------: | ---------------------------------------------------------------- |
| Concurrent 32× small requests  |       225.6 MiB |         784.8 MiB |     **+247.8%** | Official throughput win came with a large memory high-water mark |
| 64 KiB notifications           |       881.6 MiB |         463.0 MiB |      **-47.5%** | Official SDK was slower but retained substantially less memory   |
| Slow peer, small notifications |       143.3 MiB |          94.4 MiB |      **-34.1%** | Official SDK behaved better in this slow-consumer case           |

### What the benchmark supports

- For the traffic most similar to normal chat streaming—many small messages and concurrent
  request/response work—the official SDK is generally faster.
- The official SDK performs better when a small-message consumer is slow.
- Effect ACP can push very large one-way notifications faster.
- There is no universal RAM winner. The official SDK showed a serious high-water mark in the
  concurrent-request stress case, but lower memory in large-notification and slow-consumer isolated
  cases.

### What the benchmark does not support

- It does not prove the entire application is twice as fast.
- It does not directly measure CPU time, energy usage, UI frame rate, or first-token latency.
- It does not reproduce a 30–60 minute session with real provider processes.
- It does not prove long-transcript rendering is faster; that path is dominated by frontend state,
  React rendering, persistence, and provider/model latency.
- Combined multi-scenario memory readings are contaminated by previous scenarios and should not be
  used as isolated per-scenario claims.

### Practical day-to-day expectation

With multiple active chats, the official SDK should process small ACP events with lower median
latency and higher headroom. Streaming may feel more stable under concurrent activity, but model
latency will usually dominate visible response time. Long-chat scrolling/rendering should not be
expected to improve solely because of the ACP cutover. RAM under heavy parallel request bursts is the
main performance risk that still needs an end-to-end measurement.

---

## 10. Other important architectural changes

### Durable orchestration and delivery

- Accepted provider commands, queued turn promotions, and provider runtime events gained durable
  storage.
- Command fingerprints and scoped identities reduce accidental duplicate execution.
- Startup recovery distinguishes terminal evidence, replay-safe work, quarantined work, and
  uncertain external mutations.
- Projection snapshot/live cursors were made explicit to protect reconnect correctness.

Expected benefit: fewer lost, duplicated, or reordered chat operations after crashes, reconnects, or
partial streams. Cost: more persistence code and migrations to review.

### Persistence and migration recovery

- Database lifecycle locking was introduced.
- Migration backup and restore paths were added.
- Migrations 54–68 cover durable delivery, attachments, fingerprints, scoped identities, lifecycle
  generations, settlement state, causal sequences, queued promotion, runtime events, reconciliation,
  and Git handoff.

Expected benefit: failure becomes explicit and recoverable. Main risk: migration ordering and data
preservation must be audited carefully.

### Provider lifecycle

- Provider lifecycle/session ownership was centralized.
- Process teardown and child environments gained shared owners.
- Interaction responses are lifecycle-generation fenced.
- Terminal applicability and overlapping dispatch behavior gained focused coverage.

Expected benefit: fewer zombie sessions, double sends, stale approvals, and teardown races.

### WebSocket and frontend state

- Request/stream admission and compatibility logic became explicit.
- Snapshot-to-live handoff uses cursor-aware behavior.
- Web thread state was normalized to remove synchronization with a second derived authority.
- `wsNativeApi` listener setup/reset was consolidated.
- Composer send behavior and browser fixtures were simplified.

Expected benefit: reconnects and simultaneous chats should have more predictable event delivery and
less state divergence. Main risk: welcome/compatibility negotiation and listener reset order.

### Desktop and release boundary

- Desktop IPC channel strings gained a single data-only owner; all 49 leaves were checked for a
  producer and consumer.
- Browser-use pipe leases and native control were tightened.
- Update artifact identity and source provenance became explicit.
- Migration recovery and voice transcription paths gained focused tests.

Expected benefit: fewer stale-generation desktop actions and less updater ambiguity. Windows browser
pipe support intentionally fails closed until a safe per-user ACL design exists.

### Git handoff

- Mutating Git RPCs share a canonical-repository coordinator.
- Status parsing uses Git's machine-readable NUL protocol instead of quoted-path heuristics.
- Handoff operations gained durable phases and restart recovery.
- A mutation completed before a crash can replay its stored result; a pre-result interruption is
  marked `uncertain` instead of being silently rerun.

Expected benefit: safer worktree/branch/PR operations and better behavior with adversarial filenames.
Main risk: every destructive path must preserve exact repository and operation identity.

---

## 11. Verification evidence and limitations

### Evidence recorded by the implementation audit

The audit/controller records these focused results:

- prior pruning/regression sweep: **439/439** focused tests;
- ACP/adapter/attachment closeout: **48/48** server tests;
- web unit closeout: **29/29** tests;
- normalized store/selector phase: **96/96** tests;
- provider health/usage phase: **92/92** tests;
- automation recovery and UI phases include recorded 113/113, 10/10, 3/3, and 32/32 gates;
- desktop IPC/pipe phase records 20/20 focused tests;
- repository-wide ServiceMap scan checked 93 tag definitions and found no remaining tag-as-Effect
  pattern after the fix;
- `git diff --check` is repeatedly recorded as passing during pruning phases.

These are **audit-recorded results**. They were not all rerun while preparing this handoff.

### Known incomplete or deferred evidence

- The latest browser run reached an existing incomplete WebSocket welcome fixture where
  `protocolEpoch` is missing.
- Some Droid/native-fork and broader runtime scenarios timed out before their target predicate or
  later failed an unrelated durable-event assertion; they are recorded as deferred, not passing.
- The real production ACP backpressure boundary is not proven by the pull-stream conformance test.
- CPU usage was not measured directly in the ACP benchmark.
- No long-running real-app benchmark with 1, 5, and 10 simultaneous chats has been run.
- The latest local pruning/benchmark files have not received the repository's full final check.

### Required full verification before completion

Project policy requires all of the following to pass before the work can be considered complete:

```bash
bun fmt
bun lint
bun typecheck
```

They were not run while preparing this document because project instructions require explicit user
authorization for these heavyweight checks. Tests must use `bun run test`, never `bun test`.

---

## 12. Current risks and open work

Ordered by review importance:

1. **ACP raw-input backpressure:** production stdout admission can bypass Web Stream pressure and
   lacks a demonstrated unterminated-line byte ceiling.
2. **Review size:** 406 tracked files changed against the baseline makes cross-subsystem regression
   risk real even if individual tests pass.
3. **Uncommitted consolidation:** the strongest deletion work, including the private ACP wire
   removal, is still only in the local working tree.
4. **Memory under concurrent ACP requests:** the official SDK reached 784.8 MiB peak RSS in the
   isolated synthetic concurrent test versus 225.6 MiB for Effect ACP.
5. **Migration correctness:** migrations 54–68 must be reviewed for ordering, idempotency, rollback,
   and preservation of accepted work.
6. **Browser fixture gap:** WebSocket welcome compatibility is not fully covered by the current
   browser fixture.
7. **Deferred timeout cases:** Droid/native-fork and a broader runtime-mode scenario are not green
   evidence.
8. **Residual `effect-acp` package:** schema/error adapters remain; deleting them is desirable only if
   it removes the package without adding a compatibility clone.
9. **No direct CPU or end-to-end performance proof:** wire throughput is only a proxy.

---

## 13. Recommended independent review plan

This sequence is designed for Fable 5, Claude, or a senior human reviewer. It avoids attempting to
understand all 406 files in one pass.

### Pass 1 — establish the artifact boundary

1. Confirm baseline `5056e395e`, committed HEAD `9780ff8bb`, and dirty working tree.
2. Review committed and uncommitted changes separately.
3. Identify unrelated pre-existing user changes before proposing reversions.
4. Validate the LOC/accounting claims in this document.

### Pass 2 — review ACP as an isolated subsystem

1. Inspect `AcpSessionRuntime.ts` and `AcpAdapterSessionSupport.ts`.
2. Confirm Grok, Droid, and Cursor cannot select or fall back to a legacy wire.
3. Confirm the official SDK owns framing, validation, correlation, cancellation, and dispatch.
4. Confirm deleted `effect-acp` code has no production imports.
5. Audit cancellation, close, child-process teardown, raw logging, extension parsing, and errors.
6. Reproduce the stored benchmarks and examine the concurrent-request memory high-water mark.
7. Design the smallest replacement for the unbounded push bridge; do not add a second parser.

### Pass 3 — review correctness-critical chains

Review each chain end-to-end rather than file-by-file:

1. **Send a turn:** web composer → RPC admission → command reactor → provider → runtime ingestion →
   durable event → projection → WebSocket → normalized store.
2. **Approval/user input:** projection → durable claim → lifecycle-fenced provider response →
   settlement/replay.
3. **Crash/restart:** accepted command/output → persistent evidence → startup recovery → terminal or
   quarantined state.
4. **Reconnect:** snapshot cursor → live subscription → dedupe/order behavior.
5. **Git handoff:** request identity → canonical repo lock → mutation → stored result → metadata
   replay or uncertain state.
6. **Managed attachment:** upload principal → store → provider consumption → cleanup/process loss.

### Pass 4 — review cleanup quality

1. Inspect the five named hotspots for new helpers that merely hide rather than remove branches.
2. Look for old/new compatibility paths and demand an explicit deletion condition.
3. Search for duplicated lifecycle generation checks, settlement rules, projection replacement, and
   RPC admission.
4. Ensure contracts remain schema-only and shared runtime helpers use explicit subpath exports.
5. Confirm test scaffolding is proportional to the invariant being protected.

### Pass 5 — verification

1. Run focused tests for ACP, provider lifecycle, orchestration delivery, migrations, WebSocket
   reconnect, normalized web state, desktop IPC, and Git handoff.
2. Repair or explicitly quarantine the welcome fixture and deferred timeout cases.
3. Run `bun fmt`, `bun lint`, and `bun typecheck` once at the end with user authorization.
4. Run an isolated real-app soak with 1, 5, and 10 active chats for 30–60 minutes.
5. Measure process CPU, RSS, heap, event-loop delay, first update latency, update p95, dropped frames,
   disconnects, and lost/duplicate events.

---

## 14. Suggested prompt for Fable 5 / Claude

Copy this prompt and attach the repository/worktree:

```text
Review the Synara branch `codex/audit-code-quality` as a senior architecture, correctness,
performance, and maintainability reviewer.

Start by reading:
1. AGENTS.md
2. audit/BRANCH_REVIEW_HANDOFF.md
3. audit/README.md only for the exact workstream you are reviewing
4. advisor-plans/README.md only to confirm status and scope boundaries

Baseline: 5056e395e (v0.5.2)
Committed HEAD: 9780ff8bb
The working tree is intentionally dirty and contains important uncommitted ACP deletion,
consolidation, browser harness, and benchmark work. Do not revert or overwrite it.

Review committed and uncommitted changes separately. Do not accept audit claims without checking
the code and diff. Prioritize:
- lost, duplicated, or reordered provider/chat work during crash, reconnect, and partial streams;
- lifecycle generation, cancellation, teardown, and concurrent-session races;
- migrations 54–68 and durable recovery invariants;
- snapshot/live WebSocket cursor correctness;
- ACP official SDK cutover, absence of legacy fallback, close/error behavior, and raw-input bounds;
- the concurrent ACP benchmark memory high-water mark;
- duplicated ownership or abstractions that only hide spaghetti code;
- frontend normalized-state and listener-reset correctness;
- destructive Git operation identity and restart recovery;
- managed attachment authorization and cleanup.

For each finding provide:
- severity and confidence;
- exact file and line;
- concrete failure scenario;
- why existing tests do or do not catch it;
- smallest safe fix that deletes or consolidates ownership;
- focused verification command.

Do not add roadmap scope, broad rewrites, compatibility fallbacks, or new abstraction layers.
Prefer deletion and merging. Treat tests and documentation separately from runtime LOC.

Finish with:
1. release blockers;
2. correctness risks;
3. performance risks;
4. maintainability regressions/improvements;
5. claims in the handoff that you verified, disproved, or could not verify;
6. a short ordered fix list.
```

---

## 15. Reviewer command reference

These commands expose the intended review boundaries:

```bash
# Committed branch only
git diff --stat 5056e395e..9780ff8bb
git diff 5056e395e..9780ff8bb

# Local pruning only
git diff --stat 9780ff8bb
git diff 9780ff8bb

# All tracked branch and local changes
git diff --stat 5056e395e
git diff 5056e395e

# Untracked benchmark/harness artifacts
git status --short

# Whitespace/patch integrity
git diff --check
```

Useful entry points:

- `audit/README.md` — evidence ledger and detailed workstream acceptance criteria;
- `advisor-plans/README.md` — execution controller and pruning history;
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — official ACP SDK seam;
- `apps/server/scripts/acp-wire-benchmark.ts` — shared benchmark runner;
- `benchmarks/acp-wire/` — stored comparisons;
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — command ownership hotspot;
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — provider event hotspot;
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — projection hotspot;
- `apps/server/src/provider/Layers/ProviderService.ts` — provider lifecycle hotspot;
- `apps/server/src/wsRpc.ts` — RPC/stream hotspot;
- `apps/web/src/wsNativeApi.ts` — browser listener/transport owner.

---

## 16. Final assessment

The branch contains meaningful improvements: clearer durable ownership, stronger failure behavior,
less duplicated provider/projection/RPC logic, one official ACP wire, and substantially broader
invariant coverage. The local ACP deletion is particularly valuable because it removes thousands of
lines of private protocol code.

The main concern is not that nothing improved; it is that reliability work, migration work, tests,
and cleanup were combined into a review surface much larger than the original refactor request.
Before merge, the work needs an independent correctness review, completion of the ACP backpressure
boundary, reproduction of performance/memory results, resolution of deferred browser/runtime
evidence, and the mandatory final workspace checks.

This document is a map for that review. It is not a substitute for it.
