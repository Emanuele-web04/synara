# Upstream PR drafts — trycua/cua

Draft patches carved out of `apps/desktop/patches/cua-driver/0001-synara-native.patch`
(native revision 20, base `7fe7c33f` / cua-driver 0.28.2) for contribution
back to `trycua/cua`, per the phase-1 ordering in
[`../extraction-plan.md`](../extraction-plan.md): smallest standalone diffs
first.

**Gate:** every upstream send needs Synara-side maintainer review first
(extraction plan, "Policy" section). These files are review artifacts —
nothing here has been sent. Confirm upstream's CONTRIBUTING/CLA terms before
opening PRs; the filtered mirror carries neither file.

## Drafts

| Patch                          | Source rev | Upstream motivation                                                                           | Size      |
| ------------------------------ | ---------- | --------------------------------------------------------------------------------------------- | --------- |
| `pr-a-catch-unwind.patch`      | 9          | A panicking `cua-serve` thread leaves the main thread parked in the AppKit run loop forever.  | 19 lines  |
| `pr-b-keymap.patch`            | 19         | xdotool-style keypad / extended-function vocabulary for `key_name_to_code`.                   | 102 lines |
| `pr-c-host-pid-liveness.patch` | 8          | Second embedded liveness channel via `CUA_DRIVER_EMBEDDED_HOST_PID` (upstream's own env var). | 85 lines  |
| `pr-d-ax-batch-fetch.patch`    | 6+7        | One `AXUIElementCopyMultipleAttributeValues` IPC per element + bounded sibling fetch pool.    | 995 lines |
| `pr-e-wait-for-settle.patch`   | 18         | Read-only `wait_for_settle` tool + the AXObserver bindings it needs.                          | 686 lines |

Suggested send order: A → B → C → E → D (increasing size and review
burden — E before D because D is the heaviest review; A–C establish the
relationship on low-risk diffs).

**Not drafted — `select_text` (rev 20).** Unlike `wait_for_settle` it is a
_mutation_ tool: the Synara build rides the patch's own input-admission
gate, exact-target lease registry and stable-Space validation
(`background_mutation.rs`, `input/cancellation.rs`, `sdk_adapter.rs` lease
lists — none of which exist upstream). A faithful upstream port needs a
different admission design (most likely `pid_window_guarded` like
`set_value`), which is a design negotiation, not a mechanical extraction.
Parked until A–E land; revisit as a Phase-2 design discussion with
upstream rather than a straight port.

## Verification status (2026-10-07)

Each patch was produced by editing a clean worktree of the pinned upstream
tree (`/Users/devin/repos/cua-src` @ `d2c9c685a`, tree = patch base
`7fe7c33f`), not by slicing hunk text — so each applies standalone:

- `git apply --check`: all five apply cleanly against the pinned base.
- `cargo check`: `-p cua-driver -p platform-macos` clean with A+B+C applied
  (one pre-existing upstream `dead_code` warning in `cua-driver-sdk`);
  `-p platform-macos -p cua-driver-core -p cua-driver-contract` clean with
  E applied; `-p platform-macos` clean with D applied.
- `cargo test -p platform-macos`: `extended_keymap_names_resolve_*` passes
  (B); `ax::tree` tests pass with D (the live-AX prefetch benchmark stays
  `#[ignore]`d — it needs a real application target); all six
  `wait_for_settle` unit tests pass with E.
- `cargo test -p cua-driver-core capability`: 37/37 pass with E — the
  canonical-vocabulary and reviewed-risk suites cover the new
  `accessibility.settle` claim end-to-end.
- E drops the two `input::cancellation::gate()` checks and the `cancelled`
  outcome field: upstream has no input-admission gate or generation retire,
  so the wait bounds by `timeout_ms`/`quiet_ms` only. The observer
  teardown path is unchanged.
- Patches were built against the pinned 0.28.2 base. Upstream `main` will
  have moved; expect a rebase pass at send time (context lines are
  stable regions — keymap match arms, `main()` spawn block, serve
  `parent_liveness`, AX walk — so conflicts should be small).

## Per-draft PR text

### A — `fix(serve): exit the process when the cua-serve thread panics`

On macOS the `cua-serve` thread runs the socket loop while the main thread
parks in the AppKit run loop. If `run_serve_cmd` panics, the unwind kills the
serve thread but `exit(0)` never runs: the process stays alive forever with a
dead serve loop, a still-bound socket path, and a live cursor overlay — an
immortal orphan that responds to nothing.

Wrap the call in `catch_unwind` so `exit(0)` runs on every path. The panic
message still reaches stderr via the default panic hook.

### B — `feat(macos): accept xdotool-style keypad and extended-function key names`

`key_name_to_code` only covers the ANSI laptop set, so hosts that speak
xdotool vocabulary (`kp_5`, `kp_enter`, `f13`, …) get `unknown_key_name` for
keys macOS can actually deliver. This adds the PC editing-cluster and ANSI
keypad names plus `f13`–`f20`, `help`, and `menu`, all mapped to Apple's
documented `kVK_*` codes (HIToolbox `Events.h`), with aliases
(`keypad_enter`, `numlock`, `page_up`, `pgdn`, `prior`, …) matching the
spellings xdotool and Linux tooling use.

`insert`/`ins` stays unmapped on purpose: PC Insert maps to the macOS Help
key (kVK_Help = 114), which is exposed as `help` — naming it `insert` would
promise Insert semantics macOS doesn't have. Keypad navigation names with no
macOS keycode (`kp_home`, `kp_begin`, `kp_f1`–`f4`, …) are documented as
unmapped in the comment.

Includes a unit test pinning every added name to its virtual keycode.

### C — `fix(serve): reap embedded daemons whose host pid is gone`

The stdin-EOF liveness channel can be defeated: a leaked duplicate of the
lifetime fd (a child that inherited the pipe) holds the channel open past
host death, leaving an orphaned serve process running forever.

`CUA_DRIVER_EMBEDDED_HOST_PID` already exists — upstream uses it to
authorize named-pipe peers on Windows. This adds a second, independent
liveness channel that polls it with `kill(pid, 0)` on unix: ESRCH means the
host is gone and the daemon shuts down; EPERM still counts as alive. When
the env var is absent (non-embedded launches) the channel pends forever and
lifetime rules are unchanged. The two channels race under `tokio::select!`,
so stdin EOF stays the fast path.

### D — `perf(macos): batch AX attribute fetches and overlap sibling IPC`

Every `AXUIElementCopyAttributeValue` is a ~1.5 ms IPC round trip into the
target process, and the tree walk issues ~16 of them per element, serially.
Two changes, one invariant — rendered output is identical to the serial
walk:

1. **Batch the reads.** `AXUIElementCopyMultipleAttributeValues` fetches all
   sixteen attributes in one IPC call. Per-attribute failures land as
   `kAXValueAXErrorType` markers or `kCFNull` in their slots and decode to
   the same `None`/empty the per-attribute helpers produce, so a dead or
   unresponsive element degrades identically instead of aborting the walk.
   Elements that don't serve `AXActionNames` through the attribute API
   (most AppKit elements) keep the dedicated `AXUIElementCopyActionNames`
   fallback.

2. **Overlap siblings.** The AX server serializes requests _per element_
   but serves different elements concurrently, so a bounded 4-worker pool
   prefetches each siblings array's attribute batches while all ordering,
   dedup, budget, and truncation decisions stay on the walk thread in the
   exact serial sequence. Workers never share an element; a decode panic is
   caught per job and the slot falls back to an inline fetch on the walk
   thread, so no panic can strand the collector. `CUA_AX_SERIAL_FETCH=1`
   restores the serial path for A/B timing and diagnosis.

Live-verified in Synara's cert harness against real AppKit and Chromium
targets (tree output byte-identical to serial; ~4× walk speedup on
Electron-class apps). The `parallel_prefetch_matches_serial_output_and_times_it`
test compares serial vs pooled output against a live target and stays
`#[ignore]`d for CI.

### E — `feat(macos): add wait_for_settle — read-only AX surface settle observation`

After a mutation, hosts currently poll `get_window_state` on a timer and
guess when the UI has finished reacting. This adds a purpose-built
observation tool: an `AXObserver` bound to the target pid's application
element (or, when `window_id` scopes it, that exact AX window) subscribes
to the six change notifications that are actually posted —
`AXUIElementDestroyed`, `AXCreated`, `AXValueChanged`, `AXLayoutChanged`,
`AXFocusedUIElementChanged`, `AXElementBusyChanged` — and resolves
`{settled:true}` once the surface has been silent for `quiet_ms`
(default 1000, cap 5000) or reports `{settled:false}` with the observed
event count at `timeout_ms` (default 5000, cap 30000).

The tool performs no input and takes no mutation lease. Names the target
does not post are declined individually and reported under
`declined_notifications` rather than failing the call; teardown removes
the run-loop source and every registered notification and releases all
CF objects on every path. Bounded sessions authorize it through the
existing `private_observation` resource — `window_id` narrows to the
window, `pid` alone is application-scope observation.

This also adds the `AXObserver` bindings the tool needs (opaque type,
callback signature, `AXObserverCreate`/`AddNotification`/
`RemoveNotification`/`GetRunLoopSource` and the two notification error
codes) — no other code path uses them yet.

Six unit tests cover arg clamping/refusals, notification coverage, and
the read-only registration; the capability/canonical-vocabulary suites
cover the new `accessibility.settle` claim.
