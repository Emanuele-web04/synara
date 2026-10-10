# rev-15 electron fixture run, 2026-09-17 — notes

Provenance: driver 0.28.2 / native rev 15 / patch 94261ed9 (see provenance
inside rev15-electron-2026-09-17-report.json, `nativeBuild`). Fixture app
built from this branch (`scripts/computer-use-fixtures/build-electron.mjs`),
installed at `~/Applications/Synara Cua Fixture.app`.

Method caveats (read before citing this as certification):

- Launched by DIRECT binary exec, not the documented `open -n -a` path, so
  Screen Recording attribution fell to the launching terminal, not the app
  bundle, and the run STOLE the operator's fullscreen Space and focus.
  Do not treat this run as a focus-isolation pass: focus samples stayed on
  the sentinel only because the suite focuses its own windows.
- TCC: Accessibility + Screen Recording both granted to the Fixture bundle
  before this run (driver `check_permissions` reports true/true).
- Earlier same-day `open -a` launches produced screenshot-less observations
  and a 2-case partial report (`Exact semantic fixture target Fixture text C
is unavailable`); the direct-exec run completed all 8 electron cases.
  Screenshot/capture behavior differs by launch path — unresolved why.

Results (electron suite, 8 cases):

- passed: one-click-one-effect (clicks === 1, exactly-once delivery),
  single-window-identical-text, ax-set-value, moved-target (stale refused),
  closed-target (dead refused).
- refused (by design): identical-text-replacement
  (same_pid_keyboard_ambiguity with sibling windows present).
- not-run (correct): explicit-foreground-text (no approved-once flag).
- FAILED: three-window-focus-neutral-semantic-text — all 3 concurrent
  typeText calls returned effect=dispatched-unknown, verified=unverifiable,
  fields stayed empty; focus never left the sentinel (2951/2951); durations
  grew per target (1.6s / 2.7s / 3.75s, overlapping spans).
  Root-cause investigation and fix spec: `three-window-semantic-fix-spec.md`.

Files: report.json, console.txt, fixture-before/after.png, native-before/after.png, gateway-before.png.
No live/gateway/cancellation sections ran in this invocation.
