# Belief canary runbook

How to run the focus-belief canary and read its result. The canary answers one
question: can synthetic focus-belief events make an Electron app accept
background semantic text insertion where rev 15 fails today with
`route: accessibility`, `effect: unverifiable`, `escalation delivery_failed`.

## Components

- Helper: `scripts/computer-use-fixtures/belief_probe.m` (compiled to
  `Synara Cua Canary.app/Contents/Resources/belief-probe`). Posts one candidate
  stage per invocation.
- App entry: `scripts/computer-use-fixtures/canary-main.ts` (bundled to
  `Contents/Resources/app/canary.cjs`). Runs the phase ladder against its own
  two windows and writes `report.json`.
- Runner: `scripts/computer-use-fixtures/belief-canary.mjs`.
- Staged app: `~/Applications/Synara Cua Canary.app` (ad-hoc signed, bundle id
  `com.synara.cua-canary`).

The helper posts these stages in order (each stage is one invocation):

| Stage | Name                   | Signal                                                                                |
| ----- | ---------------------- | ------------------------------------------------------------------------------------- |
| 1     | appkit-deactivate-prev | AppKit-defined type 13 subtype 2 to the previous front process                        |
| 2     | appkit-activate-target | AppKit-defined type 13 subtype 1, modifiers 0xC0000, to the target pid                |
| 3     | cps-taken              | Process-notification NSEvent type 21, subtype 0x4000                                  |
| 4     | cps-changed            | Process-notification NSEvent type 21, subtype 0xF102                                  |
| 5     | cps-newfront           | Process-notification NSEvent type 21, subtype 0x0002                                  |
| 6     | front-process-record   | `_SLPSSetFrontProcessWithOptions` + 248-byte focus record via `SLPSPostEventRecordTo` |

## Phase ladder in the app

For each phase the app (a) runs the helper stage when the phase has one,
(b) sends `typeText("canary-<phase>")` to its own background target window,
then (c) reads the target field back two ways: the Electron value and the
driver's AX tree value. A phase passes only when the Electron readback equals
the exact typed string. The ladder stops at the first passing phase. The
report records every phase either way.

The app never focuses its own sentinel — `BrowserWindow.focus()` activates
the app even under an `open -g` launch, which is the exact focus theft the
canary must not cause. `sentinelFocusedBefore`/`focusAfterType` record
whether any canary window held OS focus; the expectation is none ever does.

## Prerequisites

1. **TCC attribution — measured on this VM (2026-09-17).** The embedded
   `cua-driver` is a child of the canary process, so TCC attributes every
   permission to the host bundle `com.synara.cua-canary`. The ad-hoc staged
   bundle held no grants here: `check_permissions` returned
   `accessibility:false, screen_recording:false`, `get_window_state`
   answered with an EMPTY AX tree (`ax_window_unresolved`, all routes
   refused), and even `list_windows` titles arrived stripped (WindowServer
   removes `kCGWindowTitle` for a viewer without a capture grant). Without
   a manual grant the embedded mode cannot certify anything.
   Two ways forward:
   - Grant `com.synara.cua-canary` Accessibility + Screen Recording in
     System Settings (manual, once per cdhash), or
   - **External trusted driver (used for the 2026-09-17 certification):**
     host `CuaDriverHost` under an already-trusted ancestry (the operator
     terminal) and pass the canary
     `--env SYNARA_CUA_CANARY_ENDPOINT=<host.sock>` +
     `--env SYNARA_CUA_CANARY_CAPABILITY=<≥32-byte token>`. The semantic
     path is identical — the driver AXes into the canary's windows either
     way; only TCC provisioning differs. `report.driverMode` records
     `external` vs `embedded`. This mirrors production, where the driver
     is embedded inside the signed, granted Synara.app.
2. The launch is always `open -g -n -W -a`: `-g` suppresses activation, so
   the canary never becomes frontmost and never pulls the operator's Space.
   Never direct-exec the binary (`Contents/MacOS/Electron`): LaunchServices
   attribution matters.
3. Provenance quirk on this machine: a freshly built binary can be killed by
   Gatekeeper (`Killed: 9`) on exec until the file is rewritten once
   (`cat f > t && mv t f`). If a new build dies instantly, rewrite it first.

## Run

```sh
cd /Users/user/synara-computer-use
node scripts/computer-use-fixtures/build-canary.mjs          # canary build ok
node scripts/computer-use-fixtures/belief-canary.mjs --check # prereqs ok
node scripts/computer-use-fixtures/belief-canary.mjs --print # exact launch line
```

Launch through the printed line, or let the runner do it:

```sh
node scripts/computer-use-fixtures/belief-canary.mjs
```

For a run into a fresh evidence directory:

```sh
rm -rf /private/tmp/synara-cua-implementation/canary-run-1
open -g -n -W -a "$HOME/Applications/Synara Cua Canary.app" \
  --env SYNARA_CUA_CANARY_DIR=/private/tmp/synara-cua-implementation/canary-run-1
```

External trusted-driver run (what certified 2026-09-17): start a
`CuaDriverHost` under the operator terminal pointed at the staged rev-17
binary with a ≥32-byte capability, then launch with both env vars:

```sh
open -g -n -W -a "$HOME/Applications/Synara Cua Canary.app" \
  --env SYNARA_CUA_CANARY_DIR=/private/tmp/synara-cua-implementation/canary-run-1 \
  --env SYNARA_CUA_CANARY_ENDPOINT=<host-socket> \
  --env SYNARA_CUA_CANARY_CAPABILITY=<capability>
```

A correct run never steals focus or switches Spaces. If the run still pulls
Kartik's Space or focus, kill it immediately
(`pkill -f "Synara Cua Canary"`), record the alarm, and stop. Do not iterate
on his screen.

## Read the result

- `report.json.phases[]`: per phase `typed`, `electronReadback`, `axReadback`,
  helper exit code and helper JSON, and the type result.
- `report.summary`: the first passing phase name, or `none-passed`.
- Helper JSON per stage: `stages[].posted` tells whether the post call
  succeeded; `ok` is false when a stage reported an error.

Verdict rules: a passing `stage-n` names the signal that unlocks Electron
background typing. `none-passed` means belief-only is insufficient for this
app class and the ladder escalates (masked activation, per the sidecar spec).
A `none-passed` run is still a complete, evidence-backed result.

## Evidence locations

- Live run: `/private/tmp/synara-cua-implementation/canary-run-1/` (report.json
  plus helper-stage JSONs).
- Decision: `docs/computer-use-cua/belief-canary-2026-09-17.md`.

## Certification result (2026-09-17, external trusted driver)

`canary-run-9` and `canary-run-10` under `/private/tmp/synara-cua-implementation/`:

- `summary: baseline` — the background semantic write landed on the
  never-activated, unfocused target window without any belief priming.
- `typeText` returned `deliveryPath: cua-accessibility-background`,
  `effect: verified`, `verified: confirmed`; both the Electron in-process
  readback and the driver's AX-tree readback matched the exact typed string.
- Zero focus theft: `sentinelFocusedBefore: false`, `focusAfterType: null`,
  ghostty stayed frontmost for the whole run.
- The identity check matches `pid + exact bounds`, not title — titles are
  stripped for a viewer without a capture grant (see Prerequisites).

## Preflight status (2026-09-17, before the live run)

- Canary app staged and signed; bundle id `com.synara.cua-canary`; cdhash
  `dfedfa98487f8b17f3524a2bd2e7c06b09b14667`.
- TCC rows for `com.synara.cua-canary`: absent at staging time. The grant is a
  one-time manual step in System Settings (Kartik).
- Grant verification without launching: read
  `/Library/Application Support/com.apple.TCC/TCC.db` for
  `client='com.synara.cua-canary'`; both `kTCCServiceAccessibility` and
  `kTCCServiceScreenCapture` must exist with `auth_value = 2`. Only then launch.
  If the canary bundle reports `accessibility: false` after launching, quit the
  app, remove and re-add the entries in Settings (stale grant), and retry once.
- Build, `--check`, `--check-bundle` verified green before staging.
