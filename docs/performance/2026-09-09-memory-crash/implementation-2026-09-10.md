# Implemented memory and streaming fixes — 2026-09-10

## Result

Implemented durable append-only assistant-text chunks, lossless completion/restart handling, fixed-size OpenCode snapshot fingerprints, and history-preserving adapter snapshots. All measurements below were executed locally during this implementation. No incident-host measurement or packaged-app run was performed.

The 200,000-byte real-engine workload writes **1,346.27 → 402.48 MiB of WAL (70.10% less)**. The synthetic OpenCode fixture retains **50.13 → 0.14 MiB of snapshot keys** while preserving the original 50 MiB of tool outputs. The unsafe latest-turn eviction was removed: its earlier claimed 50.25 → 0.36 MiB saving is **not part of this implementation**.

## Storage and correctness

- Migration 100 adds `message_text_chunks`, an applied-event watermark and rare JSON fallbacks. It preserves existing message/segment bodies and projector cursors and is safe to replay. Composite cascading ownership deletes chunks when their message is purged. The chunk table uses `WITHOUT ROWID` to avoid a redundant row-id/primary-key index.
- During streaming, each delta writes its own JSON-encoded text. Existing legacy/resumed text moves into a prefix chunk once; the frequently updated message metadata row stays small. Existing segment prefixes remain immutable, with end time derived from the latest chunk.
- All repository, snapshot, thread detail and export readers assemble complete text. Snapshot caps still select message identities before loading bodies. Completion materializes once and releases chunks; replay watermarks survive compaction and rollback.
- JSON encoding preserves UTF-16 code units split across chunks and across segments, including a response stopped on an unmatched surrogate. No text cap or payload truncation was introduced.
- The new restart test exposed another bug: the command cache could contain only post-restart deltas and override complete durable text. Completion now reads its exact message by thread/message identity, including messages older than the 2,000-message display window, without loading uncapped history.
- Claude, Cursor, Grok, Droid, Devin and Pi keep the history their adapter contracts expose. The four ACP adapters copy snapshot arrays so later append/rollback operations do not mutate returned arrays. Arbitrary nested payload objects are not deep-cloned. Pi's independent one-current-tool-snapshot deduplication remains.
- OpenCode retains SHA-256 fingerprints instead of a second serialized copy of every message/part. Original parts, replay state and emitted-text tracking remain. This changes memory ownership, not message delivery or content.

## Paired engine measurements

Environment: Apple M5 Pro, 48 GiB, Darwin 25.6.0, Node v26.8.1, SQLite 3.53.4, Vitest 4.1.10. File-backed databases use production migrations and the production OrchestrationEngine/Effect SQL path. Each sample starts a fresh Node/Vitest process and fresh disposable database. No separate warmup phase; setup/migrations precede timing. Baseline and final samples ran sequentially, without another test/check command from this task running alongside them; unrelated host activity was uncontrolled.

Chunks are 40 ASCII bytes. Setup WAL is truncated before measurement. Autocheckpoint is disabled so growing WAL length captures this fixture's WAL output. These numbers do **not** measure SSD writes or estimate checkpoint/OS amplification. Engine writes include orchestration events, receipts and projections; provider runtime-journal writes and provider processes are outside this fixture.

| Workload                | Samples per version | Before WAL (MiB) | After WAL (MiB) | Reduction |
| ----------------------- | ------------------: | ---------------: | --------------: | --------: |
| 8,000 B × 1 thread(s)   |                   1 |            15.27 |           14.90 |     2.44% |
| 50,000 B × 1 thread(s)  |                   1 |           155.01 |           99.42 |    35.86% |
| 200,000 B × 1 thread(s) |                   3 |         1,346.27 |          402.48 |    70.10% |
| 50,000 B × 4 thread(s)  |                   1 |           633.79 |          420.95 |    33.58% |

The four-thread case interleaves commands through the serial engine. It does not run four real providers. A further final-only 400,000-byte run wrote 808.09 MiB: approximately twice the 200,000-byte result, consistent with eliminating growing-body rewrite amplification. Substantial per-command transaction/index overhead remains.

| Workload                | Before streaming (ms) | After streaming (ms) | Before completion (ms) | After completion (ms) |
| ----------------------- | --------------------: | -------------------: | ---------------------: | --------------------: |
| 8,000 B × 1 thread(s)   |                  91.2 |                 89.1 |                   2.60 |                  2.17 |
| 50,000 B × 1 thread(s)  |                 513.4 |                471.2 |                   2.80 |                  3.83 |
| 200,000 B × 1 thread(s) |                2651.2 |               1738.1 |                   3.26 |                 11.97 |
| 50,000 B × 4 thread(s)  |                1866.4 |               1842.0 |                   5.67 |                 13.23 |

For 200,000 bytes, streaming median improved 34.44% across three samples. Baseline range: 2629.6–2660.1 ms; final range: 1679.6–2006.2 ms. Single-sample timing differences for other workloads are directional only. Completion costs more because it reconstructs durable text; that cost occurs once rather than on every delta.

Final 200,000-byte full-snapshot reads took 4.92–5.59 ms. The baseline harness timed the in-memory command-cache read, so its `streamingReadMs` is **not a comparable SQL-read baseline** and no read-speed improvement is claimed. The retained baseline harness documents this difference; streaming timing/WAL boundaries are unchanged. Timer-delay samples in raw JSON use an explicit event-loop yield every 100 chunks and are fixture diagnostics, not a UI-latency measurement.

Sampled engine-process peak RSS median: 263.34 → 262.11 MiB. Sampled peak JS heap: 146.02 → 148.84 MiB. The process includes Vitest and test infrastructure; sampling is every 100 chunks and excludes read/completion peaks. **No engine RAM reduction or leak-free claim is supported by these samples.**

## OpenCode retained-memory measurement

Fresh process per mode/sample, three samples each, forced GC, 200 distinct tool-part objects containing 256 KiB ASCII output each. Both modes retain the identical data shape and byte counts; randomized bodies differ across processes. Baseline keys use the previous `JSON.stringify` behavior; optimized keys call the actual production function.

| Metric (median)            |     Before |     After |
| -------------------------- | ---------: | --------: |
| Retained snapshot-key heap |  50.13 MiB |  0.14 MiB |
| Retained parts plus keys   | 100.19 MiB | 50.20 MiB |
| Create 200 keys            |    8.18 ms |  24.65 ms |

This removes 49.99 MiB of duplicate retention in this collection (99.71%). Hashing adds 16.47 ms for these 200 large snapshots. These are collection-level measurements, not a whole-app or SDK RAM reduction.

## Validation

- 733 tests across 68 files passed in the final persistence/orchestration/provider run. It covers all persistence tests and the affected adapter suites/conformance tests. This was not the full workspace test suite.
- New regressions cover every message reader; migration/replay of existing state; close/reopen between chunks with graceful fixture shutdown; Unicode across segments; unmatched-surrogate completion; completion of a resumed message outside the display cap; duplicates before/after completion and actual rollback; final text replacement; legacy streaming prefixes; hard purge; history preservation and snapshot-array ownership; fingerprint equality and Unicode distinctions. These restart tests did not inject an abrupt process kill.
- `bun fmt` passed. `bun lint` passed with 528 existing warnings and zero errors. All 7 packages passed `bun typecheck`. Targeted formatting/lint/type checks cover subsequent compatibility and migration-fixture corrections.
- Initial failures and their corrections are retained in logs: TypeScript's configured string library required a compatible unmatched-surrogate detector; legacy migration fixtures needed schema-100 setup and updated tracker expectations. No failing production behavior was waived.
- Two independent read-only auditors checked storage/replay/completion and provider retention/fingerprints. Their actionable findings were fixed and exercised by tests.

## Reproduction and evidence

Run from the repository root:

```sh
SYNARA_STREAMING_BENCHMARK_OUTPUT=/private/tmp/synara-streaming.json SYNARA_STREAMING_BENCHMARK_BYTES=200000 bun run --cwd apps/server test src/orchestration/Layers/StreamingPersistence.benchmark.test.ts
node --expose-gc docs/performance/2026-09-09-memory-crash/opencode-snapshot-key-memory.mjs baseline
node --expose-gc docs/performance/2026-09-09-memory-crash/opencode-snapshot-key-memory.mjs optimized
```

Set `SYNARA_STREAMING_BENCHMARK_THREADS=4` for the interleaved workload. Run each repetition in a new process. The benchmark is skipped in ordinary test runs unless an output path is supplied. Disposable databases are closed and removed in `finally`.

Raw evidence in this directory: `implementation-baseline-*.json`, `implementation-final-*.json`, `opencode-key-*.json`, `implementation-summary.json`, corresponding logs, the retained `engine-baseline-harness.ts.txt`, and `implementation-tests-final.txt` / `implementation-typecheck-final.txt`. Baseline engine measurements were captured before production edits; source SHA-256 hashes identify the measured versions. Reproducing that exact historical baseline requires the matching pre-change source. Final hashes were checked against the current source. Intermediate candidates, including the small-message write regression before `WITHOUT ROWID`, are preserved and excluded from final headline figures.

## Remaining limits and risks

- Abrupt backend death can still orphan processes. No PID-only reaper was added: safe ownership after owner death needs an out-of-process supervisor (plus platform-specific containment), including a defined Windows/WSL strategy. This work does not claim to fix that defect.
- Historic raw-item mirrors in six adapters, OpenCode original part bodies, SDK-owned histories, and count-only downstream queues still need separate lifecycle/byte-budget work. Restoring history correctness necessarily removes the earlier lossy-eviction memory saving.
- The runtime journal's per-event write cost remains. No lossy pre-broadcast compaction or cursor-acknowledgement policy change was introduced.
- The two 4 GB incident processes, renderer's 1.4 GB, exact panic cause, physical disk-write totals and whole-app RAM effect remain unattributed/unmeasured here. A packaged-build soak on 16 GiB hardware with real providers is still needed before claiming the user-visible crash is resolved.
- Changes are local. No user database was migrated by these experiments and nothing was published.
