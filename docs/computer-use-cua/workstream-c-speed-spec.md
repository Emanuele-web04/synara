# Workstream C: Speed spec

## Problem

Kartik says computer use is not fast. Every agent turn pays several stacked costs. Host startup, fixed settle sleeps, observation windows, screenshots, AX tree walks, preview work, and one socket round trip per call add up. No single cost dominates in all cases. Work must cut the stack in budget order, with measurement first, and with zero reliability regressions.

## Current state

These numbers are verified against source or named docs. Anything else in this doc is marked unverified.

Host startup is lazy and bounded. The host spawns the driver on first use (`apps/desktop/src/cuaDriverHost.ts:598`), with spawn args pinned at (`apps/desktop/src/cuaDriverHost.ts:610`). The metadata handshake polls up to 80 times (`apps/desktop/src/cuaDriverHost.ts:673`) with a 200 ms per try timeout (`apps/desktop/src/cuaDriverHost.ts:680`) and a 50 ms delay between tries (`apps/desktop/src/cuaDriverHost.ts:684`). The two post handshake startup calls, session start and cursor motion setup, each default to a 5 s bound (`apps/desktop/src/cuaDriverHost.ts:701`). Cursor motion is configured once per generation at 100 ms glide and 0 ms dwell (`apps/desktop/src/cuaDriverHost.ts:722`).

Every tool call is one socket round trip with a 30 s timeout (`apps/desktop/src/cuaDriverHost.ts:541`). A first turn therefore pays spawn plus handshake plus session setup plus cursor setup before any input runs. Later turns reuse the warm generation. Warming the host earlier only moves this cost, it never removes it.

Action settle is a fixed 300 ms sleep (`apps/server/src/computer/ComputerManager.ts:111`), applied before the screenshot that rides on an action result (`apps/server/src/computer/ComputerManager.ts:1000`). The value is injectable for tests (`apps/server/src/computer/ComputerManager.ts:199`). Scroll legs each pay the same settle inside measure (`apps/server/src/computer/ComputerManager.ts:1898`), so a probe plus remainder scroll pays settle more than once. Paste pays a separate fixed 250 ms clipboard restore wait (`apps/server/src/computer/ComputerManager.ts:121`).

Native observation budgets are fixed in the spawn environment. Foreground post action observation is 100 ms (`apps/desktop/src/cuaDriverHost.ts:625`). Background post action observation is 350 ms (`apps/desktop/src/cuaDriverHost.ts:631`).

AX tree walks got faster at rev 7. Bounded parallel attribute fetch cut measured tree walks from about 673 ms to about 207 ms on the test desktop (`docs/computer-use-cua/integration-refresh.md:63`). Tree requests still ask for up to 1024 elements at depth up to 25 (`apps/server/src/computer/CuaComputerBackend.ts:800`). Internal target resolution can reuse a tree younger than 5 s (`apps/server/src/computer/CuaComputerBackend.ts:109`), and the manager passes that reuse flag on the resolve path (`apps/server/src/computer/ComputerManager.ts:3010`). The reuse check itself is at (`apps/server/src/computer/CuaComputerBackend.ts:786`). Agent facing state reads never reuse; freshness is required there.

Screenshots cost pixels and bytes. The model image budget caps the long side at 1536 px (`packages/shared/src/modelImageBudget.ts:2`). Window capture defaults to the same 1536 px (`apps/server/src/computer/CuaComputerBackend.ts:738`), and tree plus screenshot reads use 1536 px (`apps/server/src/computer/CuaComputerBackend.ts:802`). The action observation budget matches the agent image budget by design (`apps/server/src/computer/ComputerBackend.ts:55`). Both pictures are read by the same eyes and pointed at through the same frame registry (`apps/server/src/computer/ComputerBackend.ts:50`).

Preview work runs beside the action path. Stills capture a whole desktop PNG every 2 s (`apps/server/src/computer/CuaComputerBackend.ts:236`), reusing a tool observation younger than 1500 ms when one exists (`apps/server/src/computer/CuaComputerBackend.ts:225`). The native frame tap captures at 960 px or less with a 15 fps cap (`docs/computer-use-cua/native-preview.md:28`) and measured 12.5 fps with 75 of 75 valid JPEG frames at about 91 KB average in the live socket test (`docs/computer-use-cua/native-preview.md:39`). No JPEG quality knob was found in server or host source, so encode tuning lives in the native helper and is unverified.

This matches the parity matrix. Gap item 5 says fixed 300 ms settle plus no AX observer settle slows every turn and weakens read back (`docs/computer-use-cua/v2-parity-matrix.md:45`). This spec is the build plan for that gap.

## Approach

Budgets first, then instrument, then cut in budget order. No step may regress reliability. That constraint is hard.

Step 1 is the budget table. Every number below is a proposed warm target. Warm means the driver generation already exists and the target app is already running. The measured column is from `docs/computer-use-cua/evidence/latency-rev17-2026-09-17-notes.md` (native rev 17, M4 Pro VM, macOS 26.5.2, n=30 per op; that VM ran sibling driver instances, so p95 tails carry contention stalls — see the evidence notes before treating a p95 miss as a code regression).

| Operation                                          | p50 target | p95 target | Notes                                                                                                                            |
| -------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| get_state, AX only, warm                           | 400 ms     | 900 ms     | No screenshot; tree walk dominates; measured p50 219 ms, p95 1.2 s uncontended (p95 15.9 s contended) — see wire note below      |
| get_state, with screenshot, warm                   | 900 ms     | 1800 ms    | Tree plus 1536 px capture; measured p50 349–431 ms, p95 1.3 s block / 4.9 s interleaved tail                                     |
| click, input plus observation                      | 800 ms     | 1600 ms    | Includes 300 ms settle today; measured p50 659 ms, p95 742 ms — meets both                                                       |
| type, focus neutral AX insert                      | 600 ms     | 1200 ms    | No focus excursion on the AX path; measured write leg p50 1 122 ms, full compose p50 1 343 ms — misses p50                       |
| scroll, single leg                                 | 800 ms     | 1600 ms    | Probe splits pay settle twice today; measured p50 743 ms, p95 823 ms — meets both                                                |
| launch, app already installed                      | 2000 ms    | 5000 ms    | OS cost dominates; measured p50 1 956 ms, p95 2 133 ms (first-ever launch 19.8 s once) — meets both                              |
| turn start, warm host, first tool call             | 800 ms     | 2000 ms    | No spawn cost; measured ≈ warm get_state 219–811 ms, trivial call 0.7 ms — meets uncontended                                     |
| host cold start, spawn plus handshake plus session | 2000 ms    | 5000 ms    | Bounded by the 5 s startup calls; measured p50 55 ms, p95 108 ms (n=23) — meets both; first-exec spawn can outlast the handshake |

Wire note (rev 17, measured): `get_window_state` replies are near-unitary — the driver attaches its cached frame whenever `screenshot_frame_freshness` is `captured_current_space`, so an AX-only read still ships the embedded PNG (~150–190 KB reply) and `include_screenshot` gates capture work rather than attachment. Resolved in the `7fe7c33f` pin without a native change: `should_capture` now gates both capture and attachment, so a tree-only read ships no image. The request-shape flag (`SYNARA_CUA_AX_ONLY_GET_STATE`) was retired rather than graduated — omitting the field selects the driver's default-capture path, so explicit `include_screenshot:false` is the pinned contract and is sent unconditionally.

Step 2 is instrumentation. Add per operation timing from tool entry to result delivery, split into resolve, dispatch, settle, capture, and encode legs. Log the legs on every computer tool call behind a flag. Promote the first failing operation, not the average, because the p95 row is what Kartik feels.

Step 3 is warm host at first touch. Start the driver generation when the user opens a computer capable surface or when a turn first mentions computer use, not when the first input dispatches. Keep the existing rule that no input runs before the validated handshake. Warming must not start sessions, move focus, or capture pixels on its own.

Step 4 is redundant capture removal through frame registry reuse. Reuse the delivered frame when the post action capture is byte identical and the coordinate frame matches, so the model never pays twice for the same pixels. Keep the rule that observation failures never rewrite the input verdict. Keep the rule that a hinted window that vanished reports closure instead of substituting another window.

Step 5 is conditional settle. Skip the fixed 300 ms sleep only when read back already proves the effect, such as a verified delivery or a measured scroll arrival. Where effect proof is required, verification reads stay mandatory and are never skipped for speed. Unverifiable surfaces keep the current fixed settle. This is the exact gap the parity matrix names.

Step 6 is the AX only fast path for get_state. Serve tree only reads without screenshot capture, screenshot encode, or image delivery. Keep agent facing reads fresh; reuse stays limited to internal target resolution.

Step 7 is JPEG quality and size review. Review tap resolution, frame cap, still cadence, and 1536 px capture size against readability and aim precision. Smaller is not automatically better: the 1536 px budget exists because a 1024 px trial lost precision and paid it back as mis aimed clicks and extra repeat screenshots. Any size cut must prove aim precision holds.

Step 8 is env tunable flags in SYNARA*CUA*\* style for A/B. Every cut ships behind a flag with the current behavior as default, so each optimization can be isolated in a live run.

## Interfaces

New environment flags, all optional, all defaulting to current behavior:

| Flag                           | Default | Effect when set                                                            |
| ------------------------------ | ------- | -------------------------------------------------------------------------- |
| SYNARA_CUA_WARM_ON_FIRST_TOUCH | 0       | Start the driver generation at first computer touch instead of first input |
| SYNARA_CUA_ACTION_SETTLE_MS    | 300     | Override the fixed action settle sleep                                     |
| SYNARA_CUA_CONDITIONAL_SETTLE  | 0       | Skip settle only when read back proves the effect                          |
| SYNARA_CUA_AX_ONLY_GET_STATE   | removed | Retired: omitting the field selects the driver default-capture path        |
| SYNARA_CUA_CAPTURE_REUSE       | 0       | Reuse byte identical delivered frames instead of recapturing               |
| SYNARA_CUA_PREVIEW_STILL_MS    | 2000    | Override the still capture cadence                                         |
| SYNARA_CUA_TIMING_LOG          | 0       | Emit per leg resolve, dispatch, settle, capture, encode timings            |

Defaults mirror code: 300 ms settle (`apps/server/src/computer/ComputerManager.ts:111`), 100 ms foreground and 350 ms background observation (`apps/desktop/src/cuaDriverHost.ts:625`), 5 s tree reuse (`apps/server/src/computer/CuaComputerBackend.ts:109`), 1500 ms image reuse (`apps/server/src/computer/CuaComputerBackend.ts:225`), 2 s still cadence (`apps/server/src/computer/CuaComputerBackend.ts:236`).

No tool surface changes. No contract changes. Flags are host and server side only.

## Acceptance criteria

Each criterion is checked on a warm host unless it names cold start.

- Every budget table row has a measured p50 and p95 from at least 20 live runs, recorded with the machine and app named.
- get_state AX only, click, and turn start meet their p50 targets with all flags at defaults, or the miss has a named owner and a next step.
- Conditional settle never skips a verification read where effect proof is required. Proven by a test where read back is forced to disagree and settle plus recapture still run.
- Frame reuse never substitutes another window for a vanished hinted window. Proven by the close window case returning closure.
- No reliability regressions: the affected workspace suites pass, including computer manager, backend, screenshot reuse, and desktop host tests.
- Each optimization flag shows an isolated before and after measurement in the evidence log.
- Parity matrix gap item 5 reads as addressed or narrowed, with the matrix updated to match.

## Tests and evidence

- Unit tests for conditional settle: verified delivery skips the sleep; unconfirmed delivery keeps it; unverifiable surfaces keep it. The settle value stays injectable (`apps/server/src/computer/ComputerManager.ts:199`).
- Unit tests for frame reuse: identical bytes plus identical coordinate frame reuses; any geometry change recaptures; vanished hinted window reports closure.
- Unit tests for the AX only path: tree only reads perform no capture call and return no image.
- Unit tests for flags: each flag at default reproduces current behavior exactly.
- Live evidence log: per operation p50 and p95 before and after each flag, with machine, app, run count, and flag values recorded. Cold start measured separately from warm turns.
- Aim precision check for any size or quality cut: click landing error on small targets must not grow versus the 1536 px baseline.

## Risks

- Warming the host too early wastes a spawn and can confuse lifecycle accounting if the turn never uses computer. Mitigation: warm at first real touch only, and reuse the existing generation barrier.
- Conditional settle can hide a slow paint if read back checks the wrong signal. Mitigation: skip only on positive effect proof, never on timeouts or ambiguous reads.
- Frame reuse can serve a stale picture after a Space change or window swap. Mitigation: reuse only on identical bytes plus identical coordinate frame, and never across desktop epochs.
- Smaller or cheaper captures can cost more than they save through mis aimed clicks. The 1536 px history proves this failure mode is real. Mitigation: the aim precision check is required, not optional.
- Timing logs can leak window titles or pixel data. Mitigation: log durations and sizes only, never labels, text, or bytes.

## Open decisions

- Which operations matter most. Kartik's input decides. Recommendation: optimize click and get_state first, because every turn pays them and the settle plus capture stack sits on that path. Safe default if Kartik does not reply: keep the budget table order and start with click.
- Whether conditional settle may apply to scroll probe legs. Recommendation: yes, but only when measured travel already proves arrival. Safe default: keep fixed settle on probe legs until the travel proof test passes live.
- Whether to lower the still cadence or tap resolution. Recommendation: measure first; preview work runs beside the action path and may not be the bottleneck. Safe default: leave preview settings unchanged until action path legs meet budget.
- Whether warm on first touch covers app launch prefetch. Recommendation: no. Launching apps the agent may never use is a side effect, not a warmup. Safe default: warm the driver only, never launch.

## Implementer brief

Build in this order. Stop after any step that regresses reliability and fix it before continuing.

1. Add the timing log behind SYNARA_CUA_TIMING_LOG. Measure the budget table on a warm host. Publish the before numbers.
2. Add SYNARA_CUA_ACTION_SETTLE_MS as an override with default 300. Confirm default behavior is bit identical.
3. Add conditional settle behind SYNARA_CUA_CONDITIONAL_SETTLE. Skip only on positive effect proof. Add the disagreeing read back test.
4. Tree-only get_state reads skip capture by sending explicit include_screenshot:false unconditionally (the AX_ONLY flag was retired — see the wire note). Covered by the no-capture wire-shape tests.
5. Add frame registry reuse behind SYNARA_CUA_CAPTURE_REUSE. Add the identical frame and vanished window tests.
6. Add warm on first touch behind SYNARA_CUA_WARM_ON_FIRST_TOUCH. Measure cold start versus warm turn start separately.
7. Review JPEG quality and sizes last, with the aim precision check gating any cut.
8. Record every before and after in the evidence log. Update parity matrix gap item 5 to match what actually landed.
