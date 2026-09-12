# Linux computer-use audit

Date: 2026-09-12

Reviewed the Hyprland and KWin backends, native plugins, accessibility helper, provisioning, desktop leases, permission checks, and WebSocket input handlers. Findings below come from code inspection and isolated regression tests. No live desktop input, package installation, compositor restart, or plugin reload was performed.

## Fixes

| Area                          | Failure                                                                                                                                                  | Change                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hyprland emergency release    | Capture continued after Meta+Shift+Esc latched the user release.                                                                                         | Both capture methods now enforce the same release guard as session startup.                                                                                     |
| Hyprland input                | NaN and infinite pointer coordinates or scroll deltas could reach compositor input code.                                                                 | Invalid values are rejected before focus or input changes.                                                                                                      |
| Accessibility helper restart  | Late replies from an old process could resolve a new process's request because request IDs restart. Late process errors could tear down the replacement. | Output and errors are accepted only from the current helper.                                                                                                    |
| Accessibility helper shutdown | A timed-out helper received SIGTERM without escalation. Errors on idle or retired streams could crash the server.                                        | Failed and disposed helpers share bounded termination. Persistent stream error handlers contain errors without disturbing replacement helpers.                  |
| Cancellation                  | A semantic write cancelled during helper restart could still be sent. Pointer actions could continue after cancellation.                                 | Recheck cancellation after helper startup and before pointer movement, button presses, scroll dispatch, and retried key presses. Release events remain allowed. |
| Capture subscriptions         | Overlapping attachments could orphan a capture timer. A late attachment could undo a detach.                                                             | Each attachment has a generation checked after connection and capture; detach invalidates pending attachments and frames.                                       |
| KWin login script             | Paths containing shell metacharacters were interpolated into executable login code.                                                                      | Quote the path as a literal shell value. A shell regression verifies that sourcing it twice preserves the path without executing substitutions.                 |
| Prebuilt plugin manifests     | Hyprland accepted malformed entries, invalid hashes, and paths outside the prebuilt directory.                                                           | Both backends share filename and checksum validation. Invalid entries are discarded before selection.                                                           |
| Desktop lease cleanup         | A compositor error during release left a completed thread owning the desktop.                                                                            | Clear and publish local ownership even when focus cleanup fails. A new owner still must successfully clear compositor focus before sending input.               |
| Hover approval                | Cursor movement was exempt from approval although Linux can raise a target window and deliver hover input.                                               | Cursor movement follows the action approval path.                                                                                                               |
| Pointer modifiers             | WebSocket handlers dropped modifiers, and Linux backends silently performed unmodified clicks and scrolls.                                               | Forward modifiers through the handlers and manager. Linux explicitly refuses unsupported modified pointer input.                                                |
| KWin held buttons             | Leaving the target window could discard the surface before sending its pending button releases.                                                          | Release buttons before clearing pointer delivery.                                                                                                               |

## Remaining findings

These need separate compositor or provisioning integration work. They were not exercised against a live desktop.

1. **High priority: KWin input can reach the wrong window when an application shares input resources across windows.** `directPointerEnter` caches the last agent surface, but human pointer entry into another window of the same Wayland client changes the client's actual pointer target. The next agent action can reuse the stale entry. Keyboard injection reasserts the agent target but does not restore the human's sibling window. Hyprland already has focus invalidation and handback logic that provides a reference. Porting it needs tests with real shared-client windows, popups, held keys, and concurrent human input. See [KWin input delivery](../apps/server/native/computer-use-kwin/synaracomputeruseplugin.cpp) and [Hyprland input delivery](../apps/server/native/computer-use-hyprland/synarahyprlandplugin.cpp).

2. **High priority: screen-lock isolation is not established.** Neither native plugin checks the compositor's lock state around direct input or offscreen capture. These paths bypass ordinary compositor input routing. Define the intended behavior while locked, then cover capture admission, input, held-state cleanup, and KWin's asynchronous capture completion. A check at request entry alone would not cover a lock occurring during capture.

3. **Package manager selection can choose a non-native manager.** [planSystemPackageInstall](../apps/server/src/computer/provisioning/systemPackages.ts) selects the first installed executable in a fixed order. A host with multiple package managers can therefore run the wrong installer. A replacement should use the host distribution and define derivative and unknown-distribution behavior, with representative installation tests.

4. **The manual KWin installer gives incomplete first-install recovery advice.** [install-and-load.sh](../apps/server/native/computer-use-kwin/scripts/install-and-load.sh) recommends logging out when the plugin directory is invisible, but does not create the Plasma `QT_PLUGIN_PATH` login script. Logging out alone cannot establish that missing configuration. The application provisioner does create the script. The two installation paths should share the setup behavior or the manual path should document the required environment setup explicitly.

5. **Nested KWin cannot automatically repair some incompatible installed plugins.** [bootSession](../apps/server/src/computer/nestedComputerBackend.ts) provisions only when no plugin is installed. An incompatible existing plugin can fail nested startup before the base backend reaches its load-refusal repair. Recovery should rebuild only after an identified compatibility failure, preserving cleanup and avoiding automatic installation loops. Explicit Set up remains the recovery path.

Modified pointer input is now refused on Linux. Implementing modifier support still requires validation of keyboard focus and release behavior across native input paths.

## Validation

Regression coverage exercises helper replacement and stream errors, cancellation, stream attachment races, shell quoting, malformed manifests, failed lease cleanup, hover approval, modifier forwarding/refusal, and native release/input behavior. Native tests compile production functions against isolated fixtures; they do not establish full compositor compatibility.

- `bun fmt`, `bun lint`, and `bun typecheck` passed. Lint and typecheck emitted warnings or suggestions without failing.
- Computer-use and gateway Vitest suites passed 749 tests across 46 files. Eight opt-in integration tests were skipped, with live compositor and authentication-probe flags explicitly unset.
- Accessibility helper Python suite passed 13 tests.
- Hyprland isolated native suite passed three tests. KWin pointer cleanup suite passed one test.
- Mutation checks confirmed the native regressions fail if the capture guards or pre-clear button release are removed.
- `git diff --check` passed.
