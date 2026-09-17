# Workstream C speed flags

Every latency optimization on the computer-use path ships behind its own
`SYNARA_CUA_*` environment flag, opt-in, with the pre-workstream-C behavior as
the default. The point of one flag per change is isolation: a live run flips
exactly one variable, and `SYNARA_CUA_TIMING_LOG` is what turns that run into
numbers.

This file is the flag reference. The rationale and budget targets live in
[workstream-c-speed-spec.md](workstream-c-speed-spec.md).

## Flag table

| Flag                             | Default | Effect when set                                                                                  | Lives in                                          |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `SYNARA_CUA_TIMING_LOG`          | off     | Emits one `[computer-timing]` line per computer call: per-leg ms, counters, total.               | `apps/server/src/computer/computerCallContext.ts` |
| `SYNARA_CUA_ACTION_SETTLE_MS`    | `300`   | Overrides the fixed post-action settle sleep; `0` removes it. Invalid values fall back to `300`. | `apps/server/src/computer/ComputerManager.ts`     |
| `SYNARA_CUA_CONDITIONAL_SETTLE`  | off     | Skips the settle sleep only when the action's delivery verdict already proves its effect.        | `apps/server/src/computer/ComputerManager.ts`     |
| `SYNARA_CUA_AX_ONLY_GET_STATE`   | off     | Omits `include_screenshot`/`max_dimension` from `get_window_state` on tree-only reads.           | `apps/server/src/computer/CuaComputerBackend.ts`  |
| `SYNARA_CUA_CAPTURE_REUSE`       | off     | Explicit reads return the previous `screenshotId` when the fresh capture is byte-identical.      | `apps/server/src/agentGateway/computerTools.ts`   |
| `SYNARA_CUA_PREVIEW_STILL_MS`    | `2000`  | Overrides the pane still-capture cadence; clamped to the publisher's 100 ms floor.               | `apps/server/src/computer/CuaComputerBackend.ts`  |
| `SYNARA_CUA_WARM_ON_FIRST_TOUCH` | off     | Spawns the driver and runs the validated handshake on the first probe or permission check.       | `apps/desktop/src/cuaDriverHost.ts`               |

Boolean flags accept `1`, `true`, `on`, `yes` (case-insensitive, trimmed);
everything else — including `0`, `false`, `off`, `no` — counts as unset.

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

### `SYNARA_CUA_CONDITIONAL_SETTLE` (inherited from `78bc88bae`)

The skip requires **positive** proof on the same call: the backend's
`effect: "verified"` or a `verified: "confirmed"` read-back. It never fires
for `dispatched-unknown`, `unconfirmed`, `unverifiable`, or a missing verdict
— those are exactly the surfaces the fixed wait exists for. The verdict is
carried on the call context and consumed once by the post-action observer, so
it cannot waive a later call's settle, and a second action's verdict replaces
the first inside one call. Scroll legs keep the configured settle either way;
the spec's open question on probe-leg skips stays defaulted to "no".

### `SYNARA_CUA_AX_ONLY_GET_STATE` (added with this change)

A tree-only `get_state` already skips capture, encode, and image delivery
unconditionally. The flag changes only the request shape: `include_screenshot`
and `max_dimension` are omitted entirely, so the driver never even sizes a
frame for a read that discards it, and the AX-only contract is pinned on the
wire where an A/B run can isolate it. A read that asked for pixels sends both
arguments exactly as before.

### `SYNARA_CUA_CAPTURE_REUSE` (added with this change)

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
read-back case the spec calls out (`unconfirmed` keeps the settle).

Still open per the spec's acceptance criteria:

- **Live before/after numbers.** The budget table needs measured p50/p95 per
  operation on a real host; nothing here is a substitute for that evidence.
- **Scroll probe-leg settle.** The spec's recommendation ("only when measured
  travel already proves arrival") is not implemented; scroll legs keep the
  configured settle.
- **JPEG quality/size review (step 7).** No capture size or quality changed;
  the 1536 px budget stands because the last shrink cost aim precision.
- **App-launch prefetch.** Deliberately rejected by the spec: warm covers the
  driver only.
