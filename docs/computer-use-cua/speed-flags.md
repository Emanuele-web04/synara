# Workstream C speed flags

Every latency optimization on the computer-use path ships behind its own
`SYNARA_CUA_*` environment flag, opt-in, with the pre-workstream-C behavior as
the default. The point of one flag per change is isolation: a live run flips
exactly one variable, and `SYNARA_CUA_TIMING_LOG` is what turns that run into
numbers.

This file is the flag reference. The rationale and budget targets live in
[workstream-c-speed-spec.md](workstream-c-speed-spec.md).

## Flag table

| Flag                             | Default | Effect when set                                                                                                                                                                  | Lives in                                          |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `SYNARA_CUA_TIMING_LOG`          | off     | Emits one `[computer-timing]` line per computer call: per-leg ms, counters, total.                                                                                               | `apps/server/src/computer/computerCallContext.ts` |
| `SYNARA_CUA_ACTION_SETTLE_MS`    | `300`   | Overrides the fixed post-action settle sleep; `0` removes it. Invalid values fall back to `300`.                                                                                 | `apps/server/src/computer/ComputerManager.ts`     |
| `SYNARA_CUA_CONDITIONAL_SETTLE`  | on      | Skips the settle sleep only when the action's delivery verdict already proves its effect — or a scroll leg's measured travel proves arrival. `0`/`off` restores the always-wait. | `apps/server/src/computer/ComputerManager.ts`     |
| `SYNARA_CUA_AX_ONLY_GET_STATE`   | removed | Retired: omitting `include_screenshot` selects the driver's default-capture path; the request now always sends explicit `false` on tree-only reads.                              | —                                                 |
| `SYNARA_CUA_CAPTURE_REUSE`       | on      | Explicit reads return the previous `screenshotId` when the fresh capture is byte-identical. `0`/`off` ships every frame.                                                         | `apps/server/src/agentGateway/computerTools.ts`   |
| `SYNARA_CUA_PREVIEW_STILL_MS`    | `2000`  | Overrides the pane still-capture cadence; clamped to the publisher's 100 ms floor.                                                                                               | `apps/server/src/computer/CuaComputerBackend.ts`  |
| `SYNARA_CUA_WARM_ON_FIRST_TOUCH` | off     | Spawns the driver and runs the validated handshake on the first probe or permission check.                                                                                       | `apps/desktop/src/cuaDriverHost.ts`               |

Boolean flags accept `1`, `true`, `on`, `yes` (case-insensitive, trimmed);
everything else — including `0`, `false`, `off`, `no` — counts as unset.
The two graduated flags (`CONDITIONAL_SETTLE`, `CAPTURE_REUSE`) invert that:
they ship on, and only `0`, `false`, `off`, or `no` turns them off.

## What each flag does, and what it must never do

### `SYNARA_CUA_TIMING_LOG` (inherited from `78bc88bae`)

Creates a per-call context on AsyncLocalStorage so the legs of one tool call —
`resolve`, `dispatch`, `settle`, `observe`, plus the native calls beneath —
sum into one `[computer-timing]` line. Durations, counts, and fixed operation
names only: no window titles, labels, pixels, or payload bytes ever reach the
log. Unset, no context is created and every leg helper is a passthrough, so
the default path allocates nothing.

Also emits `settle_skipped=1` as a counter whenever conditional settle waived
the wait, which is what makes the A/B comparison legible.

### `SYNARA_CUA_ACTION_SETTLE_MS` (inherited from `78bc88bae`)

The post-action settle is a fixed `setTimeout` before the screenshot that
rides on an action result — the repaint window the observation exists to
catch. The flag retunes or removes it (`0` = no wait at all). A constructor
override (`actionSettleMs`, used by tests) still wins over the environment.
With `0`, observation freshness depends entirely on the capture itself being
post-paint, so pair it with the timing log before believing it.

### `SYNARA_CUA_CONDITIONAL_SETTLE` (inherited from `78bc88bae`; graduated to default-on)

Now on by default — the flag is only a kill switch. The skip still requires **positive** proof on the same call: the backend's
`effect: "verified"` or a `verified: "confirmed"` read-back. It never fires
for `dispatched-unknown`, `unconfirmed`, `unverifiable`, or a missing verdict
— those are exactly the surfaces the fixed wait exists for. The verdict is
carried on the call context and consumed once by the post-action observer, so
it cannot waive a later call's settle, and a second action's verdict replaces
the first inside one call.

The same flag covers the settle each scroll leg pays inside the measure loop.
A leg whose route already carries a learned gearing has a predicted travel —
injected × gearing — so it is captured _before_ the wait, and a measurement
landing on that prediction (within `SCROLL_SETTLE_ARRIVAL_TOLERANCE`, floored
by `SCROLL_SETTLE_ARRIVAL_MIN_PX`) is itself the settle evidence: the wait is
waived and counted as `settle_skipped`. Everything else keeps the settle and
measures on a settled frame: no early capture, a refused correlation, zero
travel (the end of a page, which is also what feeds the unchanged-scroll
refusal), a suppressed wrong-way reading, travel off the prediction (still
animating, or a gearing that drifted), and every leg on a route with nothing
learned — a probe leg's settle is what makes its first measurement
trustworthy, so it can never waive itself. An off-prediction early reading is
dropped, never learned, and the settled recapture still measures against the
leg's own before-frame. Worst case the flag costs one extra capture per leg —
exactly when the speculation fails — while the best case removes the settle
from every leg after a window's first.

### `SYNARA_CUA_AX_ONLY_GET_STATE` (retired)

The flag omitted `include_screenshot`/`max_dimension` from tree-only
`get_window_state` calls, intending to pin a no-capture contract on the wire.
The driver's semantics cut the other way: an **absent** `include_screenshot`
defaults to capturing — at the full session ceiling, not even the 1536 px
cap — so the flag's wire shape asked for the largest possible frame on every
tree-only read. Removed: the request now always sends explicit
`include_screenshot:false` (plus `max_dimension:1536`), which is the real
pinned contract. Separately, the pinned upstream `7fe7c33f` already gates
both capture and attachment on `should_capture`, so the rev-17 "cached frame
attaches regardless" finding no longer needs a native change.

### `SYNARA_CUA_CAPTURE_REUSE` (added with this change; graduated to default-on)

Extends the post-action observer's existing dedupe to explicit perception
reads (`computer_get_state`, `computer_screenshot`). The fresh capture always
runs — only when its bytes, geometry (region and scale), and window identity
are all identical to the thread's latest delivered frame does the result name
the earlier `screenshotId` and mark `screenshotUnchanged` instead of shipping
the same megabytes again. Byte identity is the only "nothing changed" proof
there is, so this never serves a stale image; what it saves is the image part
of the tool result. Reuse is per thread: another conversation's identical
pixels still ship in full, because that model has never seen them.

### `SYNARA_CUA_PREVIEW_STILL_MS` (added with this change)

The pane's still publisher captures a whole-desktop PNG on a timer; the flag
retunes that cadence (default 2000 ms). The publisher's 100 ms floor still
applies — a lower value would only queue captures faster than one encode can
finish. The action path never reads the still stream, so this flag is a pure
background-cost knob.

### `SYNARA_CUA_WARM_ON_FIRST_TOUCH` (added with this change)

Driver startup splits into `ensureSpawned` (spawn plus the validated metadata
handshake) and `openSession` (`start_session` plus once-per-generation cursor
setup). With the flag set, the first computer request that answers without
the driver — a liveness `probe` or a `check_permissions` — fires
`ensureSpawned` in the background, so the first real input pays only session
setup instead of the whole cold start.

Warm runs at most once per host lifetime and stops at the handshake by
design: it opens no session, moves no focus, captures no pixels, and never
launches an app. A failed warm only logs `driver warm-up failed` — the
triggering request is untouched, and the first real call runs its own normal
startup. Every lifecycle barrier is shared with the cold path (`starting`,
`retiring`, `stopping`, epoch checks), so a `stop`/`suspend`/`pauseDesktop`
mid-warm retires the half-started generation exactly like a call-started one.

## Measuring

Per the spec, each flag wants an isolated before/after on a warm host:

```sh
# Baseline: all defaults, timing on.
SYNARA_CUA_TIMING_LOG=1 <run the computer-use path>

# Then one variable at a time, e.g.
SYNARA_CUA_TIMING_LOG=1 SYNARA_CUA_ACTION_SETTLE_MS=150 <same run>
SYNARA_CUA_TIMING_LOG=1 SYNARA_CUA_CONDITIONAL_SETTLE=1 <same run>
```

The `[computer-timing]` line splits each call into `resolve_ms`,
`dispatch_ms`, `settle_ms`, `observe_ms`, and the native legs beneath them,
so a flag's effect is readable per operation rather than only end-to-end.
Cold start (spawn + handshake + session) is a separate row from warm turns —
`SYNARA_CUA_WARM_ON_FIRST_TOUCH` moves that cost to the first touch; it does
not remove it.

## Landed versus still open

Landed and covered by unit tests: all seven flags above, each verified
off-by-default and on. The conditional-settle tests include the disagreeing
read-back case the spec calls out (`unconfirmed` keeps the settle), plus the
scroll-leg cases: a measured leg whose early travel lands on the gearing
prediction skips its settle, unmeasured and refused legs keep it, an
off-prediction early reading is never learned, and a waived settle cannot
upgrade a `dispatched-unknown` verdict. The scroll-leg skip also resolves the
spec's open decision on probe legs in the direction it recommended: only when
measured travel already proves arrival.

Landed evidence:

- **Live before numbers.** Warm-path p50/p95 per operation measured on a real
  host at native rev 17:
  `evidence/latency-rev17-2026-09-17-notes.md` +
  `latency-rev17-2026-09-17.json` / `…-supplement.json` (probe scripts kept
  beside them). Click, scroll, launch, and cold start meet the proposed
  budget at p50 and p95; get_state meets p50 but not p95 under desktop
  contention; the type row misses p50 on the AX-insert path. Wire-level
  finding recorded there: the rev-17 driver attaches its cached frame to
  every `get_window_state` reply. Resolved without a native change — the
  pinned upstream `7fe7c33f` gates attach on `should_capture`, and the
  request-shape flag was retired (omitting the field selects the driver's
  default-capture path; explicit `include_screenshot:false` is sent always).

Still open per the spec's acceptance criteria:

- **JPEG quality/size review (step 7).** No capture size or quality changed;
  the 1536 px budget stands because the last shrink cost aim precision.
- **App-launch prefetch.** Deliberately rejected by the spec: warm covers the
  driver only.
