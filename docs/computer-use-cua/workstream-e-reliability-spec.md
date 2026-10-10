# Workstream E: reliability, evidence, and packaging spec

## Problem

Source level checks check source only: format, lint, typecheck, and focused tests (`docs/computer-use-cua/README.md:120`). They do not prove packaged runtime behavior. The parity matrix states this directly: runtime behavior at revision 15 is uncertified until a signed app run with fresh permissions passes (`docs/computer-use-cua/v2-parity-matrix.md:5`). The 2026-09-17 fixture run proved some paths and left the rest open. Until a clean certification run closes each gap, no claim about revision 15 behavior is certified. This spec sets the bar for that sign-off.

## Current state

The 2026-09-17 run used driver 0.28.2 with native revision 15 and patch 94261ed9, recorded inside the report JSON (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:3`). Read the method caveats before citing any result as proof.

The run launched by direct binary exec, not the documented `open -g -n -a` path. Screen Recording attribution fell to the launching terminal, not the app bundle. The run stole the operator fullscreen Space and focus (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:10`). Focus samples stayed on the sentinel only because the suite focuses its own windows. This run is not a focus isolation pass.

TCC grants were present: Accessibility and Screen Recording were both granted to the fixture bundle before the run (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:15`). Earlier same-day `open -a` launches produced screenshot-less observations and a 2-case partial report. The direct exec run completed all 8 electron cases. Screenshot and capture behavior differs by launch path, and the reason is unresolved (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:17`).

Exact tally across the 8 electron cases:

- Passed, 5: one-click-one-effect with clicks exactly 1, single-window-identical-text, ax-set-value, moved-target refused as stale, closed-target refused as dead (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:24`).
- Refused by design, 1: identical-text-replacement, refused as same_pid_keyboard_ambiguity with sibling windows present (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:27`). The report records the refusal and the sibling window count (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:59`).
- Not run, correct, 1: explicit-foreground-text, because no approved-once flag was set (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:27`).
- Failed, 1: three-window-focus-neutral-semantic-text. All 3 concurrent typeText calls returned effect dispatched-unknown with verified unverifiable. Fields stayed empty. Focus never left the sentinel. Durations grew per target (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:30`). The report records all three per-window dispatched-unknown results (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:69`).

What the run left open: no live, gateway, or cancellation sections ran in that invocation (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:37`). The open-launch screenshot gap is unresolved. The three-window failure has its own fix spec (`docs/computer-use-cua/three-window-semantic-fix-spec.md:1`) and blocks the core promise of background typing, which is parity Gap item 1 (`docs/computer-use-cua/v2-parity-matrix.md:41`). This spec agrees with parity Gap item 8: screenshots and Spaces behavior exists in source but is uncertified at revision 15 (`docs/computer-use-cua/v2-parity-matrix.md:48`).

## Approach

Certification bar for revision 15 sign-off. Five parts.

1. Hard rule: separate-Space fixture runs only, through the documented `open -g -a` path. NEVER launch by direct binary exec on the operator Space. The 2026-09-17 incident is the reason: direct exec stole the operator fullscreen Space and focus and misattributed Screen Recording to the terminal (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:10`). The README warns that running the Electron binary directly from a terminal can attribute Screen Recording to the terminal host instead (`docs/computer-use-cua/README.md:104`). The documented path is the LaunchServices command with `open -g -n` and per-run fixture directories (`docs/computer-use-cua/README.md:107`) — `-g` keeps the fixture from ever becoming frontmost or pulling the operator's Space. Every certification run must use it. Any run that uses direct exec is method-invalid and cannot count toward sign-off.

2. Full fixture matrix, including the native, gateway, cancellation, and live tiers. The 09-17 run covered the electron tier only (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:22`). The live tier needs production web and server bundles, a fresh directory, the live env flags, and a real approval card flow in the UI (`docs/computer-use-cua/README.md:118`). The foreground tier stays behind its approved-once flags and needs explicit operator authorization per run (`docs/computer-use-cua/README.md:116`). The runner refuses input unless the exact window title, process PID, and native window ID agree (`docs/computer-use-cua/README.md:114`). Process exit alone is never a pass.

3. Real-app proof on 3 real apps. Fixture apps prove the protocol path. Real apps prove grounding, permission consumption, and approval flow outside owned windows. The exact 3 apps are unverified at spec time and need an operator decision. No real-app proof may touch personal data or personal applications.

4. Evidence discipline for every run: one report JSON, before and after PNGs, console log, and a notes file with method caveats. Follow the flat naming already in use in the evidence directory: `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json`, `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-fixture-before.png`, `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-console.log`, `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md` (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:34`). Each notes file must state launch path, TCC state, and any focus or capture anomaly, the way the 09-17 notes state theirs (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:10`). A run without a notes file is incomplete.

5. Signing plan. No Developer ID Application certificate exists on this machine today. Verified at spec time with a local identity listing: only Apple Development identities and one local dogfood identity are present, so production signing and notarization cannot run here (unverified beyond this machine). Local certification runs use dev or adhoc signing. The recorded binary checksum precedes app signing, and production signing and notarization were not performed here (`docs/computer-use-cua/README.md:96`). Permission testing guidance also assumes a signed app built from the worktree (`docs/computer-use-cua/permission-guide.md:36`). Production signing and notarization are out of scope for this workstream.

## Interfaces

Evidence file naming per run. Pattern: `rev<NN>-<suite>-<YYYY-MM-DD>-<artifact>.<ext>`. Suite is one of `electron`, `native`, `gateway`, `cancel`, `live`, `realapp`. Artifact is one of report.json, console.log, notes.md, fixture-before.png, fixture-after.png, native-before.png, native-after.png, gateway-before.png. The 09-17 set follows this pattern (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:34`).

Required report fields per run:

- `nativeBuild` with driver source version, native revision, and patch checksum, plus `nativePermissions` and `target`, as recorded in the 09-17 report (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:1659`). Field names beyond these are unverified until the next run lands.
- Fixture build provenance: builder script, install path, and bundle identity.
- Launch path: exact command used. Must be the `open -g -n -a` form (`docs/computer-use-cua/README.md:107`). Direct exec fails review.
- TCC state: Accessibility and Screen Recording grant state before the run, the way the 09-17 notes record true and true (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:14`).
- Per-case record: name, status, effect, verified flag, readback values, focus sample counts, and durations. The 09-17 report shows the shape for refused and failed cases (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:59`).
- Target agreement: window title, PID, and native window ID agreement per the runner rule (`docs/computer-use-cua/README.md:114`).
- Live tier extras: server bundle path, loopback URL, and approval card outcome (`docs/computer-use-cua/README.md:118`).
- Notes file with method caveats, including any Space, focus, or capture anomaly (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:10`).

## Acceptance criteria

Revision 15 is certified only when every item below passes:

1. one-click-one-effect passes with clicks exactly 1, under the signed `open -g -a` path on a separate Space.
2. single-window-identical-text passes on the same path.
3. ax-set-value passes on the same path.
4. moved-target is refused as stale on the same path.
5. closed-target is refused as dead on the same path.
6. identical-text-replacement is refused as same_pid_keyboard_ambiguity with sibling windows present, matching the recorded refusal shape (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:59`).
7. explicit-foreground-text runs with the approved-once flag set and passes, with operator authorization recorded in the notes (`docs/computer-use-cua/README.md:116`).
8. three-window-focus-neutral-semantic-text passes with exact text in each field, every focus sample null (no fixture window ever held OS focus), and recorded overlap. This depends on the three-window fix landing first. Until then revision 15 cannot certify.
9. Native, gateway, cancellation, and live tiers all run and pass. The 09-17 run covered none of them (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:37`). The live tier follows the documented live flow (`docs/computer-use-cua/README.md:118`).
10. Real-app proof passes on 3 real apps with before and after PNGs and a notes file per app. App list is unverified at spec time.
11. The open-launch screenshot gap is resolved: `open -g -a` runs produce window screenshots on every tier. Screenshot-less observations fail certification (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:20`).
12. No focus theft on any run: no fixture window holds OS focus for the full overlapped section, and the fixture app never becomes frontmost.
13. Source checks stay green: `bun run test` (never `bun test`), plus format, lint, and typecheck (`docs/computer-use-cua/README.md:120`). Source green alone does not certify. Packaged runs do.

## Tests and evidence

- Electron tier: fixture suite through the LaunchServices command with a fresh output directory per run (`docs/computer-use-cua/README.md:107`). Save report JSON, console log, before and after PNGs, and notes.
- Foreground tier: same command plus the approved-once flags, only with explicit operator authorization (`docs/computer-use-cua/README.md:116`). Record the authorization in the notes.
- Cancellation tier: drag interrupt and Shift-click interrupt in the owned target, plus the private protocol probe without input or capture (unverified command path at spec time, check the fixture scripts before running).
- Gateway tier: gateway section of the suite with gateway before PNG and gateway report, matching the existing gateway artifact names in the evidence set (unverified exact flags at spec time).
- Live tier: production bundles, live env flags, real UI approval card flow, twenty minute cap or graceful SIGTERM (`docs/computer-use-cua/README.md:118`). Uses real provider credentials through normal setup. Nothing fabricated.
- Real-app tier: 3 real apps, one background action each, with before and after PNGs and notes. App list needs the operator decision first.
- Regression: the 5 passing 09-17 cases must still pass on every certification run (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:24`). Any fail rejects the run.
- Source checks: `bun run test`, format, lint, typecheck (`docs/computer-use-cua/README.md:120`). Required but not sufficient.

## Risks

- TCC identity churn. Rebuilds change the code identity, and macOS keeps the old requirement. Settings can show a grant as on while native checks report denied. The permission guide records exactly this failure with mismatched cdhash values (`docs/computer-use-cua/permission-guide.md:59`). Mitigation: verify grants with a fresh native check on every run, never trust the Settings switch alone. Re-sign and re-grant as one step after any rebuild.
- Gatekeeper. A dev or adhoc signed build can face launch blocks or quarantine behavior on first open (unverified on this machine at spec time). Mitigation: launch through Finder or `open -a` at least once, clear quarantine only on the owned fixture copy, and record any Gatekeeper dialog in the notes.
- Disk pressure. About 13 GB free on the root volume at spec time, verified with a local disk check. Fixture builds, evidence PNGs, and production bundles all consume space. Mitigation: use a fresh output directory per run but archive or remove stale run directories promptly. Stop and free space before a run if free space drops under 10 GB (unverified threshold, operator can adjust).
- Launch-path skew. Direct exec and `open -g -a` produce different capture and focus behavior for reasons still unresolved (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:16`). Green under one path does not certify the other. Mitigation: the hard rule in Approach. Certify only under the signed `open -g -a` path. Mark everything else uncertified.

## Open decisions

1. Certification environment. Options: local signed runs only, or local runs first with a Lume VM for final sign-off. Recommendation: local signed runs first for speed, then a Lume VM run for final sign-off, because a VM gives clean TCC state and no operator Space to steal. Safe default: local signed runs first. Lume VM availability on the cert machine is unverified at spec time. The VM run is required before the certified label.
2. Real-app selection. Options: operator picks 3 apps, or the implementer proposes 3 for approval. Recommendation: implementer proposes 3 common apps with no personal data, operator approves. Safe default: no real-app run until the operator names the apps.
3. Foreground flag scope. Options: per-run explicit authorization, or a standing authorization for continued fixture testing. The README notes a standing authorization may exist (`docs/computer-use-cua/README.md:116`). Recommendation: per-run explicit authorization, recorded in the notes. Safe default: per-run authorization. Standing authorization is unverified at spec time.
4. Production signing owner. Options: this workstream owns it, or it stays out of scope. Recommendation: out of scope. No Developer ID Application certificate exists on this machine, and the README already scopes production signing out (`docs/computer-use-cua/README.md:96`). Safe default: dev and adhoc signing only.
5. Screenshot gap ownership. Options: this workstream investigates, or the investigation belongs to the fixture owner. Recommendation: this workstream tracks it as acceptance item 11 and asks the fixture owner for the root cause. Safe default: certification stays blocked until `open -g -a` screenshots work, whoever fixes it.

## Implementer brief

Ordered steps.

1. Read the 09-17 notes in full, caveats first (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:10`). Confirm the tally: 5 passed, 1 refused by design, 1 not run, 1 failed.
2. Read the fixture launch docs (`docs/computer-use-cua/README.md:107`) and the target agreement rule (`docs/computer-use-cua/README.md:114`). Set up a separate Space for all runs.
3. Confirm signing state on the machine. No Developer ID Application certificate is expected. Build and sign with dev or adhoc identity. Record the identity in the first notes file.
4. Run the electron tier through `open -g -n -a` on the separate Space. Save report JSON, console log, before and after PNGs, and notes with launch path and TCC state (`docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:8`).
5. Confirm the open-launch screenshot behavior. If observations are screenshot-less, stop and report. Do not fall back to direct exec. The hard rule forbids it.
6. Run the gateway, cancellation, and live tiers (`docs/computer-use-cua/README.md:118`). Save the same evidence set per tier.
7. Run the foreground tier only after explicit operator authorization, with the approved-once flags (`docs/computer-use-cua/README.md:116`). Record the authorization in the notes.
8. Run real-app proof on the 3 operator-approved apps. One background action each. Before and after PNGs plus notes per app.
9. Check every acceptance item. Any fail or missing evidence blocks sign-off. The three-window case stays blocked until its fix lands.
10. Run source checks last: `bun run test`, format, lint, typecheck (`docs/computer-use-cua/README.md:120`). Report what ran, what passed, and what stays unverified.

## Correction, 2026-09-17 (later same day, appended)

- The `open -n -a` launch form this spec requires is now known to steal
  focus and can switch the operator's Space. The verified silent form is
  `open -g -n -a` (background flag). The fixture launch line is a known
  bug being fixed separately; certification runs should use `-g -n -a`
  and still record the exact launch path.
- The three-window case this spec blocks on is closed: web-content
  `typeText` routes through verified `set_value` compose, and the G5
  fixture passed 10x (`docs/computer-use-cua/evidence/fixture-g5-set-value-2026-09-17-notes.md`).
- Certification now targets native revision 18, not 15.
