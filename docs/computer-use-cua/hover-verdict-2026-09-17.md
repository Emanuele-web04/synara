# Background hover verdict — macOS (2026-09-17)

**Question.** Can Synara deliver a real hover (`mouseMoved`) to a background,
non-Electron macOS app — enough for hover reveals and tooltips — without moving
the user's hardware pointer?

**Verdict: no.** The stamped pid-routed `mouseMoved` recipe does reach AppKit's
tracking pipeline, but only while the user's real cursor is already inside the
target window. Once the real cursor leaves, further synthetic moves are dropped
silently. There is no independent background hover through this delivery path,
so `computer_move_cursor` stays overlay-only and no `computer_hover` tool is
exposed. The only real hover remains the foreground one: warp the user's own
pointer, which `move_cursor` deliberately never does.

## Method

- Driver: `cua-driver` 0.28.2, `synara_native_revision` 16, embedded socket
  protocol (`serve --embedded`), long-lived host pid for liveness.
- Probe app: `/private/tmp/cua-hover/` — a minimal `NSApplication` window with
  a full-content `NSTrackingArea` (`.mouseEnteredAndExited`, `.mouseMoved`,
  `.activeAlways`) that logs every `mouseEntered`, `mouseMoved`, `mouseExited`
  with window-local coordinates to a file. Ground truth is the app's own
  event log, not pixels.
- Cross-check target: TextEdit (pid 566, window 35) — toolbar hover pixels and
  AX tooltip observation; inconclusive because tooltip UI does not enumerate in
  AX, so the custom probe carried the verdict.
- Recipe under test: `CGEvent` `mouseMoved` with `CGEventSetWindowLocation`
  plus the driver's stamp fields (40 target pid, 51 window id, 91/92
  window-under-pointer routing, 58/1/3/7 click and subtype fields), posted via
  `SLEventPostToPid` and via public `CGEvent.postToPid`.

## Results

| Scenario                                                         | AppKit log result                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Real HID move into probe window                                  | `mouseEntered`, then real `mouseMoved` at each position               |
| Stamped synthetic moves while real cursor **inside** the window  | Delivered — `mouseMoved` at each stamped local point                  |
| Stamped synthetic moves while real cursor **outside** the window | **Dropped** — no events logged, via `SLEventPostToPid` or `postToPid` |
| Fresh synthetic-only attempt, real cursor never inside           | No `mouseEntered` at all                                              |
| Synthetic move past the tracking edge while real cursor inside   | `mouseExited`; a later synthetic re-entry logged `mouseEntered`       |
| Target window **key** and app **active**, real cursor outside    | Still dropped (TextEdit frontmost case)                               |
| `move_cursor` (window scope) on TextEdit, real cursor elsewhere  | Overlay animates; no hover evidence; `effect: unverifiable`           |
| `move_cursor` `scope=desktop`                                    | Real pointer moved (`route: global_input`) — steals the cursor        |

The gate is the real pointer's position relative to the window, not app
activation or key-window state: TextEdit frontmost with its window key still
dropped posted moves while the real cursor was outside its frame.

## Why no hover tool ships

A hover that only works while the user's cursor already happens to be inside
the window is worse than no hover: it would inject phantom hover state at the
stamped coordinate, under the user's real cursor, exactly when the user is
there to see it. The spec'd `computer_hover` (post a real pointer move to the
exact window, pointer stays put) is not deliverable with the pid-routed recipe,
and `scope=desktop` delivers hover only by stealing the user's pointer, which
the tool contract forbids.

Revisit only if a new delivery mechanism appears — e.g. a WindowServer-level
pointer-window override — verified by the same real-cursor-outside test.

## Consequences already reflected in code

- `computer_move_cursor` description denies hover delivery and now states the
  mechanism plainly: macOS discards posted pointer moves unless the user's own
  cursor is inside the target window.
- `CuaComputerBackend.moveCursor` keeps `deliveryPath: "cua-overlay-only"`,
  `verified: "unverifiable"`.
- The web approval/transcript card says "Move the agent cursor", not "Move the
  cursor".
- `workstream-d-parity-spec.md` hover plan and acceptance criterion are marked
  blocked by this verdict.

## Evidence location

Probe sources and logs: `/private/tmp/cua-hover/` (`hover_probe*.swift`,
`hidmove.swift`, `observer.swift`, `windump.swift`, `hover-app.log`). These are
one-off diagnostics supporting the verdict, not a harness row; per Cua
harness policy they do not certify upstream behavior — they justify Synara not
exposing a capability it cannot verify.
