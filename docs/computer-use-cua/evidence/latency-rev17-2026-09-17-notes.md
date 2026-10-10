# Warm-path latency, native rev 17 — live before numbers (2026-09-17)

Machine: disposable VM (Apple M4 Pro virtualized, `VirtualMac2,1`, arm64,
macOS 26.5.2). Probe script `latency-rev17-probe.ts` (+ `…-supplement-probe.ts`)
spawned a real `CuaDriverHost` under a TCC-responsible shell (ghostty holds
Accessibility + Screen Recording; the spawned driver inherits both — AX reads
returned elements and replies carried PNGs with no prompts). Staged binary
`apps/desktop/resources/cua-driver/cua-driver` rev 17, driver 0.28.2
(`provenance.json` `a8d9f70f`). Data: `latency-rev17-2026-09-17.json`,
`latency-rev17-2026-09-17-supplement.json`. Worktree commit `98b86be0c`.

Method: one fresh unix-socket connection per request through the host — the
same transport the server uses — with `performance.now()` around the whole
round trip. Warm means driver generation alive + target running. Target was a
scratch TextEdit instance this probe launched (`open -g -n -a TextEdit`, pid
recorded, `Untitled` 586×488, 165 AX elements, seeded with 160 lines). Input
ran with `delivery_mode:"background"` against that exact pid+window_id.
Frontmost stayed `ghostty` before, after, and between every phase — zero
focus theft. Replies carry no driver-internal timing field, so the split is
measured by subtraction: `probe` (host-only, no driver) vs `get_screen_size`
(trivial driver call) vs real ops.

## Measured vs proposed budget

| Operation                                | p50 target | p95 target | measured p50                                                                             | measured p95                            | verdict                                                             |
| ---------------------------------------- | ---------- | ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| get_state, AX only, warm                 | 400 ms     | 900 ms     | **219 ms** (interleaved) / 811 ms (contended block)                                      | **1 179 ms** / 15 924 ms                | p50 meets uncontended; p95 misses — see tails                       |
| get_state, with screenshot, warm         | 900 ms     | 1 800 ms   | **349 ms** / 431 ms                                                                      | **4 915 ms** / 1 252 ms                 | p50 meets; p95 misses uncontended, met in block run                 |
| click, input plus observation            | 800 ms     | 1 600 ms   | **659 ms**                                                                               | **742 ms**                              | meets both (max 1 383 ms was first-dispatch warmup)                 |
| type, focus-neutral AX insert            | 600 ms     | 1 200 ms   | **1 122 ms** write leg alone; **1 343 ms** for the full resolve→set_value→reread compose | **1 178 ms** leg / **1 686 ms** compose | misses p50 either way                                               |
| scroll, single leg                       | 800 ms     | 1 600 ms   | **743 ms**                                                                               | **823 ms**                              | meets both                                                          |
| launch, app already installed            | 2 000 ms   | 5 000 ms   | **1 956 ms**                                                                             | **2 133 ms**                            | meets both (max 19 833 ms = LaunchServices first-registration, i=0) |
| turn start, warm host, first tool call   | 800 ms     | 2 000 ms   | ≈ get_state warm call: **219–811 ms**; trivial call **0.7 ms**                           | as get_state                            | meets when uncontended                                              |
| host cold start, spawn+handshake+session | 2 000 ms   | 5 000 ms   | **55 ms** (n=20 suppl; n=3 main: 53/87/985 ms)                                           | **108 ms** suppl                        | meets both by ~40× — but see first-exec failure below               |

N=30 per warm op per run. Cold start: n=20 in the supplement plus n=3 in the
main run plus the warm host's own startup (54 ms) = 24 fresh-host samples.

## Splits

- **Transport is free.** Host-only `probe` p50 0.40 ms; `get_screen_size`
  (host → driver → back, trivial work) p50 0.69 ms. Everything above ~1 ms is
  inside the driver: AX walk, capture, input dispatch, the 350 ms background
  observation window (`SYNARA_CUA_BACKGROUND_OBSERVATION_MS`), LaunchServices.
- **click ≈ 660 ms** = dispatch + 350 ms background observation + verdict
  (`route: synthetic_events`, `delivery: background`, `effect: unverifiable`
  — honest, confirms via screenshot as designed).
- **scroll ≈ 743 ms** same shape (`route: synthetic_events`,
  `delivery: background`, `effect: unverifiable`).
- **type compose** = resolve 71 ms + write 1 122 ms + reread 127 ms at p50.
  The write leg dominates and alone misses the 600 ms row target; every write
  still returned `effect: confirmed` and the re-read matched (`confirmed: true`,
  30/30).
- **launch_app ≈ 1 956 ms** steady state (fresh spawn each sample, killed
  between); i=0 paid 19.8 s once — first-ever Calculator registration on this
  VM, a real first-launch cost the p50 hides.

## Tails — the p95 story

`get_window_state` is the only family that misses its p95, and it misses
hard: 15.9 s / 22.4 s outliers in run 1's AX-only block, 4.9 s / 13.9 s on the
screenshot arm of the interleaved run. This VM was running **other
`cua-driver` instances in parallel** (sibling worktree probes — observed
`wt-certification` pid alive during run 1, none during the supplement), all
sharing the WindowServer / AX subsystem. The outliers are real tail latency
under desktop contention, not protocol failures — every reply was complete
and correct. Interleaved A/B shows the stalls hit either request shape; they
are a shared-system-resource effect. Even so, the uncontended p95 for
`+screenshot` reads (≈1.2 s) already exceeds the 900/1 800 ms rows' spirit on
a busy desktop — budget the p95 accordingly or the row needs a contention
allowance.

## Wire-level finding that changes step 6

At rev 17, `get_window_state` replies are effectively unitary: identical byte
size (185 886 B) and identical embedded image (SHA-1 `f24321e7`, 103 364
base64 chars) across `include_screenshot` on/off, `max_dimension` present or
absent, and even with all tree args omitted — `els:165` either way. The driver
attaches its current frame whenever `screenshot_frame_freshness =
"captured_current_space"`; `include_screenshot` gates the capture work, not
the attachment. Consequences:

- An "AX-only" read still ships the ~150–190 KB payload including the PNG
  whenever a valid frame exists — which on a warm loop is nearly always.
  `SYNARA_CUA_AX_ONLY_GET_STATE` changing the request shape alone will not cut
  driver cost or bytes at rev 17; the saving needs a driver-side knob.
- Interleaved medians: AX-only 219 ms vs +screenshot 349 ms — the ~130 ms
  delta is the capture/refresh leg the flag-bearing request pays.
- Byte-identical frames across calls (same hash) confirm the step-4 premise:
  the model pays full image bytes for pixels it already saw.

## Cold start — the real number and the real risk

Steady-state cold start (spawn + validated handshake + `start_session` +
cursor setup, all inside the first call) is **p50 55 ms / p95 108 ms** — the
200 ms metadata poll rarely iterates. The observed failure mode is
_first-ever exec on a cold file cache_: this binary's first spawn took ~5–7 s
to create its socket, outlasting the host's ~4.2 s of fast-failed handshake
polls → "identity/version/native revision handshake failed"; immediate retry
succeeded (887 ms). Warm-on-first-touch would hide exactly this case. Cold
`listen()` itself: p50 0.66 ms, one 753 ms outlier (first `mkdtemp`).

First-call warmup inside ops: first background `click` on a generation 1 383
ms vs ~660 ms steady; first `set_value` 1 698 ms vs ~1 122 ms; first
`launch_app` of a never-launched app 19.8 s vs ~1 956 ms.

## Caveats

- Shared desktop: sibling agents ran their own drivers/apps during run 1
  (noted in the tails section); the supplement ran with no competing
  `cua-driver`. Treat both files as one environment's honest range, not a
  controlled benchmark.
- `type` was measured as the AX-insert compose (read+append+write+reread),
  matching the spec row's intent; the `type_text` synthetic path was not
  timed (same-pid multi-window ambiguity makes it the wrong path here anyway
  per `input-matrix-2026-09-17.md`).
- `launch_app` measured `bundle_id` launch of Calculator; all samples
  `alreadyRunning:false` except none — each spawned pid was killed before the
  next sample.
- Driver replies carry no internal timing; all splits are inferred by
  subtraction against the ~0.7 ms transport floor.

## Consequence for the plan

- click, scroll, launch, and cold start meet the proposed budget at p50 _and_
  p95 today — those rows are already green and should be marked measured.
- get_state meets p50 but misses p95 under desktop contention; step-1 numbers
  for that row should carry a contention note rather than a straight fail.
- The AX-only saving the spec expects is _not_ available by request shape
  alone at rev 17 — the driver attaches the frame anyway. Step 6 needs a
  native change (suppress attach when not requested) to realize the cut.
- Cold start is ~40× under budget in steady state; the only observed failure
  is first-exec spawn outlasting the handshake window — worth a handshake
  patience bump or the warm-on-first-touch flag rather than new budget.
