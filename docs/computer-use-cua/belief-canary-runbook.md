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

For each phase the app (a) focuses its own sentinel window, (b) runs the
helper stage when the phase has one, (c) sends `typeText("canary-<phase>")`
to its own background target window, then (d) reads the target field back two
ways: the Electron value and the driver's AX tree value. A phase passes only
when the Electron readback equals the exact typed string. The ladder stops at
the first passing phase. The report records every phase either way.

## Prerequisites

1. TCC Accessibility and Screen Recording granted to
   `~/Applications/Synara Cua Canary.app` (System Settings, the same flow as
   the fixture app). A rebuilt bundle changes the cdhash and needs the grant
   again; stale grants have to be removed and re-added.
2. An empty Space is available; the launch happens there. Never direct-exec
   the binary (`Contents/MacOS/Electron`): LaunchServices attribution matters.

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
open -n -W -a "$HOME/Applications/Synara Cua Canary.app" \
  --env SYNARA_CUA_CANARY_DIR=/private/tmp/synara-cua-implementation/canary-run-1
```

If the run pulls Kartik's Space or focus, kill it immediately
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
