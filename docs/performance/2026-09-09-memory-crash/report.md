# Synara memory crash investigation

The current code contains confirmed memory-retention and process-cleanup defects. Local fixes address OpenCode's unused tool-output history, failed idle agent retirement, orphaned terminals, and memory-heavy SQLite history reads. The supplied report is consistent with serious system-wide memory pressure, but the raw panic, process arguments, diagnostic stacks, and affected database were not supplied. These fixes cannot yet be claimed to explain every reported gigabyte or prevent this exact panic from recurring.

A subsequent [deep audit of all nine providers](provider-audit.md) found additional issues, implemented five targeted follow-up fixes, and records the remaining high-priority work. The initial fixes are not a claim that every provider is leak-free.

## Evidence and interpretation of the report

| Claim                                                                          | Assessment                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severe memory pressure contributed to the watchdog panic                       | Consistent with the reported compressor size, low free memory, and workload. The raw panic is needed to verify the accounting and exclude other causes.                                                                                                                                       |
| The two large idle `node` processes prove a leak                               | Unproven. A single RSS sample and waiting threads do not distinguish a retained heap, native allocation, normal workload, or a leak. Process arguments, creation times, ownership, and repeated heap/native measurements are missing.                                                         |
| 32.83 GB RSS means exactly that much physical RAM was demanded                 | Treat this as reported accounting, not a reconciled physical-memory total. Shared and compressed memory complicate attribution. Electron specifically cautions about RSS interpretation on macOS. [Electron process memory documentation](https://www.electronjs.org/docs/latest/api/process) |
| `StatementSync::All` plus `pwrite` proves a SQL write loop                     | Unproven. `all()` also executes SELECT queries. SQLite sorts can spill temporary data to disk; this code had queries that sorted complete tool outputs and message bodies. [Node SQLite](https://nodejs.org/api/sqlite.html), [SQLite temporary sorting](https://www.sqlite.org/eqp.html)     |
| A 5.8-hour disk-write report proves a continuously frozen 5.8-hour main thread | The report duration and sampled stacks do not establish continuous unresponsiveness. The original diagnostic and time-resolved traces are needed.                                                                                                                                             |
| SQLite is executing inside Electron's UI main process                          | Current `apps/desktop/src/main.ts` launches the backend separately with `ELECTRON_RUN_AS_NODE=1`. That child uses the app executable and can share its process name. PID arguments are needed to distinguish it from the UI main process. SQLite still blocks the backend's event loop.       |
| Build version 43.4.1 identifies the Synara revision                            | It matches the current Electron dependency. It does not identify the Synara commit or prove the crashing checkout matches this worktree; current Synara package versions are 0.8.3.                                                                                                           |
| The diagnostic write-rate threshold is a hard operating-system disk allowance  | Do not interpret the reported threshold as an enforced I/O quota, or assume file-backed dirty bytes equal physical SSD writes.                                                                                                                                                                |

The report's suggested remedies were treated as hypotheses, not instructions. No processes on the incident host were inspected or killed, and no personal database was modified.

## Confirmed defects and implemented fixes

### 1. OpenCode retains obsolete tool-output snapshots

`apps/server/src/provider/Layers/OpenCodeAdapter.ts` appended every pending/running/completed tool update to `context.turns`. Each update could contain a fresh cumulative copy of a growing output. This array had no consumer: `readThread` fetches provider-backed history. Retention increased with all prior updates, not merely the current output.

Removed the unused array, snapshot type, append helpers, and append call. Added a shared message-state eviction helper that releases part payloads, serialized comparison keys, emitted text, completion markers, and pending deltas on message/part removal. Pending deltas now retain their owning message ID, allowing removal before a first part snapshot. Related child removals are routed, child tool parts are released when parent ownership ends, and synthetic next-text entries are released at turn completion.

This fixes specific retention paths. It does not put a byte budget on the entire OpenCode session or guarantee that a stale HTTP snapshot cannot restore a removed part.

### 2. Failed process cleanup can be silently skipped on retry

`apps/server/src/provider/Layers/ProviderService.ts` previously called `adapter.stopSession` only when `hasSession` returned true. Adapters deliberately stop accepting work before process-tree cleanup finishes. If cleanup failed, a retry could skip the retained cleanup barrier and record the binding as stopped.

Runtime retirement now always crosses the adapter's idempotent cleanup barrier. Idle cleanup failures retry after 1–30 seconds, retaining their original generation. New user work, live task activity, and service shutdown invalidate that ownership. A delayed `session.exited` notification cannot cancel a still-unproven idle cleanup attempt. Resume cursors remain preserved.

The new regression fails against the original source: it observes one cleanup attempt instead of the required second attempt. It passes with the fix. This does not strengthen adapters whose own teardown implementation lacks descendant-exit proof.

### 3. Dock terminals and detached xterms outlive their owner

Dock terminals use a separate `dock-terminal:<threadId>` scope. Deleting/archiving a host previously closed only `<threadId>`, leaving the dock PTY and its children alive. Renderer orphan cleanup also removed metadata without disposing detached xterm objects and their scrollback/listeners/DOM.

A shared scope helper now supplies both identities. Server cleanup attempts both independently and preserves the archive timestamp fence, so terminals opened after an undo are protected. Local deletion disposes both renderer scopes after acceptance. Authoritative snapshots and live archive/removal updates prune loaded runtimes synchronously through a lightweight registration callback, without eagerly importing xterm. Snapshot cleanup runs after buffered newer events, preserving a newer unarchive. Registry matching uses exact scope identities.

A repeated lifecycle regression creates and detaches 20 host/dock pairs, removes them, and returns retained instances to the two unrelated active baseline instances on every iteration. This tests object ownership, not actual renderer RSS.

### 4. SQLite history reads sort large bodies before enforcing display limits

`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` used `SELECT *, ROW_NUMBER() ...` over complete histories before limiting results. That carries large message/tool bodies through window sorting or materialization. A 2,000-row display cap did not bound intermediate memory or temporary I/O.

Window queries now rank narrow identities, then join the selected rows to their bodies. Turn-boundary handling, unresolved approvals/input, nullable sequence ordering, thread identity, checkpoint ordering, and export behavior are preserved. Text segments load only for selected `(threadId, messageId)` pairs rather than loading every historical segment and discarding most in JavaScript.

SQLite remains synchronous. The change reduces avoidable work on the blocked path; it does not move the database to a worker or eliminate the cost of large returned histories.

## Measurements

Environment: Apple M5 Pro, 48 GiB RAM, macOS/Darwin 25.6.0 arm64, Node 26.8.1, SQLite 3.53.4, Bun 1.4.2, Vitest 4.1.10. This differs from the reported M1 Pro/16 GiB incident host and is not the packaged Electron runtime.

### History query probe

Synthetic database: one live thread, 6,000 messages and 6,000 tool activities, each body 16 KiB. SQLite uses a 128 MiB page cache and 512 MiB mmap ceiling, matching current 16-GiB-host settings. Each sample runs in a fresh child process with one warm-up and one measured query; three samples per query/version, alternating query order between repeats. Versions ran sequentially; host load was not controlled. Results are workload-specific.

| Query                         | Median process peak before → after | Reduction | Median query time before → after | Reduction |
| ----------------------------- | ---------------------------------: | --------: | -------------------------------: | --------: |
| Bulk message window           |                565.61 → 377.48 MiB |     33.3% |                 43.66 → 20.44 ms |     53.2% |
| Single-thread message window  |                565.83 → 377.22 MiB |     33.3% |                 46.25 → 21.17 ms |     54.2% |
| Bulk activity window          |                255.92 → 115.16 MiB |     55.0% |                  19.15 → 7.21 ms |     62.3% |
| Single-thread activity window |                379.66 → 275.58 MiB |     27.4% |                177.51 → 19.22 ms |     89.2% |

Peak RSS is the whole worker high-water mark, including warm-up; it is not the retained heap or just the memory of one query. Baseline/optimized result counts and SHA-256 digests match for every sample. JavaScript result heap sizes stayed essentially unchanged because the returned data is unchanged. Query-time ranges were 43.48–44.36 / 20.14–21.91 ms, 43.76–47.26 / 20.55–22.22 ms, 19.06–19.44 / 7.03–7.22 ms, and 176.68–178.68 / 18.89–19.72 ms respectively. CPU medians also decreased; full values and plans are in the raw JSON.

Filesystem write counters returned zero and are not used as evidence of I/O savings. No percentage reduction in daily writes, whole-app RAM, or crash frequency is claimed. A three-sample probe does not establish p95/p99 production latency.

Reproduce from the repository root (frozen baseline/optimized SQL is replayed by default):

```sh
node --expose-gc docs/performance/2026-09-09-memory-crash/snapshot-memory.mjs baseline
node --expose-gc docs/performance/2026-09-09-memory-crash/snapshot-memory.mjs optimized
```

Use `optimized --capture` only to explicitly replace the optimized SQL with current source. Do not recapture the historical baseline from modified source. Evidence: `baseline-queries.json`, `optimized-queries.json`, `baseline.json`, `optimized.json` in this directory.

### Isolated OpenCode retention probe

The probe executes the original append helpers preserved in `baseline-opencode-retention.txt` and compares the same latest-part store without that removed append. It materializes 256 cumulative JSON tool updates, ending at 256 KiB output, in fresh processes. Three samples per mode, alternating mode order, forced GC before/after, no warm-up.

The old path retained all 256 historical snapshots and about **32.50 MiB** of additional heap. Without the unused history, it retained zero historical snapshots and about **0.59 MiB**, while keeping the latest part. The three runs matched at the shown precision. This isolates the retention mechanism; it excludes the SDK, queues, persistence, and renderer and is not a whole-adapter memory benchmark.

```sh
node --expose-gc docs/performance/2026-09-09-memory-crash/opencode-retention.mjs
```

Raw evidence: `opencode-retention.json`. The terminal registry test similarly establishes released ownership, not an RSS reduction.

## Validation and release status

- Six focused server files: **226 tests passed**, covering providers, cleanup retries, snapshots/segments/export, and terminal lifecycle cleanup.
- Three web unit-test files: **12 tests passed**, including repeated detached-runtime disposal, exact scope ownership, lazy cleanup registration, and delete ordering.
- Shared terminal identity tests: **9 tests passed**.
- Four real Chromium lifecycle tests: **4 passed**, covering live archive/thread removal/project removal and a reconnect snapshot followed by a newer buffered unarchive. An initial run exposed test-fixture deletion tombstones leaking between cases; the fixture was corrected and all four passed together.
- Independent read-only audits covered provider cleanup, renderer ownership, and SQL semantics. Twenty additional SQL comparisons across five randomized datasets matched baseline and optimized results, including nullable/tied sequences, cross-thread identities, and pending/resolved interactions.
- Final workspace validation, explicitly authorized by the user: **`bun fmt`, `bun lint`, and `bun typecheck` all passed**. Lint reported warnings with no errors; typechecking completed all seven workspace packages. Formatting changed only files in this investigation.
- No application rebuild, incident-host soak, commit, push, deployment, or release has been performed.

## Remaining risks and the next evidence to collect

1. **Claude retains complete raw turn snapshots for `readThread`.** Unlike the removed OpenCode array, these have a consumer. A durable history reader or explicitly bounded snapshot contract is needed before trimming them. Profile retained tool results/images/thinking across repeated turns and compaction; record post-GC growth, not only RSS.
2. **Count-bounded queues are not byte-bounded.** Several stages permit 2,048 full events. Large tool outputs plus slow SQLite can retain substantial RAM across multiple queues. Measure each stage's queued bytes and delivery latency, then apply byte-aware backpressure without dropping lifecycle/approval events. The existing 32-MiB callback bound covers only an ingress stage.
3. **No host-wide budget covers all provider/MCP/terminal descendants.** Track owned process trees by PID plus creation identity while roots are alive, with per-session RSS/private footprint and live/idle task state. Record host pressure and event-loop delay. Admission control should account for already-owned work and other host load; a V8 heap flag does not limit native/Bun/Rust allocations or grandchildren. Arbitrary forced recycling of active agents is not included in this fix.
4. **Some teardown paths still cannot prove descendant ownership after a root exits.** A PPID snapshot after reparenting can miss children. This patch preserves conservative cleanup behavior but does not introduce process groups/job objects or repair every adapter's native cleanup semantics.
5. **Renderer and backend history windows remain count-based.** The renderer already retains at most 32 inactive detail entries with a 15-minute age policy and bounded message/activity counts; large bodies can still make those expensive. Confirm retained size by thread and byte-budget the cache before reducing visible history. No evidence here establishes a general DOM/image/worker leak.
6. **Database work still blocks the backend.** If long tasks remain after narrow-query fixes, profile SQL duration, temporary sorting, event ingestion, WAL/checkpoints, and event-loop lag together. Moving SQLite to a worker should preserve transaction/ordering semantics and be measured on an affected database copy.

For an incident reproduction, obtain the Synara commit/build, provider versions, raw panic/diagnostic files, a redacted PID/PPID/creation-time/command snapshot, live-task counts, and a memory timeline before/after turns, idle retirement, archive, and shutdown. Use a consented, redacted database copy if needed. Avoid collecting full chat content or credentials in routine diagnostics. Run the packaged build on 16 GiB hardware through the affected workload and verify that RAM stabilizes after idle cleanup, descendants exit, and disk activity settles.
