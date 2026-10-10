# rev-17 native fixture tier, 2026-09-17 — notes

Certifying section: `report.native` inside `rev17-native-2026-09-17-report.json`
(the single runner invocation also produced the electron, cancellation and
gateway sections; this file certifies the native tier).

## Provenance

- Worktree `/Users/devin/repos/synara-wt-certification`, detached HEAD
  98b86be0c (pr-1227). Fixture app built from this tree via
  `node scripts/computer-use-fixtures/build-electron.mjs`, ad-hoc signed,
  output `/private/tmp/synara-cua-implementation/Synara Cua Fixture.app`,
  installed copy launched at `~/Applications/Synara Cua Fixture.app`.
- Driver: cua-driver 0.28.2, nativeRevision 17, patch sha256
  388f1693f94c…, binary sha256 a8d9f70f9b16… (provenance inside report
  `nativeBuild`; artifact reused into worktree `apps/desktop/resources/`).

## Launch path (external trusted host)

- Host: `bun /private/tmp/synara-cua-implementation/trusted-host.ts` —
  `CuaDriverHost` spawned under the operator session shell, inheriting its
  TCC trust; bundleId `com.synara.cua-fixture-external`, endpoint
  `/var/folders/…/T/synara-cua-5J2V62/host.sock`.
- `check_permissions` through the host: accessibility=true,
  screen_recording=true (attribution `host`, responsible_ppid 56403).
- App launch: `open -g -n -W "$HOME/Applications/Synara Cua Fixture.app"`
  with `--env SYNARA_CUA_FIXTURE_DIR`, `SYNARA_CUA_FIXTURE_ENDPOINT`,
  `SYNARA_CUA_FIXTURE_CAPABILITY` and the LIVE/FOREGROUND flags empty;
  `--stdout/--stderr` captured to `*-console.txt`. The ad-hoc fixture bundle
  itself holds no TCC grants and needs none in this mode.

## Results (native section, 5/5)

- one-click-one-effect, single-window-identical-text, ax-set-value: passed.
- same-pid-keyboard: passed-refusal (expected — the AppKit child owns a
  second identical-titled window; same-pid keyboard delivery is ambiguous).
- minimized-target: passed (refused `not-dispatched` after minimize).
- Identity gate: AppKit child pid 57989, title `Synara Native Fixture
57989 A`, WindowServer id verified as `cua:57989:385` before any input;
  observation before input wrote `native-before.png`.

## Focus invariant

Frontmost app `ghostty` before and after the run
(`frontmost-before.txt`/`frontmost-after.txt` in the run dir); the suite
launches with `open -g` and never activates. Real input only into
fixture-owned windows.

## Caveats / anomalies

- Focus-probe runs inside the grant-less fixture bundle: probe meta
  `axTrusted:false`, so `keyWin`/`focused` coverage is 0; `pid` (frontmost)
  and `space` coverage are 1.0 and stayed at baseline — theft detection is
  degraded to the two strongest signals in this mode.
- `explicit-foreground-text` and `foreground-cancel-*` remain not-run:
  they require the operator's `approved-once` flags, outside this
  certification scope.
