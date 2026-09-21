# Multi-display certification

Synara computer use targets **windows**, and window bounds live in the
desktop-global logical coordinate space — a display arranged left or above the
main display gives its windows negative `x`/`y`. Every action the agent takes
is either window-scoped (exact `element_token` / `window_id` addressing) or
translated through window bounds, so the interesting question for a
two-display Mac is not "does the backend know about display 2" — it is whether
the whole chain (`list_windows` → `getState` → semantic/pointer action →
screenshot) is honest about geometry and admits actions on a window the
operator cannot see.

`multi-display-cert.ts` is the qualification script for that claim. It is a
checklist plus a semi-automated probe: automated rungs where a machine can
assert an answer, operator prompts where only a human hand can produce the
evidence (unplugging a panel, switching a Space), and a JSON report that
records each rung as `passed`, `failed`, `skipped`, or `refused` — never
silently absent.

> Status on this checkout: the harness typechecks and its single-display
> refusal path is exercised on the development VM (exit 3, report written).
> The two-display rungs are **hardware-pending** — nothing in this document
> claims a certified two-display run.

## Prerequisites

- A Mac with **two or more displays** in an extended (not mirrored)
  arrangement. With one display the script exits 3 after writing an
  enumeration-only report.
- **Accessibility** trust for whatever process runs the driver host (Terminal,
  or the spawned `cua-driver` when using `--driver`). Missing Accessibility is
  a hard refusal — no semantic actions can dispatch.
- **Screen Recording** trust for the same process for the screenshot rungs.
  Without it those rungs skip honestly rather than fail.
- `bun`, `clang`, and `swiftc` (Xcode CLT) for the helpers and fixture targets.

## Build

```sh
# Read-only display/Space/window→display inspector:
sh scripts/computer-use-fixtures/build-display-ctl.sh

# Focus sampler for the frontmost-preservation rung (also built automatically
# when missing at its default path):
sh scripts/computer-use-fixtures/build-focus-probe.sh
```

Both binaries land in `/private/tmp/synara-cua-implementation/` alongside the
compiled `native-fixture` targets, which the harness builds on demand with
`swiftc`.

## Run

```sh
# Against the bundled driver, spawned under your trusted terminal ancestry:
bun scripts/computer-use-fixtures/multi-display-cert.ts \
  --driver apps/desktop/resources/cua-driver/cua-driver

# Or attach to an already-trusted driver host (env vars work too:
# SYNARA_CUA_CERT_ENDPOINT / SYNARA_CUA_CERT_CAPABILITY):
bun scripts/computer-use-fixtures/multi-display-cert.ts \
  --endpoint /path/to/host.sock --capability <token>

# Real TextEdit windows instead of the synthetic fixture (weaker landing
# evidence — TextEdit cannot expose the in-process counter/field readbacks):
bun scripts/computer-use-fixtures/multi-display-cert.ts --targets textedit

# Include the operator phases (unplug/replug, per-display Spaces):
bun scripts/computer-use-fixtures/multi-display-cert.ts --interactive \
  --report /tmp/multi-display-cert.json
```

Full option list (`--help`): `--driver`, `--endpoint`, `--capability`,
`--targets fixture|textedit`, `--interactive`, `--report <path>`,
`--keep-targets`, `--display-ctl <path>`, `--focus-probe <path>` /
`--no-focus-probe`, `--fixture <path>`, `--max-displays <n>` (default 4).
Environment fallbacks: `SYNARA_CUA_DRIVER`, `SYNARA_CUA_CERT_ENDPOINT`,
`SYNARA_CUA_CERT_CAPABILITY`, `SYNARA_CUA_DISPLAY_CTL`,
`SYNARA_CUA_NATIVE_FIXTURE`.

Exit codes:

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | Every applicable rung passed                                  |
| 1    | Harness/environment error (driver unreachable, build failure) |
| 2    | One or more rungs failed, or the environment refused          |
| 3    | Fewer than two displays — `skipped-single-display` verdict    |

## What the rungs measure

The matrix is per-display: each certified display gets one target window and
one rung block (`displayIndex`, `displayUuid`, `windowId`, `cases[]`). Case
names in `report.rungs`:

| Case                  | Evidence asserted                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw-observation`     | Driver `get_window_state` fields the backend drops: `window_on_current_space`, `window_is_on_screen`, `current_space_id`, `window_space_ids` vs the display's own `currentSpaceId` from display-ctl.                                                |
| `on-current-space`    | The driver's Space gate agrees the display's active Space is current — a `false` here predicts pointer-input refusal and is recorded as failed.                                                                                                     |
| `backend-observation` | `getState` tree read, truncation flag, and the exact-window screenshot's `region`/`scale` (the global rect + px/point ratio the model actually sees).                                                                                               |
| `scale-match`         | Window PNG scale vs `display-ctl`'s two independent readings (`modeScale`, `backingScaleFactor`) of **that** display — the mixed-DPI canary.                                                                                                        |
| `background-click`    | Click at a display-local point (fixture: the counter button's activation point): converted to `window_points` with expected-bounds validation; landing verified against the fixture's in-process `mouseEvents`, frontmost pid sampled before/after. |
| `set-value`           | Semantic `set_value` of a marker string, read back twice — the fixture's own `text` and a fresh `getState` AX read — plus frontmost preservation.                                                                                                   |

Cross-display and run-level evidence in `report.crossDisplay` / `manualPhases`
/ `focusProbe` / `maskedShield`:

| Check                 | Evidence                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `concurrentSetValue`  | `set_value` into every display's window **at once**; all markers read back. The native semantic lease is per `(pid, window)` — writes on different windows must not serialize or refuse `native_input_busy`.       |
| `desktopState`        | `get_desktop_state` screenshot + `coverage[]` measuring which share of each display's bounds the overview rect actually covered (expected: the primary only — see below).                                          |
| `screenSize`          | `get_screen_size` vs the main display's `display-ctl` bounds (`matchesMainBounds`).                                                                                                                                |
| `windowDisplayAuth`   | `CGSCopyManagedDisplayForWindow` — the WindowServer's own window→display answer for every target, not bounds inference.                                                                                            |
| `disconnectReconnect` | **Interactive.** Operator unplugs/replugs; records removed/returned UUIDs, `uuidStableAcrossReconnect`, and where each surviving target's bounds migrated. Fails if the display set never changed.                 |
| `perDisplaySpaces`    | **Interactive.** Operator switches the secondary display to another Space; records `window_on_current_space`, `window_space_ids`, the pointer-click refusal code, and whether an exact semantic write still lands. |
| `maskedShield`        | Whether the protocol carries every datum a per-display masked-shield excursion would need (target frame, display rect, menu-bar state). Today: `not-implemented` — data available, excursion unbuilt.              |
| `focusProbe`          | The whole run under [focus-probe](focus-theft-probe.md): frontmost pid / key window / Space / typing focus never left baseline. Zero off-baseline samples = pass; thin coverage = `[thin]`, never fabricated.      |

## Known protocol limits (verified, not bugs)

The pinned `cua-driver` (see `packages/shared/src/cuaDriverRelease.json`)
exposes two intentionally **primary-only** surface APIs:

- `get_screen_size` returns `CGMainDisplayID()` logical size + scale.
- `get_desktop_state` captures the **main display only**; its structured
  output labels `"display": "primary"`.

Consequences the report records rather than hides:

- The model-visible overview screenshot shows the primary display. A window
  on a secondary display is still fully operable — but it is seen through its
  exact-window capture (`screencapture -l <wid>` / ScreenCaptureKit), not the
  overview.
- Bare desktop coordinates (`click` at an unscoped `x,y`) are validated by
  `ComputerManager.resolveCoordinatePoint()` against that primary extent and
  reject negative coordinates. Window-scoped actions are unaffected — they
  resolve through exact window bounds, which is the path the agent gateway
  uses for every element it targets.
- `screenshotPointToDesktop()` is global-space aware, so a secondary-display
  window capture maps model pixels back to the correct (possibly negative)
  global point.

## What remains hardware-pending

These cannot be certified on the development VM and need the run above on a
two-display Mac:

- Geometry/scale agreement between `display-ctl`, `list_windows`, and
  screenshot regions on a genuinely second panel — especially a **mixed-DPI**
  pair (e.g. built-in Retina + 1× external).
- Negative-origin correctness end-to-end (secondary display arranged left or
  above the main display).
- Unplug/replug mid-session: window list stability, bounds remapping, UUID
  return.
- Per-display Spaces: semantic writes landing while the target display shows
  a different Space than the operator's, and pointer refusal carrying
  `target_not_on_active_space`.
- Frontmost preservation while actions land exclusively on the non-operator
  display.

## Files

- `scripts/computer-use-fixtures/multi-display-cert.ts` — the harness.
- `scripts/computer-use-fixtures/display_ctl.m` + `build-display-ctl.sh` —
  read-only inspector: `list|json|count|front|window-display <wid>`. Uses
  public `CGDisplay*`/`NSScreen` APIs plus private SkyLight reads
  (`CGSCopyManagedDisplayForWindow`, `SLSCopyManagedDisplaySpaces`,
  `CGSManagedDisplayGetCurrentSpace`) for the authoritative window→display
  and per-display Space answers. Never posts an event or touches another
  process.
- `scripts/computer-use-fixtures/focus_probe.m` — see
  [focus-theft-probe.md](focus-theft-probe.md).
- `scripts/computer-use-fixtures/NativeFixture.swift` — the per-display
  target app: counter button + labelled text field, state served over
  stdin/stdout so a rung can verify an action's _effect_, not its dispatch.
- `scripts/tsconfig.certcheck.json` — typechecks the harness under the same
  strictness as the backend.

## Report shape

`--report` (default
`/private/tmp/synara-cua-implementation/multi-display-cert-<timestamp>.json`)
writes:

| Field            | Contents                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `probe`/`schema` | `"multi-display-cert"`, schema version 1.                                                                                        |
| `run`            | Timestamp, targets mode, interactive flag, host mode (`spawned`/`external`), driver path+sha256, pinned `cuaDriverRelease.json`. |
| `environment`    | arch, macOS version, full `display-ctl json` enumeration.                                                                        |
| `preflight`      | `check_permissions` result (accessibility / screen_recording).                                                                   |
| `targets`        | One row per certified display: window ids, pid, assigned display UUID.                                                           |
| `placement`      | Where each target actually landed vs its assigned display.                                                                       |
| `rungs`          | Per-display case blocks (table above), each `cases[]` entry `name`/`status`/`detail`.                                            |
| `crossDisplay`   | `concurrentSetValue`, `desktopState`, `screenSize`, `windowDisplayAuth`.                                                         |
| `maskedShield`   | Protocol-readiness rows for the unbuilt native shield.                                                                           |
| `manualPhases`   | `disconnectReconnect`, `perDisplaySpaces` (or their skip reasons).                                                               |
| `focusProbe`     | `meta`/`done`/exit code/full probe report.                                                                                       |
| `summary`        | `passed`/`failed`/`skipped`/`refused` counts + `verdict` (`passed`, `failed`, `skipped-single-display`, `error`).                |
| `error`          | Present only on harness failure (exit 1).                                                                                        |
