# Focus-theft probe

The cert bar every handoff names — "prove zero focus steal" — is now a meter, not an eyeballed log. `focus-probe` samples the user's real focus state at a fixed rate while background actions run and reports every sample that leaves the baseline.

## The invariant

A background action is focus-neutral when none of these change because of us:

| Field        | Source                                                                           | Meaning                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pid`        | `NSWorkspace.frontmostApplication` (`_SLPSGetFrontProcess` fallback)             | The user's frontmost app.                                                                                                                                                              |
| `keyWin`     | AX `AXFocusedWindow` of the frontmost app → CGWindowID (`_AXUIElementGetWindow`) | The key window. Needs Accessibility trust.                                                                                                                                             |
| `topWin`     | `CGWindowListCopyWindowInfo`, topmost layer-0 window for the front pid           | Key-window proxy that needs no grant; sampled on a tick divisor.                                                                                                                       |
| `space`      | `SLSGetActiveSpace` (private SkyLight read, same pattern as space-ctl)           | The active managed Space.                                                                                                                                                              |
| `focusedPid` | System-wide `AXFocusedUIElement` owner pid                                       | Typing focus. Moves to another process (desktop, menu bar, agent target) while `pid` still reads the human's app — the `kCPSNotifyTypingFocusChanged` case. Needs Accessibility trust. |

`focused` (the full `pid:role:title` descriptor of the focused element) is recorded too, but a change inside the same owning pid is reported as `drift`, not theft: a human tabbing inside their own app is indistinguishable from an agent doing it. `--strict-focus` upgrades those to violations for runs that want the sharper claim.

A `null` field is an observation gap (missing grant, unsampled tick), never a theft. Fields whose baseline was never measured are skipped rather than fabricated.

## Files

- `scripts/computer-use-fixtures/focus_probe.m` — the sampler binary (read-only; never posts an event). Streams NDJSON: one `meta` line, one sample line per tick, one `done` line with cadence stats.
- `apps/desktop/src/cuaFixtures/focusProbe.ts` — parser + analyzer + `startFocusProbe()` session helper used by fixtures.
- `apps/desktop/src/cuaFixtures/focusProbe.test.ts` — analyzer unit tests (synthetic sample streams).
- `scripts/computer-use-fixtures/focus-probe.ts` — standalone CLI runner for cert runs.
- `scripts/computer-use-fixtures/build-focus-probe.sh` — clang build into `/private/tmp/synara-cua-implementation/focus-probe`.

## Standalone use

```sh
# Build once:
sh scripts/computer-use-fixtures/build-focus-probe.sh

# Sample for a fixed window:
bun scripts/computer-use-fixtures/focus-probe.ts --duration 30 --report run.json

# Or wrap the thing being certified — sampling stops when it exits:
bun scripts/computer-use-fixtures/focus-probe.ts --settle-ms 500 \
  --report run.json --samples-out samples.ndjson \
  --wrap -- ./my-cert-script.sh

# Pin the expected state instead of deriving it from the settle window:
bun scripts/computer-use-fixtures/focus-probe.ts --duration 30 \
  --expect-frontmost-pid 566 --expect-key-window 35
```

Exit codes: `0` = theft-free, `1` = usage error or too little coverage to make the claim, `2` = off-baseline samples detected.

## What "no theft" evidence looks like

`report.report` is the assertion payload:

```json
{
  "theftFree": true,
  "ok": true,
  "baseline": {
    "pid": 566,
    "keyWin": 35,
    "topWin": 35,
    "space": 1,
    "focusedPid": 566,
    "focused": "566:AXTextArea:First Text View"
  },
  "sampleCount": 1500,
  "measuredMs": 29880,
  "offBaseline": [],
  "offBaselineSamples": 0,
  "driftSamples": 0,
  "coverage": { "pid": 1, "keyWin": 1, "topWin": 0.2, "space": 1, "focusedPid": 1, "focused": 1 },
  "issues": []
}
```

A run asserts `theftFree && ok`: zero off-baseline samples across enough coverage to matter (`minSamples`, default 10). When theft occurs, `offBaseline` lists each contiguous interval with first-sample index, timestamp, duration, which fields changed, and the distinct observed states — e.g. a 4600 ms interval where `focusedPid` sat on `573` (`AXGroup:desktop`) while `pid` still read the human's TextEdit.

`meta` and `done` record probe pid, achieved cadence, per-sample cost (`sampleMsAvg`/`sampleMsMax`), overruns, and which facilities were live (`axTrusted`, `slsSpace`), so a thin run is visible as thin.

## Fixture integration

`apps/desktop/src/cuaFixtures/electron.ts` runs the probe around the existing three-window overlapped semantic-text section: `startFocusProbe()` after `sentinel.focus()`, `finish()` when the section ends. The case `three-window-focus-neutral-semantic-text` now requires both the in-process sentinel invariant (every `BrowserWindow.getFocusedWindow()` sample on the sentinel) **and** `focusProbe.report.theftFree` (system-wide frontmost pid / key window / top window / Space / typing focus never left baseline). The probe pins `expect.pid` to the fixture pid and `expect.keyWin` to the sentinel's native window id when both resolve; anything else derives baseline from the settle window.

`runGatewayFixture` accepts an optional `focusProbePath` and meters its whole tool-call section the same way, surfacing a `gateway-focus-neutral` case plus the full report under `report.gateway.focusProbe`. `build-electron.mjs` compiles `focus_probe.m` into the fixture bundle's `Resources/`, so the sampler shares the fixture's TCC grants. When the binary is absent (dev runs), both call sites record `{skipped: ...}` and the existing assertions stand alone.

The sampler is also usable without the wrapper: `focus-probe --stdin --hz 50` samples until stdin EOF — a parent holds the pipe for the measured section and closes it to stop.

## Limits

- Baseline-relative, not intent-aware: a human cmd-tab mid-run flags the same as an agent-caused steal. Cert runs need a quiet desktop or `--expect-*` pins.
- `keyWin`/`focused*` need the probe's Accessibility grant; `topTitle` needs screen recording. Running inside the fixture bundle inherits the fixture's grants; a bare `/tmp` build reports `axTrusted:false` in `meta` and narrows coverage accordingly.
- `topWin` reads `CGWindowListCopyWindowInfo` (~5–10 ms per call), so it runs every `--top-win-every` ticks (default 5 → 10 Hz at `--hz 50`) and emits `null` between reads.
- macOS sleeps overshoot badly under timer coalescing (measured 40–80%); the sampler uses `poll` + a bounded spin, verified 150 samples / 3000.0 ms / 0 overruns at 50 Hz and 200 / 2000.0 at 100 Hz on macOS 26.5.2.
- ~1.2 ms average per sample at 50 Hz (measured); the every-5th-tick window-list read peaks ~12 ms. That is the overhead budget the handoffs flagged as unverified.
