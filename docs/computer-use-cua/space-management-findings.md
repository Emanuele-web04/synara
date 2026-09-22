# macOS Space management — verified findings (SIP, arm64)

> Historical fixture experiments on their recorded OS and driver revisions.
> Synara currently exposes observed window membership only, not a complete
> Space inventory or create/switch/move/owned-Space tools. These experiments do
> not make an agent-owned workspace available in the product. See the
> [current platform boundaries](README.md#linux-and-spaces-boundaries).

Environment: macOS 26.5.2 (build 25F84), arm64, SIP enabled, single display
`9D56AE12-E0EA-49ED-9273-DEDAEC174B00`, one user desktop Space (id 1, type 0).
All results produced by `scripts/computer-use-fixtures/space_ctl.m` plus
throwaway probes under `/tmp/space-probe/`; every mutation was checked with a
read-back because SkyLight routinely returns success while doing nothing.

## Bottom line

An unentitled process **cannot create an attached (managed) Space, cannot move
any window between Spaces — including windows it owns — and cannot switch the
active Space** _via SkyLight_ on this OS build. Every direct path — the legacy
`SLS*` calls, the `SLSTransaction*` API used by Dock, and the Objective-C
`SLSBridged*Operation` WindowManager bridge — resolves to the same
entitlement/ownership gate inside WindowServer. Creating/destroying _orphan_
(type-3) Space objects works but is useless (never attached, cannot host
windows).

**2026-10-02 update — the Mission Control path works.** Dock owns the entitled
connection, and its Mission Control UI is fully AX-exposed, so AXPress on Dock
elements performs real space management on Dock's entitlement:

| Operation                             | Path                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create a managed desktop Space        | `AXPress` on Dock `button "add desktop"` of `group "Spaces Bar"` inside `group "Mission Control"`              | **works** — produced `space 62 type=0` (verified via `space-ctl list`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Switch active Space                   | `AXPress` on a `button` of `list 1` of `group "Spaces Bar"` (one button per space: "Desktop 1", "TextEdit", …) | **works** — `active space 1 → 53` verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Switch active Space                   | activate an app whose windows live on the target space (`set frontmost` / `activate`)                          | **works** — macOS switches to that space automatically                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Create a fullscreen Space             | `AXFullScreen` write on a resizable window                                                                     | works — `space 53 type=4` (Calculator refused silently; TextEdit accepted)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Switch via posted Ctrl+Arrow CGEvent  | `cghidEventTap` key events                                                                                     | **no-op** — WindowServer ignores synthetic keys for space switching                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Move a window between Spaces          | CGEvent drag on MC window thumbnails                                                                           | unproven — drop not accepted in our run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Direct input into an off-Space window | element-token `set_value` via driver                                                                           | **state-dependent — verified working when warm** — a window launched onto Space 62 while it was briefly active keeps a live AX tree after deactivation: `get_window_state` returned 50+ elements and `set_value` delivered `confirmed`/`value_readback` with independent read-back exact (live-cert `off-space-refusal`, rev 20). A long-idle app whose windows are ALL off-Space goes AX-empty (`AXWindows: []`) and the driver correctly refuses `ax_window_unresolved`. Warmth, not space-membership alone, decides reachability. |

Consequence: two tiers of cross-Space operation exist without entitlements.
**Warm off-Space writes work**: a window whose space was recently active keeps
its AX representation, and element-token semantic writes verify-deliver —
System Events cannot enumerate the same window, so the driver's own tree +
independent read-back is the evidence channel. **Cold off-Space targets** go
AX-empty; the workflow there is **switch → act → switch back**, also verified.

## Verified command matrix (space-ctl)

| Command                                                       | Result                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list` (`SLSCopyManagedDisplaySpaces`)                        | works — shows display UUID + attached Spaces (id, type)                                                                                                                                                      |
| `all-spaces` (`SLSCopySpaces` mask `0xf` + `SLSSpaceGetType`) | works — lists every Space object incl. orphans                                                                                                                                                               |
| `active-space` (`SLSGetActiveSpace`)                          | works                                                                                                                                                                                                        |
| `windows` (`CGWindowListCopyWindowInfo`)                      | works                                                                                                                                                                                                        |
| `window-spaces` (`SLSCopySpacesForWindows` mask `0x7`)        | works — reports per-window Space ids                                                                                                                                                                         |
| `create-orphan` (`SLSSpaceCreate`)                            | works — returns a real id, `type=3`, `managed=0`                                                                                                                                                             |
| `destroy` (`SLSSpaceDestroy`)                                 | works for orphans; refuses managed ids                                                                                                                                                                       |
| `show` (`SLSShowSpaces`)                                      | **no-op** — orphan never becomes managed (`verified=0`)                                                                                                                                                      |
| `move` / `add` / `remove`                                     | **no-op** — membership read-back never changes                                                                                                                                                               |
| `set-current` (`SLSManagedDisplaySetCurrentSpace`)            | **works on managed desktops** — 2026-10-02: switched active Space 1→62→1 with `SLSGetActiveSpace` read-back proving each hop; only no-ops on orphan/unmanaged ids (the earlier row measured the orphan path) |

## Exact ABIs used (SkyLight, resolved via `dlopen`/`dlsym`)

```c
int         CGSMainConnectionID(void);
CFArrayRef  SLSCopyManagedDisplaySpaces(int cid);
CFArrayRef  SLSCopySpaces(int cid, uint32_t mask);        // 0xf = all objects
uint64_t    SLSGetActiveSpace(int cid);
CFStringRef SLSCopyManagedDisplayForSpace(int cid, uint64_t sid);
CFArrayRef  SLSCopySpacesForWindows(int cid, int mask, CFArrayRef wids); // mask 0x7
uint64_t    SLSSpaceCreate(int cid, uint32_t flags, uint32_t ctx);       // flags 0x1
int         SLSSpaceDestroy(int cid, uint64_t sid);
int         SLSSpaceGetType(int cid, uint64_t sid);
void        SLSShowSpaces(int cid, CFArrayRef sids);       // 2 args exactly
void        SLSMoveWindowsToManagedSpace(int cid, CFArrayRef wids, uint64_t sid);
void        SLSAddWindowsToSpaces(int cid, CFArrayRef wids, CFArrayRef sids);
void        SLSRemoveWindowsFromSpaces(int cid, CFArrayRef wids, CFArrayRef sids);
int         SLSManagedDisplaySetCurrentSpace(int cid, CFStringRef displayUUID, uint64_t sid);
```

## What is blocked, and how we know

- **Attached-space creation.** `SLSSpaceCreate`/`CGSSpaceCreate` succeed for
  every flag combination probed (`0x1`, `0x10001`, `0x20001`, `0x40001`, …) but
  always return a **type-3 orphan**. `SLSShowSpaces` (2-argument form, plus
  run-loop pumping, plus reads from a second process to defeat per-connection
  cache staleness) never attaches it. `SLSManagedDisplaySetCurrentSpace` can
  return `0` while leaving the active Space unchanged.
- **Window moves.** `SLSMoveWindowsToManagedSpace`, `SLSAddWindowsToSpaces`,
  `SLSRemoveWindowsFromSpaces`, and `SLSSpaceAddWindowsAndRemoveFromSpaces` are
  silent no-ops for **foreign** windows (TextEdit wid stayed on Space 1) **and
  for a window owned by the helper itself** (a fresh AppKit `NSWindow` created
  in the probing process could not be moved to another Space either). The
  ownership boundary is not "your own windows" — it is "no windows at all" for
  an unentitled connection.
- **Transaction API** (`SLSTransactionCreate`, `…ShowSpace`,
  `…MoveWindowsToManagedSpace`, `…SetManagedDisplayCurrentSpace`,
  `…WillSwitchSpaces`, `…Commit`): commits fine, produces no attach/move.
  `…WillSwitchSpaces` takes an **array** of Space ids — passing a raw id
  crashes.
- **Objective-C bridge** (`SLSBridgedSpaceCreateOperation` etc.): real classes,
  but gated by the `WindowManagerBridgeOperations` feature flag, the
  `SLSEnableWMBridgedOperations` preference, and the
  `com.apple.private.skylight.windowmanager` entitlement. The flag is off on
  this machine, so `invokeFallback`/`performWithWMBridgeDelegate` drop to the
  same blocked legacy path.
- **Stubbed-out APIs** on this build (machine-code stubs, no-op or error
  `1006`): `SLSSpaceSetType`, `SLSSpaceGetCompatID`, `SLSSpaceSetCompatID`,
  `SLSSetWindowListWorkspace`, `SLSMoveWorkspaceWindowList`,
  `SLSMoveWorkspaceWindowListWithOptions`, `SLSReassociateWindowsSpacesByGeometry`.
- **Foreign-window geometry/alpha**: `SLSMoveWindow` and `CGSSetWindowBounds`
  on another process's window crash or no-op; `SLSSetWindowAlpha`/
  `SLSSetWindowOpacity` return `0` but the window's `kCGWindowAlpha` stays 1.
  AX `AXPosition` writes are clamped by macOS to keep part of the window on a
  display — fully off-screen positioning is not reachable.

Dock performs these operations because it holds
`com.apple.private.skylight.universal-owner`,
`com.apple.private.windowmanager`, and
`com.apple.private.SkyLight.displaycontrol`. That is the entitlement boundary.

## Isolation fallback results

| Fallback                           | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orphan type-3 Space                | created/destroyed fine, but can never host a window or become active — not usable                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Minimized window                   | **works at rev 20** — `input_window_info_by_id` falls back to the full layer-0 enumeration when the targeted query misses, so minimized windows resolve; live-verified 2026-10-02: `set_value` on a minimized TextEdit → `confirmed`/`value_readback`, `is_on_screen:false`.                                                                                                                                                                                                                                                                |
| `open -j`/`AXHidden` hidden app    | **works at rev 20** — same fallback path; live-verified: hidden TextEdit pid returned the full 37-element tree and accepted `set_value` → `confirmed`, `is_on_screen:false`.                                                                                                                                                                                                                                                                                                                                                                |
| Off-screen coordinates             | unreachable — macOS clamps AX window positions; CGS moves crash on foreign windows                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Zero alpha                         | `SLSSetWindowAlpha` returns 0, alpha stays 1 — silent no-op                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows on another real user Space | **verified 2026-10-02: AX-empty but enumerable** — off-Space windows DO appear in `CGWindowListCopyWindowInfo` and the driver's `list_windows` (real bounds, `visible:false`; verified with TextEdit pid 59260 wids 909/910 on Space 62 while active=1), but the app's AX hierarchy omits them (`get_state` returns window metadata only, no elements). Driver refuses `ax_window_unresolved`/`off_space_or_ax_unresolved` for element ops — correct. Cross-space requires switching first (`set-current` now verified on managed desktops) |

## Recommended agent-Space isolation architecture

1. **Provisioning (verified 2026-10-02):** an agent _can_ provision a dedicated
   managed desktop Space by driving Mission Control over AX (open MC → AXPress
   Dock's `add desktop` button → AXPress the new space's Spaces-Bar cell to
   enter it). No entitlement needed; Dock performs the mutation.
   **Caveat:** empty managed desktops are transient — the MC-created space `62`
   was reaped after the VM paused (only space `1` and fullscreen space `53`
   survived). Provision a Space only when a window will live on it, and
   re-check `space-ctl list` after any interruption; also note Dock exposes
   the Spaces Bar reliably only while MC is open — `AXShowMissionControl`
   returned `-25206` after the pause, and neither CGEvent nor System-Events
   Ctrl+Up reopened it on this VM, so MC-open is state-dependent, not a
   guaranteed primitive.
2. **Primary isolation model (verified 2026-10-02):** the agent works _on its
   own space_ — `set-current <agent-space>` → launch targets there (windows
   land on the active space with **no move API needed**; verified: TextEdit
   pid 59260 launched on Space 62, `window-spaces` reported `62`) →
   `set-current` back to the operator space. `SLSManagedDisplaySetCurrentSpace`
   is the fast programmatic switch (sub-second, no Mission Control UI, verified
   1→62→1), replacing the fragile MC-button path. Cross-space operation is
   `switch → act → switch back`, with the operator-view caveat that each hop
   flips the watched display for a moment — the masked-activation shield could
   cover the transition. The remaining gap is _unattended_ operation: any act
   requires the agent's space to be active at that instant.
3. **Off-Space input is impossible:** windows on inactive Spaces are absent
   from the app's AX hierarchy (`AXWindows: []`), so no semantic or event
   route exists. The driver's `ax_window_unresolved` refusal is correct —
   keep it; it prevents misgrounded writes. Background input applies to
   inactive _windows on the active space_, not inactive _spaces_.
4. **Hidden/minimized:** covered at rev 20 — the layer-0 fallback in
   `input_window_info_by_id` resolves hidden/minimized windows and AX writes
   were live-verified on both (`is_on_screen:false`, `value_readback`
   confirmed). The earlier `stale_target` refusal no longer applies.
5. **Do not** treat `create-orphan` spaces as agent Spaces: they are not in
   `SLSCopyManagedDisplaySpaces`, reject window membership, and cannot be
   made active. `space-ctl` reports `managed=0` for them deliberately.

## Build / reproduce

```sh
sh scripts/computer-use-fixtures/build-space-ctl.sh
/private/tmp/synara-cua-implementation/space-ctl list
/private/tmp/synara-cua-implementation/space-ctl all-spaces
/private/tmp/synara-cua-implementation/space-ctl create-orphan   # prints managed=0
/private/tmp/synara-cua-implementation/space-ctl move <sid> <wid>  # verified=0
```

Freshly built binaries may be Gatekeeper-killed (`exit 137`); copy to a new
inode (`cat bin > tmp && mv tmp bin && chmod +x bin`) before running.
