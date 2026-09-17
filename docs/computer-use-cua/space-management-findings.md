# macOS Space management — verified findings (SIP, arm64)

Environment: macOS 26.5.2 (build 25F84), arm64, SIP enabled, single display
`9D56AE12-E0EA-49ED-9273-DEDAEC174B00`, one user desktop Space (id 1, type 0).
All results produced by `scripts/computer-use-fixtures/space_ctl.m` plus
throwaway probes under `/tmp/space-probe/`; every mutation was checked with a
read-back because SkyLight routinely returns success while doing nothing.

## Bottom line

An unentitled process **cannot create an attached (managed) Space, cannot move
any window between Spaces — including windows it owns — and cannot switch the
active Space** on this OS build. The only mutations that actually take effect
are creating and destroying _orphan_ (type-3) Space objects, which are never
attached to a display, cannot host windows, and are not usable as an agent
Space. Every path to attached-space management — the legacy `SLS*` calls, the
`SLSTransaction*` API used by Dock, and the Objective-C `SLSBridged*Operation`
WindowManager bridge — resolves to the same entitlement/ownership gate inside
WindowServer.

## Verified command matrix (space-ctl)

| Command                                                       | Result                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `list` (`SLSCopyManagedDisplaySpaces`)                        | works — shows display UUID + attached Spaces (id, type)                                 |
| `all-spaces` (`SLSCopySpaces` mask `0xf` + `SLSSpaceGetType`) | works — lists every Space object incl. orphans                                          |
| `active-space` (`SLSGetActiveSpace`)                          | works                                                                                   |
| `windows` (`CGWindowListCopyWindowInfo`)                      | works                                                                                   |
| `window-spaces` (`SLSCopySpacesForWindows` mask `0x7`)        | works — reports per-window Space ids                                                    |
| `create-orphan` (`SLSSpaceCreate`)                            | works — returns a real id, `type=3`, `managed=0`                                        |
| `destroy` (`SLSSpaceDestroy`)                                 | works for orphans; refuses managed ids                                                  |
| `show` (`SLSShowSpaces`)                                      | **no-op** — orphan never becomes managed (`verified=0`)                                 |
| `move` / `add` / `remove`                                     | **no-op** — membership read-back never changes                                          |
| `set-current` (`SLSManagedDisplaySetCurrentSpace`)            | **no-op** — returns `rc=0` while `SLSGetActiveSpace` is unchanged; read-back catches it |

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

| Fallback                           | Outcome                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orphan type-3 Space                | created/destroyed fine, but can never host a window or become active — not usable                                                                                                                                                                                                                                   |
| Minimized window                   | raw **AX reads and writes still work** (a hidden/minimized TextEdit accepted `AXValue` writes), but the Synara driver **refuses** input: `input_window_info_by_id` (CGWindowList `kCGWindowListOptionIncludingWindow`, layer-0) no longer enumerates it → `stale_target`. Refusal is driver policy, not an OS gate. |
| `open -j` hidden app               | same — window reports `is_on_screen=False`, `space_ids=None`; driver refuses `stale_target`; raw AX still works                                                                                                                                                                                                     |
| Off-screen coordinates             | unreachable — macOS clamps AX window positions; CGS moves crash on foreign windows                                                                                                                                                                                                                                  |
| Zero alpha                         | `SLSSetWindowAlpha` returns 0, alpha stays 1 — silent no-op                                                                                                                                                                                                                                                         |
| Windows on another real user Space | driver's `semantic_only`/`StableMembership` policy is designed to keep exact-element input working there, but we could not verify end-to-end because a second attached Space cannot be created by an unentitled process                                                                                             |

## Recommended agent-Space isolation architecture

1. **Primary:** use an _existing_ managed Space that already belongs to the
   user/system (enumerate via `space-ctl list` / `all-spaces` where
   `managed=1`). If the environment provides a second desktop Space, exact
   windows there remain valid `semantic_only` driver targets under
   `StableMembership` — this is the only path that matches the "#3 core ask"
   semantics.
2. **Reality on a single-Space machine:** attached Spaces cannot be
   provisioned. Isolation has to come from _background_ input on the active
   Space (driver `delivery_mode:"background"` already avoids focus steal and
   was verified inserting text into an unfocused TextEdit), or from
   relaxing the driver's `stale_target` policy for AX-verified
   minimized/hidden windows — macOS itself permits that traffic; the refusal
   is the driver's exact-target invariant, which would need a compensating
   AX-ancestry identity check before it could be lifted safely.
3. **Do not** treat `create-orphan` spaces as agent Spaces: they are not in
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
