# Masked activation feasibility — findings (2026-09-23)

Source: read-only spike against the pinned cua-driver source and this VM
(macOS 26.5.2, SIP on, arm64). Verdict: **buildable, but only the
own-window shield design is recommended; the foreign level-raise recipe is
the riskiest possible implementation on this box.**

## Symbol probe results (ctypes, this machine)

All required symbols resolve via `dlsym(RTLD_DEFAULT)`; CGS/SLS spellings
are aliases to the same addresses:

| Symbol                                                          | Status                   |
| --------------------------------------------------------------- | ------------------------ |
| `CGSGetWindowLevel` / `SLSGetWindowLevel`                       | resolves (same address)  |
| `CGSSetWindowLevel` / `SLSSetWindowLevel`                       | resolves (same address)  |
| `SLSSetWindowSubLevel`                                          | resolves                 |
| `CGSOrderWindow` / `SLSOrderWindow`                             | resolves (same address)  |
| `CGSOrderFrontConditionally`                                    | resolves                 |
| `SLSTransactionOrderWindowGroup`                                | resolves                 |
| `SLSMainConnectionID` / `CGSMainConnectionID`                   | resolves (same address)  |
| `SLPSSetFrontProcessWithOptions`                                | resolves (already used)  |
| `SLSOrderWindowWithActivation` / `CGSOrderWindowWithActivation` | **absent on this build** |

Resolution is not function: `space-management-findings.md` proved every
probed foreign-window mutation on this box silently no-ops or crashes
under SIP — `SLSMoveWindowsToManagedSpace`, `SLSSetWindowAlpha`,
`SLSMoveWindow`/`CGSSetWindowBounds` all failed unentitled. Whether
`CGSSetWindowLevel`/`CGSOrderWindow` on foreign windows sit inside the
same entitlement gate is unproven and needs a mutating operator-session
canary with read-back (SkyLight reports success while doing nothing).

## Terminology correction

The recipe's "level 25" is `kCGStatusWindowLevel` = 25, not
`kCGPopUpMenuWindowLevel` (which is 101). `kCGMainMenuWindowLevel` = 24.
Intent — above the menu bar, below popup menus — is served by 25; keep
the value, fix the name.

## Recipes compared

|                         | A. Foreign level-raise (Codex recipe)                                  | B. Own-window frozen shield                                                                     |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Foreign writes          | yes — likely SIP-gated                                                 | none                                                                                            |
| Hides window artifact   | yes                                                                    | yes (frozen pre-excursion pixels)                                                               |
| Hides menu-bar swap     | no                                                                     | yes (fullscreen/menu-bar-strip shield)                                                          |
| Cleanup on driver death | **user windows stuck at level 25** — needs out-of-process janitor      | self-cleaning (WindowServer tears down the connection's windows)                                |
| Precedent               | replica claims ~80ms; yabai uses SLS forms inside a privileged payload | `cursor/overlay.rs` already builds this window type; `orderWindow:relativeTo:` proven cross-app |

Recipe B is primary: public `NSWindow.setLevel`, existing ScreenCaptureKit
capture for frozen pixels, existing cross-app ordering. Its honest limits:
covered-region content freezes for the excursion (~200ms), and content
outside the mask rect stays visible. The existing cursor overlay is
deliberately `setLevel:0`/transparent/`IgnoresMouseEvents` — a mask window
reuses its construction at level ≥25 with opaque content.

## Masked sequence (inside the native excursion, one gate lease)

1. ADMIT — existing target_guard; refuse `mask_unavailable` if the flag is
   requested but masking cannot arm (never silently degrade to a visible
   excursion under a "masked" flag).
2. SNAPSHOT — prev PSN; layer-0 windows on the target's Space; [B] capture
   target-frame + menu-bar strip.
3. MASK UP — [B] present shield NSWindow(s) ≥25 ordered topmost; verify
   via CGWindowList; on failure unwind partial mask and refuse.
4. ACTIVATE — existing `set_front(psn,wid,0x400)` → `make_exact_window_key`
   → `await_window_focused`.
5. DELIVER — `check_target` → exactly one action; no replay.
6. RESTORE — `set_front(prev_psn,0,0x400)` direct (bypasses the gate, as
   today), then unmask LAST inside the `with_restoration` Drop guard.
7. VERIFY — front restored (or `restore-uncertain`), mask released,
   per-window misses named in structured output.

## Real limits masking cannot fix

- A real user keystroke during the ~100-500ms excursion still lands on the
  target — masking hides the visual cue of the theft, not the theft. The
  menu-bar flash is the user's only real-time cue today; any masked design
  must keep a disclosure surface (raise the agent cursor/badge to the
  mask level, keep `setSharingType` visible to recordings, emit a
  `masked`-delivery action event naming the app class and restore result).
- TS-side `readWindows` must never observe the mid-mask world — all mask
  state lives inside the serialized native call.
- Policy tension resolved: `workstream-f` prohibits "masking that hides
  activity from the user"; compliant masked delivery masks the activation
  _artifact_ while fully disclosing the _action_ (same category as
  `FocusStealPreventer` launch-activation suppression).

## Decision

Document now; build only behind a proven canary + per-app-class opt-in,
native-revision-gated (mask flag must make older drivers refuse, never
silently rung-change). Recipe B needs no new private APIs, no foreign
writes, no new TCC grants. Estimated medium complexity including
certification. Alternatives already shipping: `computer_browser_*` CDP for
Chromium-family and agent-launched Electron (the SIGUSR1 inspector path
does not enumerate renderer page targets on pre-existing Electron apps —
those remain masking's constituency).

## Implementation status (2026-09-23)

Recipe B shipped, canary-gated exactly as the decision above required:

- **Canary gate** — `SYNARA_CUA_MASKED_ACTIVATION` (off by default) plus
  `SYNARA_CUA_MASKED_APPS`, a per-app opt-in list of bundle identifiers
  (`apps/server/src/computer/computerShield.ts`). All three conditions —
  flag armed, macOS dialect, owning app's bundle id opted in — must hold
  before `foregroundWithRestore` arms a shield; anything less takes the
  ordinary visible path (`ComputerManager.engageActivationShield`).
- **Fail closed** — once the opt-in names the app, a shield that cannot
  engage refuses the activation rather than degrading to an unmasked raise.
  The manager mints the `shield_id`, so a lost engage reply still leaves a
  releasable handle; release runs inside `withoutDesktopCancellation` and
  the `finally` of the excursion, after the restore has landed.
- **Visible indication** — the shield is a Synara-owned non-activating
  `NSPanel` at `kCGStatusWindowLevel` (25), accent-bordered with a
  "Synara is activating \<app\>" pill, click-through on purpose: it
  discloses the excursion, it does not isolate input. `masked: true` rides
  the `computer.action` event as the durable disclosure record.
- **Self-cleaning** — the panels live in a dedicated `appsnap --shield`
  helper (`apps/desktop/native/appsnap/ActivationShield.swift`): parent-pid
  watch, stdin-EOF drop, 30 s per-shield TTL, Space/display-change release,
  and WindowServer removes its windows outright if the process dies. The
  desktop host (`apps/desktop/src/computerShield.ts`) adds engage
  confirmation, per-task attribution so `end_task` releases shields, and
  `stop`/`dispose` teardown; `release_all` is the ungated escape hatch in
  every host state.
- **Transport** — `{method:"shield"}` host requests are answered by the GUI
  host itself, never the driver, validated by `parseCuaShieldArgs` in
  `packages/shared/src/cuaDriverProtocol.ts`; the server side rides
  `ComputerBackend.engageShield`/`releaseShield`/`releaseAllShields`.

Recipe A (foreign level-raise) remains unbuilt: its entitlement gate is
unproven on this box and its stuck-window cleanup story is strictly worse.
