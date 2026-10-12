# Opening chats and reading older messages — 2026-10-12

Long chats now open faster, switch faster, and scroll into older messages without
the viewport re-anchoring under the reader. The full transcript still loads at once:
no paging protocol, cache or client history state was reintroduced.

| Change                                                                  | Where                                                                          | Effect (real Chrome, medians)                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Content-aware row height hints and a measured-height cache              | `timelineRowHeight.logic.ts`, `useTimelineRowHeightHints.ts`, LegendList patch | Anchor jumps while reading older messages −93% to −98%          |
| Removed 23 Tailwind rules that force whole-document style recalculation | `group-has-*`, `has-*:*:`, `has-*:**:` usages, `index.css` variants            | Whole-document recalcs while scrolling 8–22 → 1–2               |
| Initial-scroll completion without the 100 ms timer fallback             | LegendList patch                                                               | A revisited chat appears ~100 ms sooner                         |
| No second thread subscription at startup                                | `routes/__root.tsx`                                                            | 2 → 1 snapshot per reload of an open chat                       |
| Process-tree scan off the server event loop                             | `processTreeController.ts`                                                     | 85% less event-loop blocking from `ps` during provider teardown |

## Results

Baseline `52f06318f` vs. this change in headed Google Chrome, three sessions per build,
alternating, medians. Raw values: [measurements.json](measurements.json).

Open a chat: click in the sidebar (real mouse) → the chat's rows visible and settled at
the bottom.

| Chat                        | Cold open, ms    | Switch back, ms | Style + layout per open, ms |
| --------------------------- | ---------------- | --------------- | --------------------------- |
| 666 msgs / 7,546 activities | 329 → 279 (−15%) | 113 → 64 (−43%) | 128 → 65 / 77 → 24          |
| 1,400 msgs / 237 activities | 212 → 162 (−24%) | 129 → 79 (−39%) | 91 → 30 / 92 → 28           |
| 111 msgs / 1,069 activities | 177 → 147 (−17%) | 112 → 77 (−31%) | 91 → 40 / 73 → 27           |
| 64 msgs / 1,373 activities  | 196 → 162 (−17%) | 111 → 63 (−43%) | 88 → 32 / 81 → 26           |
| 18 msgs / 476 activities    | 144 → 129 (−10%) | —               | 85 → 31 / —                 |

- Switch back happens after reading older messages in the 666-, 1,400- and 111-message
  chats, so those remounts restore scrolled-away transcripts.
- Main-thread time per open −16% to −41%; longest task per open −12% to −38%.
- Click event duration: equal on the largest cold open, 16–32 ms shorter elsewhere
  (e.g. 136 → 104 ms switching back to the largest chat).
- App start to sidebar ready: 378 → 370 ms (noise).

Read older messages: steady wheel input from the bottom (80–150 ticks, same distance in
both builds).

| Chat                        | Anchor jumps   | Whole-document recalcs | Style + layout, ms | Scripting, ms | Main thread, ms | Frames > 25 ms | Long animation frames |
| --------------------------- | -------------- | ---------------------- | ------------------ | ------------- | --------------- | -------------- | --------------------- |
| 666 msgs / 7,546 activities | 9,513 → 409 px | 22 → 2                 | 725 → 580          | 459 → 674     | 1,581 → 1,616   | 2.7% → 3.7%    | 1 → 0                 |
| 1,400 msgs                  | 3,278 → 80 px  | 8 → 1                  | 366 → 323          | 227 → 304     | 834 → 841       | 1.4% → 2.3%    | 0 → 0                 |
| 111 msgs / 1,069 activities | 4,923 → 333 px | 11 → 2                 | 503 → 461          | 319 → 450     | 1,141 → 1,209   | 3.8% → 5.9%    | 1 → 0                 |

- Frame p50 stays at 16.7 ms (60 Hz) in both builds; p95 is unchanged (18.7 ms) except
  the 111-message chat (18.7 → 31.8 ms).
- Trade-off: without anchor jumps pushing the reader back down, the same wheel input
  reaches up to 9,100 px further into history, so more rows mount while scrolling.
  Scripting rises 34–47%, main-thread time 1–6%, and 1–2 percentage points more frames
  exceed 25 ms; style and layout work still drops 8–20% and no frame becomes a long
  animation frame.

An earlier run on an Apple M5 Pro at 120 Hz with a real database, before the
initial-scroll fix, measured cold opens −13% to −20% and anchor jumps 10,296 → 394 px on
the largest chat, with frame pacing unchanged.

## Method

- Mac mini, Apple M6, 24 GB, macOS 27.0.1, 1920×1080 at 60 Hz; headed Google Chrome with
  GPU raster (ANGLE Metal), a fresh profile per session, 1440×900 viewport.
- Production `vite build` of each checkout served by its own isolated Bun 1.4.2 server
  (ports 3899 baseline, 3898 this change), each with a copy of the same database.
- Database: a fresh migrated Synara database with synthetic chats only, shaped like real
  Claude coding sessions (user prompt, commentary and Read/Grep/Bash/Edit tool calls with
  their lifecycle activities, a Markdown answer with lists, code blocks and tables,
  changed-file checkpoints): five benchmark chats (table above) and 48 short chats in
  the sidebar. No provider turns ran.
- One session: start at Home, cold-open the 666-message chat and wheel up 150 ticks, open
  the 64-message chat, switch back, open the 1,400-message chat and wheel 80 ticks, open
  the 111-message chat and wheel 100 ticks, switch back to the 64-message chat, open the
  18-message chat, switch back to the 1,400- and 111-message chats.
- Timing comes from `requestAnimationFrame` sampling in the page (first row of the chat
  visible, bottom reached, geometry settled), Event Timing for the click, the Long
  Animation Frames API, and a DevTools Performance trace per session summarized per step
  (main-thread self time by category; "whole-document recalcs" are style recalculations
  touching more than 500 elements).
- [`apps/server/perf/threadDetailStages.perf.test.ts`](../../../apps/server/perf/threadDetailStages.perf.test.ts)
  splits snapshot delivery into SQL + decode, RPC encode, JSON and client decode.

## Findings

### 1. Older messages: every row was estimated at 90 px

Real rows average 330 px (assistant median 473 px, user 105 px, work 38 px). The list
laid unrendered history out at roughly a quarter of its height, and each row rendered
above the viewport corrected the scroll position: reading a long chat moved the reader
back down by thousands of pixels (9,513 px over 150 wheel ticks above).

`getEstimatedItemSize` (added to the existing LegendList patch) asks a text-layout
estimate per row, calibrated on 259 measured rows of real transcripts (median error 3%),
and reuses the exact height measured by any earlier mount of the same row. Estimates are
cached per row object, so position passes do not rescan transcripts.

### 2. Whole-document style recalculation on every row mount

10% of style recalculations restyled the whole document (1,500–2,000 elements) even
though only a row changed. Deleting stylesheet rules in the running app isolated the
cause to `:has()` placed inside `:is()` together with a universal or child subject —
what Tailwind emits for `group-has-*`, `has-*:*:` and `has-*:**:` — and to non-subject
`:has()` whose argument or subject uses attributes common in transcript rows
(`data-slot`, `data-size`). Any single one of the 23 rules was enough. The same
conditions written as `:where(group):has(…) .cls`, `.cls:has(…) input`, or a CSS
variable read by `*:` children stay local; specificity is unchanged except where noted
in the code.

Computed styles of every rewritten surface match the baseline exactly: project headers
idle and with keyboard focus, the terminal font autocomplete in Settings, and the
Create project input group. `apps/web/src/hasSelectorVariants.test.ts` fails if these
variants come back.

### 3. Switching back to a chat waited for a 100 ms timer

With every row height known, a remounted chat lays out at its final geometry within a
few milliseconds, but LegendList kept it at `opacity: 0` until its 100 ms
`finishScrollTo` fallback: the end target includes the composer inset and footer, so it
lies past what the scroller can reach, the instant scroll moves nothing, and no scroll
event ever confirms arrival. The patch now treats a scroller that is already at the
target, or pinned at its native end once it holds the laid-out content, as arrived, and
checks completion on the next frame, about 100 ms before the fallback. When the target
is out of reach, the list also takes the scroller's real offset as its own, so history
prepended right after the reveal keeps the reader at the bottom.
`MessagesTimeline.scroll.browser.tsx` covers the reveal with timer fallbacks held back.

### 4. Startup subscribed to the open chat twice

The mount-time bootstrap subscribed to the open chat; the server welcome that arrived a
few milliseconds later on the same connection unsubscribed everything and subscribed
again, interrupting the first snapshot. Only the first welcome of the bootstrap's own
connection is now skipped; reconnect welcomes still resynchronize.

### 5. Synchronous `ps` scans blocked the server

Each provider probe teardown ran `ps -eo pid,ppid,lstart,command` with `spawnSync`
(40–50 ms with ~1,000 processes) on the event loop that serves snapshots. The scan now
runs asynchronously with the same command, parser, retries and results.

| 30 full app loads, server CPU profile | Before |  After |
| ------------------------------------- | -----: | -----: |
| `spawnSync` (event loop blocked)      | 2.07 s | 0.32 s |
| Total server CPU samples              | 22,563 | 17,633 |

### Snapshot delivery (unchanged)

| Thread                      | Snapshot | SQL + decode | RPC encode | JSON | Client parse + decode |
| --------------------------- | -------: | -----------: | ---------: | ---: | --------------------: |
| 666 msgs / 2,031 activities |   3.2 MB |        64 ms |      16 ms | 6 ms |                 21 ms |
| 66 msgs / 1,475 activities  |   2.9 MB |        32 ms |      12 ms | 5 ms |                 16 ms |
| 18 msgs / 449 activities    |   0.4 MB |         9 ms |       4 ms | 1 ms |                  4 ms |

SQL is 6–8 ms of a 25–30 ms snapshot for real threads; the rest is row decoding and
schema validation. Deep `Schema.Json` validation of activity payloads is ~65% of the
client decode; switching it off is a contract decision and was left out.

## Not changed

- Paging the transcript (removed in `52f06318f`) was not reintroduced. The list already
  mounts only the rows in view; what remains of a cold open is mostly snapshot delivery
  and rendering those rows.
- Real provider processes, packaged Electron and Windows were not measured. The
  process-tree change keeps Windows on its existing CIM path.

## Reproduce

[`apps/web/perf/chat-open-runner.mjs`](../../../apps/web/perf/chat-open-runner.mjs) is a
headless check of the same paths (cold open, warm switch, wheel to the first message,
full reload) against an isolated server with a copied database:

```bash
node apps/web/perf/chat-open-runner.mjs http://127.0.0.1:3899 <neutral-thread> <thread>... --rounds=3 --out=before.json
```

Run it once per build. Headless Chromium rasterizes in software, so use a headed browser
for frame pacing.

## Review repair: bounded estimates and valid measurements

The reviewed implementation now samples at most 4,096 text characters per row and
extrapolates larger messages. Rendering, copy and search still receive the complete
message; this is only a best-effort virtualizer height hint. A heterogeneous remainder
may differ from the sample, and actual row measurement remains authoritative.

Cross-mount measurements are thread-scoped and reused only for unchanged, settled plain
messages with default presentation. Expanded/editing messages, live work, rich disclosures,
attachments and compound rows are re-estimated. Message identity is kept through a weak
reference so remembering geometry cannot retain an unloaded transcript's content. Font
family/UI font size join the existing width/chat font size layout key. This conservative
policy can reuse fewer measurements than the original implementation; the opening and
switching gains above have not been re-measured for this repaired policy.

Cache regressions exercise the measurement owner directly: matching IDs across threads,
background content growth, expanded user rows and synthetic mutable rows all fail the
original implementation. The existing browser suite verifies immediate remount reveal,
attached follow and independent horizontal code scrolling. A total-scroll-range browser
probe could not isolate stale cache entries from deliberately approximate rich-row hints,
so it is not used as evidence of near-exact geometry or a new application-level timing.

An isolated estimator benchmark compares the original and bounded implementations on
the **same 2,000 newline-heavy messages**, under Bun 1.4.2, with five alternating samples
per implementation and a fresh estimator per sample. No measurement cache is populated.
These are helper execution times, not application CPU or browser frame-time results.
Raw samples: [repair-estimator-measurements.json](repair-estimator-measurements.json).

| Identical input    | Original median | Bounded median |
| ------------------ | --------------: | -------------: |
| 20 MB / 2000 rows  |        37.50 ms |       16.30 ms |
| 200 MB / 2000 rows |       345.56 ms |       16.01 ms |
