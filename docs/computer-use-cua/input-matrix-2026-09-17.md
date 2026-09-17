# Decisive input matrix — Electron/Chromium on macOS (VM-verified, 2026-09-17)

Ground truth = DOM read-back via `executeJavaScript` in a live probe app
(`Electron.app/Contents/MacOS/Electron probe-app`), driven through the pinned
`cua-driver` 0.28.2 native rev 15 embedded socket. "Background" = TextEdit held
the real front process; probe never frontmost unless stated.

## Results

| Need             | Driver call                                              | Route                                         | Landed?                | Operator front preserved   | Notes                                                                                                                                        |
| ---------------- | -------------------------------------------------------- | --------------------------------------------- | ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Set field text   | `set_value`                                              | `accessibility` (AXValue write)               | **YES**                | YES — front never moved    | `input` DOM event fires (`changes:1`); React/controlled inputs see it. Driver reports `effect:unverifiable` — read-back bug, write DID land. |
| Real keystroke   | `press_key` `delivery_mode=foreground`                   | `global_input` (short-lived activate+restore) | **YES**                | YES — restored to TextEdit | `lastkey:"a"` observed in renderer keydown.                                                                                                  |
| Type text        | `type_text` `delivery_mode=foreground`                   | `global_input`                                | **YES**                | YES — restored             | `delivered_count:2`, per-char keydowns. Driver escalates verify to `pixel`.                                                                  |
| Insert at cursor | `type_text` `semantic_only`                              | `accessibility` (AXSelectedText)              | **NO**                 | —                          | Even with app frontmost + DOM-focused field. Chromium does not honour AXSelectedText writes into web content.                                |
| Background keys  | `press_key` (background)                                 | process-scoped CGEvent                        | **NO**                 | —                          | Multi-window pid: `same_pid_keyboard_ambiguity` refusal (correct). Single-window inactive: silently dropped, `hasFocus:false`.               |
| Focus belief     | probe stages 1–5 (AppKit/CPS posts)                      | —                                             | no key window created  | —                          | front process unchanged; `focusedWindow` destroyed to null in some stages.                                                                   |
| Front flip       | stage 6 `_SLPSSetFrontProcessWithOptions` + focus record | —                                             | front process DID flip | n/a                        | Still no key window; renderer still received no keys.                                                                                        |

## Extended matrix — pointer/wheel (same probe, TextEdit frontmost throughout)

| Need                                 | Driver call                                                                 | Landed?                                                                    | Front preserved      |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------- |
| Click + DOM focus + mouseenter       | `click` `delivery_mode=foreground` (window_points + expected_window_bounds) | **YES** — `hover:1`, `active:true`                                         | YES (59966 TextEdit) |
| Wheel events                         | `scroll` `delivery_mode=foreground`                                         | **YES** — `wheel:3, dy:40` real DOM wheel                                  | YES                  |
| Scroll (background)                  | `scroll` background                                                         | refused `background_unavailable`                                           | —                    |
| Synthetic click (background)         | `click` background                                                          | refused without `expected_window_bounds`                                   | —                    |
| `CGEventPostToPid` mouseMoved/scroll | raw C probe                                                                 | **NO** — `move:0`, wheel unchanged                                         | —                    |
| `invoke_menu` (TextEdit)             | `path:["File"]`                                                             | opens menu; `["Edit","Undo"]` → refused `menu_path_unavailable` (disabled) | n/a                  |
| `set_window_frame` (TextEdit)        | x/y/w/h                                                                     | `effect:confirmed` + `value_readback`; independent `list_windows` agrees   | n/a                  |
| `list_apps`                          | no args                                                                     | 71 apps with running/active/pid/launch_path                                | n/a                  |
| `verify_state`                       | `expect:[element exists AXTextArea]`                                        | `satisfied` with observed evidence + stable samples                        | n/a                  |
| `zoom`                               | region                                                                      | 240×120 JPEG crop returned                                                 | n/a                  |

## Scroll reality — verified against the embedded daemon (rev 15)

| Target                      | Mode                   | Result                                                                                                                                                           |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TextEdit doc (non-Electron) | background             | **LANDS** — window-local wheel post; scrollbar thumb moved y:269→y:473; `delivery.mode:"background"`, `effect:unverifiable` (honest — confirm via screenshot/AX) |
| TextEdit doc                | bad window-local point | refused — `point lies outside window frame` (window-local coords enforced)                                                                                       |
| Electron probe              | background             | refused `background_unavailable` — upstream gate: `is_electron(pid)` refuses ALL background scroll paths (Chromium has no AX scrollbars; CGEvent dead)           |
| Electron probe              | foreground             | **LANDS** — real DOM wheel events (`wheel:3, dy:40`), front restored                                                                                             |

Upstream `scroll_wheel_at_xy(pid, screen_x, screen_y, window_local, wid, dy_per_tick, dx_per_tick, ticks)` already carries both axes plus the f51/f91/f92 window-routing stamps — the Electron refusal is policy, not mechanism. Synara-side behaviour: `CuaComputerBackend.scroll` honestly refuses `dx && dy` together (`unsupported_operation`, not-dispatched); diagonal scroll needs two sequential calls or a rev-16 two-axis arg.

## Conclusions

1. **Synthetic focus belief is empirically dead** for unlocking background
   keyboard input into Electron. Six stages, including a real front-process
   flip, cannot manufacture a usable key window. The Option-C "belief" premise
   does not survive contact with the hardware.

2. **Text insertion into Electron needs no belief at all**: `AXValue` writes
   land in the DOM, fire `input` events, and never touch the operator's front
   app. This single mechanism resolves the G5 three-window failure — the
   failing case routed to `type_text` semantic (AXSelectedText), the wrong tool.

3. **Real keystrokes are already solved by the driver**: `delivery_mode=
foreground` performs a short-lived front-process switch and restores the
   previous front app transparently. This is the "masked activation" rung —
   implemented natively, verified working, operator-invisible.

4. **Real input events on Electron exist in exactly one mode**:
   `delivery_mode=foreground`. Keys, clicks (with DOM focus + mouseenter),
   and wheel events all reach the renderer through the driver's short-lived
   front-process excursion, which restores the previous front app so fast the
   operator never sees it. Process-scoped `CGEventPostToPid` — keys, mouse
   moves, scrolls — is dead on an inactive app in every tested form. The honest
   model is therefore: **background = semantic AX writes; foreground delivery =
   real input events**, and the admission gate should keep refusing to pretend
   otherwise.

5. **Driver `effect:unverifiable` on landed `set_value`** is a read-back defect:
   the write is real (DOM proves it) but the driver's AX read-back misses it —
   likely stale snapshot/token or wrong attribute. Needs a patch fix so
   `verified` is reported truthfully; until then Synara must not treat
   `unverifiable` as failure for AXValue writes — it must re-read independently.

6. **Same-day addendum — pid-routed `mouseMoved` is gated on the real cursor on
   AppKit too.** Follow-up probing of a scratch AppKit app showed stamped
   `SLEventPostToPid`/`CGEventPostToPid` moves DO dispatch into
   `NSTrackingArea` handlers — but only while the user's real cursor is inside
   the target window. With the real cursor outside, they are dropped entirely,
   even with the target window key and its app active. So background hover is
   not deliverable on native apps either; `computer_move_cursor` stays
   overlay-only. Full record:
   `docs/computer-use-cua/hover-verdict-2026-09-17.md`.

## Revised architecture

- **Text:** route insert/type into web-content text fields through `set_value`
  (read current value, compose, write) or `type_text` foreground for real
  typing. Never `semantic_only` on Electron.
- **Keys:** `delivery_mode=foreground` for real key events; driver's admission
  gate already refuses ambiguous process-scoped delivery.
- **Sidecar:** repurpose to theft-sampling + per-agent cursor only. Belief
  stages removed — empirically disproven. Short-lived activation already lives
  in the driver.
- **Fixture:** three-window semantic-text case should route `set_value`; rerun
  to confirm G5 closes.

Evidence: probe app `/private/tmp/cua-exp/probe-app`, driver client
`/private/tmp/cua-exp/driverctl*.py`, DOM logs in `/private/tmp/cua-exp/out.ndjson`.

---

## Addendum: scroll v2, launch, and Space findings (2026-09-17, native rev 16)

Driver staged at rev 16, patch sha
`46f7a8cfbb51d18eb3eb91da88b488e5c42fc92bfa91a717dae3fadd43050ee0`, commit
`78bc88bae`.

### Scroll v2, verified live on TextEdit

| Need                                  | Result                                           | Notes                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background vertical scroll (TextEdit) | **LANDS both directions**; scrollbar thumb moved | Window-local pixel-wheel post; `effect:unverifiable` stays honest, confirm via screenshot/AX                                                                                     |
| Two-axis + modifier gesture           | **Dispatches as one event**                      | `delta_x`/`delta_y` signed ticks (±50 per axis) + `modifiers` → one PIXEL-unit `CGEvent` wheel stream with flags                                                                 |
| Pid-only scroll                       | **Refused closed**                               | Delta mode requires an element or window-local target; admission requires exact pid + window_id                                                                                  |
| Horizontal wheel delta (TextEdit)     | **Ignored by the app**                           | NSScrollView wants continuous trackpad deltas for horizontal travel; toolkit limitation, not a refusal                                                                           |
| Keystroke scroll path                 | **Unreachable under Synara admission**           | The driver's delta/modifier refusal on that path is defense-in-depth, not a live gate                                                                                            |
| Electron background scroll/type       | **Dead**                                         | Upstream refuses background scroll for Electron; process-scoped CGEvent never reaches an inactive renderer. The fix path is the `browser_*` CDP surface (in progress separately) |

macOS now joins the before/after measurement loop: a 48 px probe leg plus a
corrected remainder, at most two legs and three captures per request.
Learned travel is stored per window per route (`ax` vs `wheel`) and spills
into a durable per-app file (`computer-scroll-gearing.json` beside control
state, 64 entries, corrupt file degrades to gearing 1).

### Launch behavior (verified)

- `open -g -n -a` launches an app without stealing focus or switching the
  operator's Space. This is the correct silent-launch form.
- `open -n -a` steals focus. The fixture launch line that used it is a known
  bug; a fix is in flight separately.

### Space management: in progress, blocked at display-attach

Verified on this VM under SIP:

- `SLSSpaceCreate` produces orphaned type-3 spaces that `SLSShowSpaces` does
  not attach to any display, so created spaces are unreachable.
- `SLSMoveWindowsToManagedSpace`, `SLSAddWindowsToSpaces`,
  `SpaceAddWindowsAndRemoveFromSpaces`, and the compat-id trick are all
  silent no-ops on foreign windows under SIP.

Status: blocked at display-attach for creation; window moves are SIP-gated.
Neither "solved" nor "impossible" is proven; the ABI work continues.

---

## Background drag — verified (native rev 17, 2026-09-22)

Ground truth = a dedicated Cocoa `DragTarget` app (`NSTextView` + local
`NSEvent` monitor + selection-change logging) so no other agent could touch the
document. Driver = a 0.28.2 build reporting `synara_native_revision: 17`,
driven through the embedded socket. "Background" = `ghostty` held the real
front process for the entire run.

Revision note: the tested build's rev-17 stamp predates the release line's
rev 17, but the release patch (`388f1693`, commit `77bf7fa1a`) was later
regenerated from the same working checkout and **does** contain this drag
change alongside the hidden-workspace lifecycle — verified in the committed
patch's `drag.rs` hunks and in the staged binary. A driver without the patch
keeps answering `background_unavailable`, which Synara maps to
`not-dispatched`, so any older build still fails closed.

| Need                            | Driver call                                                         | Landed? | Front preserved                  |
| ------------------------------- | ------------------------------------------------------------------- | ------- | -------------------------------- |
| Select text in inactive window  | `drag` `delivery_mode=background` (window_points + expected bounds) | **YES** | YES — `ghostty` stayed frontmost |
| Same gesture, reverse direction | `drag` `delivery_mode=background`                                   | **YES** | YES                              |

The app logged the stamped window-local events arriving
(`EVT 5/1/2 win=371` = move/down/up) and the resulting selection changes:

```text
SEL loc=4 len=9 [BBBBCCCCD]
SEL loc=39 len=13 [jjkkkkllllmmm]
--- front ---
ghostty
```

The driver's result was `delivery:{mode:"background"}, effect:"unverifiable",
route:"synthetic_events"` — honest: the CGEvent drag is posted but the driver
cannot prove the drop landed, so the caller must verify from a fresh screenshot
or semantic read-back. `unverifiable` is not a failure signal here.

Safety envelope, enforced at both layers:

- Synara refuses before dispatch unless the target is an exact live
  `cua:<pid>:<window_id>`, observed geometry still matches, and both endpoints
  sit inside the window frame (`local()` rejects an endpoint that leaves the
  bounds).
- The driver repeats fresh WindowPointer admission (ownership, not
  minimized/hidden, current Space) immediately before posting, checks both
  window-local endpoints against the resolved frame, and takes the per-process
  background mutation lease. A driver that cannot admit the gesture answers a
  structured refusal (`effect:"refused"`), which Synara maps to
  `not-dispatched` — no replay, ever.

### Hover verdict — do not expose `computer_hover`

- Stamped background `mouseMoved` events do reach an inactive AppKit process —
  the monitor logged them and `hitTest` ran.
- View-level hover does **not** follow: with `acceptsMouseMovedEvents = true`
  and `NSTrackingArea` installed, no `mouseMoved`/tracking callback fired on
  the inactive window.
- On Electron, process-scoped `CGEventPostToPid` mouse movement is dead in
  every tested form (matrix row above).

Process-level arrival is not a hover contract. No `computer_hover` tool is
exposed; hover-dependent UI stays a foreground-delivery concern.

### Native delta

The tested patch removes upstream's unconditional `background_unavailable`
drag gate and mirrors the click path: `resolve_input_frame`, both-endpoint
bounds check, `gate_background_window_action(WindowPointer)` admission lease
acquired before cursor animation or dispatch, then the window-local stamped
CGEvent gesture. Foreground delivery is untouched and remains the explicit
fallback for surfaces that drop background events.
