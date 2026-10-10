# Horizontal chat tab switching — 2026-10-01

Switching tabs now retains the chat surface and composer controls. Draft mount
scheduling applies only until the first chat is mounted; a saved chat can still
bypass a pending initial delay. Undo history resets at the editor boundary,
preserving thread isolation. PR dialogs remain scoped to their originating
thread. Recording an already-open tab no longer serializes and writes the
unchanged tab list.

These changes reuse the existing chat surface, editor, and tab store. They do
not retain hidden chat trees or change transcript scroll ownership, subscription
retention, provider startup, or initial-draft background-window safeguards.

## Method

- Apple M5 Pro, 48 GiB RAM, macOS 27.0.1 arm64; Node 24.21.0, Bun 1.4.2,
  Vitest 4.1.10 and bundled Playwright Chromium.
- Full application router, production CSS, React Compiler and real Lexical
  editors, with a fixture WebSocket server. Desktop viewport: 960 × 1100.
- React runs in development mode under Vitest; the existing
  `skipReactDevOwnerStacks` helper disables owner-stack capture identically in
  both runs. This is not a production JavaScript build.
- Two cases: two saved chats with 44 messages each; a saved chat and an unsent
  draft. Both have distinct composer drafts. Each case performs 12 round trips
  using the actual horizontal tab buttons. Discard the first round trip for
  warm statistics: 22 saved-to-saved samples, 11 samples per other direction.
- Timing starts at the DOM click and ends at the first animation-frame sample
  showing the destination route, active tab, expected composer text, and the
  destination transcript's last assistant row with the list's opacity enabled
  (except the empty draft). `domReadyMs` records the earlier point at which
  those nodes exist; `clickToReadyMs` also waits for the list to become visible.
  This distinction matters: LegendList hides rows while settling initial scroll.
- `reactUntilReadyMs` sums React Profiler durations until that same readiness
  point; it excludes subsequent settling and is not total CPU time.
- Missing UI counts sample DOM in requestAnimationFrame, before presentation;
  they are not exact painted-frame counts or an INP measurement. The readiness
  metric checks the list's visibility state, not the compositor's presentation.
- The paired runs use the same finalized measurement instrumentation. Raw
  samples, including warm-up, are in [measurements.json](measurements.json).
  Video capture and workspace checks ran separately from the timed pair.
- Other work was running on this Mac. Wall-clock figures are directional local
  evidence, not a production guarantee. The lifecycle gaps and unnecessary
  storage writes reproduced independently of timing variation.

## Paired results

| Warm transition                  | Samples | Visible median before → after |       Change | p95 before → after | React until ready before → after |
| -------------------------------- | ------: | ----------------------------: | -----------: | -----------------: | -------------------------------: |
| Saved → saved                    |      22 |              169.5 → 167.3 ms |   1.3% lower |   183.5 → 175.2 ms |                   25.5 → 23.6 ms |
| Draft → saved                    |      11 |              186.4 → 114.8 ms |  38.4% lower |   202.8 → 118.0 ms |                   30.7 → 32.7 ms |
| Saved → previously visited draft |      11 |                60.1 → 73.6 ms | 22.5% higher |     61.8 → 77.5 ms |                   17.6 → 19.0 ms |

p95 uses the nearest-rank method. Warm ranges were 166.4–191.7 → 166.0–176.1 ms
for saved-to-saved; 183.5–202.8 → 105.6–118.0 ms for draft-to-saved; and
57.8–61.8 → 67.7–77.5 ms for returning to the draft.

Saved-to-saved total opening time is effectively unchanged in this workload.
Its destination DOM/composer becomes ready earlier (median 86.6 → 78.3 ms),
but list initialization still dominates full transcript visibility. The return
to a previously visited draft is 13.5 ms slower in this pair. We retain that
tradeoff for the consistent header/composer and faster first draft entry,
without claiming a general latency or CPU reduction. No hidden chat cache or
retained transcript tree was added.

The first entry into the unsent draft measured 156.4 → 80.8 ms (one sample,
48.3% lower). That entry previously removed both header and composer for two
rAF samples; neither was absent after the change. Saved-chat switches previously
removed the composer for one rAF sample on every switch; all sampled switches
now retained it. Reopening tabs writes the unchanged tab list zero times,
previously once per normal switch and twice on the first draft entry.
The first saved-to-saved sample was 196.1 → 204.7 ms; it does not establish a
cold-opening improvement. Process startup is outside this fixture's scope.

The new regression fails on the baseline for missing header/composer and passes
on the optimized code. It also checks destination content, unchanged tab-list
persistence, and Undo isolation after typing and switching tabs. Existing branch
selector reset coverage passes with the retained composer controls.

## Rejected list experiments

Two additional changes were measured and removed. Separate row estimates by
message role increased saved-to-saved median visibility time to 182.5 ms.
Limiting initial off-screen rendering to 50 px before restoring the default
produced 166.8 ms, effectively unchanged from 167.3 ms. The latter also reduced
DOM time in the run, so it did not establish a meaningful gain in the list's
visibility delay beyond host timing variation. Neither justified introducing
new scroll initialization behavior. Transcript keys, list configuration, and
the existing measurement/scroll ownership remain unchanged.

## Verification

- `bun run fmt:check`, `bun run lint`, and `bun run typecheck` passed. Lint
  reports 793 warnings and zero errors.
- `bun run test`: 14,355 passing tests, 36 skipped, across all six test workspaces.
- Browser regression pass: 137 tests across `ChatView.browser.tsx`,
  `useOpenThreadTabs.browser.tsx`, `MessagesTimeline.tailAnchor.browser.tsx`,
  and `useTailAnchorScroll.browser.tsx` passed. This covers switching, draft
  isolation, focus, branch selection, scrolling and tail-anchor behavior.
- The browser pass emitted two console messages about `ResizeObserver` loops
  completing with undelivered notifications, without test failures. The baseline benchmark
  also emitted a router preload error from the fixture; the baseline regression
  failures were the expected header/composer absence assertions.
- The benchmark regression subsequently passed with the stricter transcript
  visibility criterion on the same final production code. No list experiment
  is included in the final changes.

## Reproduce

```bash
VITE_TAB_SWITCH_BENCHMARK=1 bun run --cwd apps/web test:browser \
  src/components/ChatView.browser.tsx -t 'switches horizontal tabs' \
  --silent=false --reporter=verbose
```

The opt-in prints `TAB_SWITCH_BENCHMARK` records. Ordinary CI uses two round
trips and asserts behavior, without noisy wall-clock thresholds. App process
startup, production Electron, remote-provider/network latency, sustained CPU,
RAM and GPU use were not measured by this browser fixture.

The remaining bottleneck is transcript initialization. Before changing its
mount/scroll ownership, repeat the visibility measurement in an isolated
production desktop build with representative real histories and capture its
layout/paint trace. The current evidence does not justify a broader cache or
virtualizer rewrite.

## Follow-up changes in the same pull request

The sections above describe the first commit only. Four later commits build on it; this
section records what they change and the same benchmark re-run with all of them applied.

- Tab feedback: the pressed tab reads as selected within one frame, selection starts on
  mouse press, and the chat renders right after that frame paints.
  A subsequent interaction fix restores normal completed-click selection in both chat
  tab strips: holding the mouse button or releasing outside the tab does not switch chats.
  Optimistic highlighting and deferred rendering still start immediately after the click.
- Streaming and startup: the sidebar, tab strip and global shortcuts no longer re-render
  for every streamed token, and stored settings are decoded once instead of once per
  subscriber per write.
- Chat header and composer: props derived from the whole thread object are stable, so the
  header, model picker, environment panel and message trail stop re-rendering per token
  and per keystroke.
- Transcript reveal: the `@legendapp/list` patch now treats being pinned at the scroller's
  native end as arrival. The list's end target includes the footer and bottom padding and
  sat past what the scroller can reach, so its arrival check never passed and the rows
  stayed transparent until a fixed 100 ms fallback. This was the "transcript
  initialization" bottleneck named above.

Same fixture, machine and session as each other (12 round trips, first discarded, medians
of two runs); `main` and the first commit were re-measured in that session:

| Warm transition                  |   `main` | First commit | All commits |
| -------------------------------- | -------: | -----------: | ----------: |
| Saved → saved, visible           | 169.5 ms |     166.8 ms |     80.0 ms |
| Draft → saved, visible           | 185.4 ms |     174.0 ms |     76.5 ms |
| Saved → previously visited draft |  60.1 ms |      62.7 ms |     30.9 ms |
| First entry into a draft         | 172.9 ms |      66.4 ms |     35.1 ms |

Header and composer stay present on every sampled switch and the unchanged tab list is not
rewritten, as in the first commit. A separate probe (60 streamed deltas, one per frame, CPU
profiler attached) measured React render time during streaming at about 920 → 569 ms and
the median frame gap at 39 → 23 ms; settings decoding at startup went from 200 → 2 ms.

The same limits apply: development React in headless Chromium, not a production desktop
build. The Issue #550 ratio guard in `ChatView.browser.tsx` remains at 2.5. The initial
local recalibration to 3.5 was removed during review to preserve the regression
limit introduced by #1397. Performance claims must satisfy that unchanged workload
and guard; a smaller short-case denominator alone does not authorize a weaker limit.

After pulling, run `bun install` and clear Vite's dependency cache
(`apps/web/node_modules/.vite`) so the patched list build is prebundled again.

## Review validation with the unchanged Issue #550 guard

The initial complete change failed the existing 2.5 limit in two quiet probes
(median ratios 3.50 and 3.61), despite reducing absolute render work. A temporary
stage profile identified repeated activity normalization as 87.8% of near-cap
work-log derivation time. Activity objects are immutable store values, so the
normalizer now reuses that pure per-activity result through a WeakMap. Filtering,
collapse and turn settlement still run with the current projection on every call.
The reconnect test verifies running → failed → running with the same activity and
fresh metadata from a replacement event.

A serial matched pair compared main `2c2d2bb942f47c6717167ac061378421016aae1f`
with candidate `e90ce8a4d656ab147c2a600060e17c0155e62c78`, including that repair.
Both cases warm up before three paired samples, using Node 24.21.0, Bun 1.4.2,
Vitest 4.1.10 and headless Chromium with no competing validation processes.
Numeric logging was temporary and happened after measured work; it was removed.
[Raw review records](./review-measurements.json) preserve all paired samples.

| Issue #550 measure (median) |     Main | Repaired candidate |
| --------------------------- | -------: | -----------------: |
| Short React commit work     |  44.6 ms |            22.9 ms |
| Near-cap React commit work  | 106.5 ms |            39.7 ms |
| Paired near-cap/short ratio |    2.388 |              1.734 |

Both versions pass the unchanged 2.5 ratio limit. These records establish bounded
React commit work for this development fixture, not production desktop speed or
application-wide CPU, RAM or GPU improvements. One candidate near-cap input P95
sample was 83.3 ms while the others were 34.3 and 34.6 ms; no reliable input-tail
improvement is claimed. The later tab, streaming and startup figures above remain
author-reported; the first-commit measurements and these review records are the
committed raw evidence.

Review also reproduced and fixed queued tab-navigation races: opening a terminal,
closing the pressed chat tab, or committing a later navigation cancels its deferred
activation. Navigating away and back also clears the old optimistic highlight. Full
editor-route regressions verify that late animation-frame callbacks and the background
fallback cannot reopen the chat afterward. A real-router probe also reproduced a
newer tab press being discarded between the earlier activation returning and its
React route commit. While activation is outstanding, the helper now hands that
newer press directly to the router; only the latest activation can settle the
optimistic highlight. Navigation cancellation remains owned by the existing router.
