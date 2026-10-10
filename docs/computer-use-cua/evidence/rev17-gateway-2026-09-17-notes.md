# rev-17 gateway fixture tier, 2026-09-17 — notes

Certifying section: `report.gateway` inside
`rev17-gateway-2026-09-17-report.json` (one runner invocation produced the
electron, native, cancellation and gateway sections; this file certifies
the gateway tier — real `makeAgentGatewayComputerTools` handlers +
`ComputerManager` + the trusted native host, driven from a controlled
provider-context caller, not a paid model turn).

## Provenance / launch path

Identical invocation to `rev17-native-2026-09-17-notes.md`: worktree
98b86be0c fixture bundle, external `CuaDriverHost`
(`com.synara.cua-fixture-external`, endpoint
`/var/folders/…/T/synara-cua-5J2V62/host.sock`,
accessibility+screen_recording true through the host), `open -g -n -W`
launch of `~/Applications/Synara Cua Fixture.app` with
`SYNARA_CUA_FIXTURE_ENDPOINT`/`SYNARA_CUA_FIXTURE_CAPABILITY` set and the
LIVE/FOREGROUND flags empty.

## Results (gateway section, 6/6)

- different-window-frame: passed — a click carrying window A's frame but
  window B's `window_id` is denied before native dispatch (0 submissions).
- gateway-native-click: passed — one gated background click on owned
  window `cua:57215:411`, `window.clicks === 1`, exactly one native
  submission, reply screenshot re-bound to the same window id.
- foreground-denial-before-native: passed — `computer_type_text` with
  `delivery_mode:"foreground"` denied at the consent gate; exactly one
  recorded denial, correct `turnId` (`fixture-gateway-57215-turn`), zero
  native submissions.
- off-refuses-native-input: passed — `setControlEnabled(thread,false)`
  makes the same click an error with no submission and no state change.
- ended-turn-refuses-native-input: passed — after the caller turn ends
  the handler fails before dispatch (0 submissions).
- gateway-focus-neutral: passed — bundled focus probe `theftFree:true`;
  frontmost pid and Space stayed at baseline for the whole tool-call
  section (81 samples @50 Hz, 0 off-baseline, 0 drift).

## Focus invariant

Frontmost app `ghostty` before and after the run; the gateway section ran
inside the same `-g` launched app and never activated it.

## Caveats / anomalies

- Probe `axTrusted:false` (fixture bundle holds no grants): `keyWin` and
  `focused` coverage 0; verdict rests on pid+space coverage 1.0. Same
  degradation as the native tier notes.
- The rev15 run recorded `gateway-native-click` and
  `foreground-denial-before-native` as failed under the older consent
  model; both pass under the current gate (ccf5ad10a) — see
  `approvals` in the report.
