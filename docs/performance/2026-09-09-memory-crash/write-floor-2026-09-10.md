# Per-delta write floor after the chunk table (stacked on PR #1097)

After `message_text_chunks` removed the quadratic rewrite, every streamed token chunk still cost a flat ~19 WAL frames in two engine commits plus ~27 KB and one more commit in the runtime journal. This change removes the avoidable part of that floor without touching durability semantics.

## Changes

1. **Deferred cursor settled inside the hot transaction** (`ProjectionPipeline.settleDeferredPhaseInHotTransaction`, `OrchestrationEngine`). The deferred phase has no projector for streamed deltas; its only work was moving its cursor in a second autocommit statement after the commit. The hot transaction now moves it when it is caught up with the hot cursor, and the engine skips the deferred pass for those events. A lagging deferred cursor (failed or in-flight catch-up) is never moved by the hot transaction; the catch-up still replays from it. Regression: `ProjectionPipeline.test.ts` "settles the deferred cursor inside the hot transaction only when it is caught up".
2. **Minimal per-delta message-row update** (`messageTextChunks.append`). The previous `INSERT … ON CONFLICT DO UPDATE` listed `role`, `source` and `sequence` in its SET clause on every delta, so SQLite rewrote the three indexes containing them even when unchanged. The hot path now reads the row once (the read replaces the previous `hasApplied` query) and updates only the columns that changed; the always-written columns (`updated_at`, `is_streaming`, `text_event_sequence`, `text`/`text_json`) are not indexed. Semantics are unchanged: `turn_id` only fills a null, `role`/`source` are replaced when they differ, optional JSON/enum columns are written only when the payload carries them, `sequence` is never rewritten. Covered by the existing `messageTextChunks.test.ts` suite.
3. **Page-level journal acknowledgement** (`ProviderRuntimeEventRepository.advanceConsumerCursorThrough`, `ProviderRuntimeIngestion`). Processed journal rows are acknowledged once per drained page in one transaction, with the same per-row open-turn bookkeeping and retention sweep as the single-row advance (shared helpers). The cursor is flushed before quarantine, dead-lettering and the page-progress check, and on shutdown. A crash between processing and the flush replays at most one page (128 rows); replayed commands are idempotent by command id and by the text watermark. `hasPendingEventsForThreads` can lag by one page while a drain is in progress. Regression: `ProviderRuntimeEvents.test.ts` "acknowledges a drained page in one transaction with per-row bookkeeping".

## Measurements

Same fixture as the earlier reviews: real engine and migrations on a file-backed database, `wal_autocheckpoint = 0`, WAL parsed frame by frame and attributed to b-trees via `dbstat`. Node 26.8.1, SQLite 3.53, Apple M5 Pro. Raw JSON: `write-floor-*.json`; the "before" rows are `review-chunk-pages-*.json` and `journal-writes-1000-40.json` from the same fixture on PR #1097.

| Workload                      |             Before (PR #1097) |                                After | Frames / delta | Commits / delta |
| ----------------------------- | ----------------------------: | -----------------------------------: | -------------: | --------------: |
| 8 KB message, 40 B chunks     |      14.75 MiB, 77.4 KB/delta |     11.61 MiB, 60.9 KB/delta (−21 %) |    18.8 → 14.8 |           2 → 1 |
| 50 KB                         |       97.5 MiB, 81.8 KB/delta |      77.6 MiB, 65.1 KB/delta (−20 %) |    19.9 → 15.8 |           2 → 1 |
| 200 KB                        |                      ~402 MiB |     316.4 MiB, 66.3 KB/delta (−21 %) |              — |           2 → 1 |
| Runtime journal, 1,000 events | 26.3 KB/event (per-event ack) | 21.9 KB/event (128-row pages, −17 %) |              — |   2 → 1 + 1/128 |

Per token chunk end to end: ≈105 KB and 4 commits before, ≈83 KB and 2 commits after. For reference, before PR #1097 the same 8 KB message wrote 15.2 MiB and a 400 KB message wrote 4.0 GiB.

## What still remains (structural)

Frames per delta are now dominated by the event log and command receipts: `orchestration_events` + 4 indexes ≈ 5.2, `orchestration_command_receipts` + 3 indexes ≈ 4.0, `sqlite_sequence` 1, and in the journal `provider_runtime_events` + its indexes ≈ 5. Removing those requires a design decision (no receipt row for delta commands, carrying idempotency on the chunk watermark; or fewer indexes on the event log), not a local optimisation, and is left out on purpose.

## Validation

See the pull request description for the exact command results.
