# Three-window semantic fix spec

## Problem

Three concurrent `typeText` calls to three windows of one Electron pid all return `effect=dispatched-unknown` with `verified=unverifiable`, and all three fields stay empty. The rev 15 run proves this in `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:69`. Expected texts were `agent-a-background`, `agent-b-background`, `agent-c-background`. Actual values were `"", "", ""`. Focus never left the sentinel: 2951 of 2951 samples on window id 4. The three spans overlapped, with durations 1.6 s, 2.67 s, and 3.75 s. This is parity Gap item 1 in `docs/computer-use-cua/v2-parity-matrix.md:41`. It blocks the core promise of focus neutral background typing. The solo semantic paths passed in the same run, so the failure is specific to concurrent same-pid writes (unverified as the only trigger until the decisive experiment runs).

## Current state

The server truly overlaps independent exact-target writes. `typeTextAt` scopes each write by window id in `apps/server/src/computer/ComputerManager.ts:2298`. `runScoped` orders calls that share a key and overlaps calls with different keys in `apps/server/src/computer/DesktopOperationQueue.ts:140`. The fixture fires all three writes under one `Promise.all` in `apps/desktop/src/cuaFixtures/electron.ts:313`. The pass condition needs exact text in each field plus zero fixture-window focus samples (the app never becomes frontmost) plus span overlap in `apps/desktop/src/cuaFixtures/electron.ts:339`.

The driver admits concurrent lanes but paces each exact target through character AX requests. The generation gate validates every active target before character-paced AX requests, per `apps/desktop/patches/cua-driver/README.md:74`. Rev 11 made exact semantic text concurrently admissible across exact windows in the same file at `apps/desktop/patches/cua-driver/README.md:74`. Rev 12 rejects a second concurrent native lease for the same exact pid and window in `apps/desktop/patches/cua-driver/README.md:82`. Rev 15 rebased this stack onto driver 0.28.2 in `apps/desktop/patches/cua-driver/README.md:100`.

The semantic token path sends text with `element_token` plus `semantic_only` in `apps/server/src/computer/CuaComputerBackend.ts:1250`. Readback unchanged maps to `verified=false` on the server, which the result projection reports as `dispatched-unknown` in `apps/server/src/computer/CuaComputerBackend.ts:1084`. The server never replays an uncertain action. That rule stays.

Candidate causes, ranked:

1. Concurrent AX selected text race on one pid insertion point. Same-pid Chromium targets share one insertion path. Interleaved AX writes can each report success while nothing sticks. This fits all three fields staying empty.
2. Shared-gate O(n-squared) verify contention widening the race. Each char re-verifies every active target. Three lanes triple the verify work per char and stretch the window in which insertion races. Driver-internal timing detail is unverified from repo sources.
3. Latent cross-target poisoning via global `target_invalidated`. One lane invalidation can taint a sibling lane. No rev 15 log proves this fired. This stays a suspect, unverified.
4. Readback attribution race. Text may land but readback may run against the wrong token or before settle. The empty strings argue against partial landing, but attribution logic is unaudited, so this stays open, unverified.

Decisive experiment: run the same fixture with 1 window, then with 3 windows of the same pid, with per-call accepted flag and per-window readback logging. If 1 window passes and 3 windows fail, the race is confirmed. If 1 window also fails, the single-write path is broken instead and this spec is wrong.

## Approach

Primary fix direction: serialize same-pid semantic writes with per-window ordering. Do not pursue true-overlap hardening first.

Reasons:

- It removes the top candidate race directly. One same-pid write is active at a time, so no two AX insertions share the pid insertion path.
- It is server-side only. No driver protocol change. No gate change. No cleanup acknowledgement change. No replay rule change.
- True-overlap hardening needs a native redesign of the shared gate and per-char verify path. That touches safety-critical code and needs longer proving. It stays a later option.
- Solo paths and cross-pid overlap keep current behavior. Only the same-pid lane serializes.

What happens to the fleet-verify loop: nothing changes in code. Contention ends by construction because only one same-pid write holds the lane at a time. The per-char own-target revalidation stays. No verify step is weakened. Any future change that scopes the validate-every-active-target step needs its own spec and proof.

What happens to readback attribution: each write reads back its own window through its own element token after its own delivery completes and before the next same-pid write starts. Attribution key is the element token, never the pid and never shared state. A mismatched token fails the write with the existing `stale_target` refusal. No new silent mapping is added.

Non goals: no change to the input admission gate, no change to cleanup acknowledgement, no automatic replay of uncertain effects, no foreground promotion, no masking, no belief synthesis. Those belong to the sidecar spec and stay out of this fix.

Consistency: this spec agrees with Gap item 1 in `docs/computer-use-cua/v2-parity-matrix.md:41` and with the sidecar acceptance starting point in `docs/computer-use-cua/option-c-sidecar-spec.md:74`. The sidecar ladder still starts from AX actioning with zero activation. This fix only makes the AX rung correct under same-pid concurrency.

## Interfaces

Contract changes are minimal and server-side only. No driver protocol change. No new refusal codes.

- Same-pid lane key. The server maps each semantic write to a lane key derived from the target pid. Calls on one lane stay ordered. Calls on different pids still overlap. Same-window ordering is unchanged.
- Pacing params, two of them, both server config with stated defaults. Max lane hold per write: 15 s, then the write fails honestly instead of holding the lane. Inter-write gap on a lane: 100 ms, to let AX settle before the next insertion. Both values are proposed, unverified until measured.
- Lease query surface: none new. No new driver method. Observability comes from structured logs only: per-call accepted flag, lane wait time, delivery span, per-window readback value, and final effect. Log fields reuse existing names where they exist.
- Refusals: reuse existing codes only. `stale_target` for token mismatch. Lane timeout reports `dispatched-unknown`, never `not-dispatched`, because partial insertion is possible. It is never replayed.

## Acceptance criteria

- The in-tree case `three-window-focus-neutral-semantic-text` passes: exact text in each of the three fields, every focus sample null (no fixture window ever holds OS focus — `BrowserWindow.focus()` is never called because it activates the app even under `open -g`), spans recorded. Case definition lives in `apps/desktop/src/cuaFixtures/electron.ts:339`.
- The same run passes 10 times in a row with zero failures and zero focus theft. Focus theft means any non-null focus sample during the overlapped section, or the fixture app ever becoming frontmost.
- Solo paths are unregressed. The five rev 15 passing cases still pass: one-click-one-effect, single-window-identical-text, ax-set-value, moved-target refusal, closed-target refusal. Provenance for that list is `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:24`.
- Timing budget: the three-window run completes within 30 s wall clock. Each single write completes within 15 s including lane wait. The budget is proposed, unverified until the 10x run measures it.
- No gate regressions. Admission, cleanup acknowledgement, and never-replay-uncertain hold on every path. A refused or uncertain write never retries automatically and never promotes to foreground.

## Tests and evidence

Method caveat, stated honestly: the rev 15 run launched by direct binary exec, not the documented `open -g -n -a` path. Screen Recording attribution fell to the launching terminal, not the app bundle, and the run stole the operator fullscreen Space and focus. Do not treat rev 15 as a focus isolation pass. Focus samples stayed on the sentinel only because the suite focuses its own windows. Screenshot behavior differs by launch path, for reasons still unresolved. Full detail is in `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:20`.

- Decisive experiment first. Add per-call accepted and readback logging to the fixture path in `apps/desktop/src/cuaFixtures/electron.ts:313`. Run 1-window, then 3-window, same pid, same build. Save both report JSON files as evidence. The 1-vs-3 contrast decides race versus broken single path.
- Fix proof. Run the three-window case 10 times in a signed app with fresh permissions. Save each report JSON plus before and after images under the existing evidence dir pattern. Each run records driver version and native revision, per-call lane wait, per-window readback, and focus samples.
- Regression proof. Run the five passing rev 15 cases in the same build and record their status. Any fail is a fix rejection.
- Unit tests. Lane key derivation: same pid maps to one lane, different pids map to different lanes. Ordering: two same-lane writes never overlap. Timeout: a stuck write releases the lane and reports honestly. Pure logic, no native calls.
- Evidence per run: report JSON, console log, focus sample count, lane waits, readback values. Anything not run is marked uncertified, never assumed.

## Risks

- Serialization hides a real native bug instead of fixing it. The race may still bite direct or separate clients that overlap same-pid writes. Mitigation: the decisive experiment names the race, and rev 12 already refuses same-window double leases in `apps/desktop/patches/cua-driver/README.md:82`. A native hardening follow-up stays open.
- Lane head-of-line blocking. One slow write delays its pid siblings. Mitigation: the 15 s max hold bounds the delay, and cross-pid work is unaffected.
- Wrong lane key. If pid parsing misattributes a window, two same-pid writes could still overlap or two independent writes could serialize needlessly. Mitigation: unit tests on key derivation plus lane wait logs in every run.
- Timing budget miss. AX settle on slow machines may exceed the 100 ms gap or the 15 s hold. Mitigation: budgets are config, and misses fail honestly with logs instead of writing through.
- Launch path skew. Direct exec versus `open -g -n -a` changes capture and focus behavior, so green under one path does not certify the other. Mitigation: certify under the signed app path and mark the rest uncertified.

## Open decisions

1. Same-pid concurrency semantics. Options: serialize same-pid writes, or keep true overlap and harden the native gate. Recommendation: serialize same-pid writes with per-window ordering. Safe default: serialize. Overlap returns only with a passing 10x proof plus native gate proof.
2. Cross-pid overlap. Options: keep overlap, or serialize everything. Recommendation: keep cross-pid overlap. Safe default: keep overlap, because no evidence implicates cross-pid writes.
3. Pacing values. Options: 100 ms gap and 15 s hold, or tune after measurement. Recommendation: ship the stated values, then tune from the 10x logs. Safe default: keep the stated values until measured data supports a change.
4. Driver fleet-verify change. Options: scope verify to own target now, or leave the driver untouched. Recommendation: leave the driver untouched in this fix. Safe default: no driver change.
5. Per-call logging permanence. Options: keep accepted and readback logs permanently, or remove them after the experiment. Recommendation: keep them as permanent debug fields. Safe default: keep them behind existing debug verbosity, never in the user visible result.

## Implementer brief

Ordered steps. Existing files carry cites. New code lives in the listed files only.

1. Read the evidence. Read the failing case in `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-report.json:69` and the caveats in `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-notes.md:8`. Confirm the failure shape before writing code.
2. Read the overlap path. Study `runScoped` in `apps/server/src/computer/DesktopOperationQueue.ts:140`, the scoped call site in `apps/server/src/computer/ComputerManager.ts:2298`, and the token send path in `apps/server/src/computer/CuaComputerBackend.ts:1250`. Confirm where same-pid writes overlap today.
3. Add logging first. Extend the fixture write path around `apps/desktop/src/cuaFixtures/electron.ts:313` with per-call accepted flag, lane wait, delivery span, and per-window readback. No behavior change in this step.
4. Run the decisive experiment. Run 1-window then 3-window against the same build. Save both reports. If 1-window fails, stop and re-diagnose instead of building the lane.
5. Add the same-pid lane. In `apps/server/src/computer/CuaComputerBackend.ts:934` scope, derive the lane key from the target pid and order same-lane writes. Keep cross-pid overlap. Add the two pacing params with the stated defaults. Reuse existing refusal codes only.

Implementation amendment, 2026-09-17: the lane lives in `CuaComputerBackend.inputDispatch`, not in `ComputerManager.runScoped` as first written. Two verified reasons. First, the queue rejects a nested scope whose key differs from the ambient activity scope, so a pid key cannot ride the queue. Second, the fixture and any direct client call the backend without passing through the Manager, so a Manager lane would leave the in-tree acceptance test unchanged. The backend `target` step already proves pid (`apps/server/src/computer/CuaComputerBackend.ts:545`), so no extra read and no unknown-pid fallback were needed. Pacing params are `CUA_SEMANTIC_TEXT_LANE_HOLD_MS` and `CUA_SEMANTIC_TEXT_LANE_GAP_MS` in `apps/server/src/computer/CuaComputerBackend.ts:102`. Timeout helper is `withSemanticTextLaneTimeout` in `apps/server/src/computer/CuaComputerBackend.ts:137`. Contract unchanged: same-pid serializes, cross-pid overlaps, driver untouched. 6. Attribute readback per token. After each write completes, read back through its own element token before releasing the lane. Mismatch fails honestly as `dispatched-unknown`. Never replay. 7. Add unit tests. Lane key mapping, same-lane ordering, lane timeout release. Run the affected Vitest suites for `apps/server/src/computer/DesktopOperationQueue.ts:140` and `apps/server/src/computer/ComputerManager.ts:2011`. 8. Run the proof. Run the three-window case 10 times plus the five solo cases in a signed app with fresh permissions. Save all reports and images as evidence. Check focus samples, lane waits, and readbacks in each. 9. Final checks. Run fmt, lint, typecheck, and the affected tests. Confirm the admission gate, cleanup acknowledgement, and never-replay rule are untouched. Report what ran, what passed, and what stays unverified.

## Resolution (2026-09-17, post-spec)

The spec's ranked candidates all assumed the `AXSelectedText` insert path was
sound and the failure was concurrency. Live disproof:
`docs/computer-use-cua/input-matrix-2026-09-17.md`. On Electron 43 the
AXSelectedText write never reaches the DOM at all — serialized or
concurrent, inactive or frontmost. The race was never the primary defect.

Actual fix: `CuaComputerBackend` tracks `in_web_content` elements and routes
their text writes through a composed `set_value` (`existing + text`) plus an
independent re-read verification — `webContentTypeText`/`webSetValue`/
`resolveWebField` in `apps/server/src/computer/CuaComputerBackend.ts`. The
same-pid lane still serializes these writes (kept as defence-in-depth);
`setValue` on web elements verifies identically.

Result (`evidence/fixture-g5-set-value-2026-09-17.report.json`,
`fixture-g5-set-value-2026-09-17-notes.md`): three-window passes with
3× `verified`/`confirmed` on the `cua-accessibility-background` route,
2580/2580 focus samples on the sentinel, `overlap: true`, spans
~1.4 s/2.6 s/3.9 s. Full suite green three consecutive runs including
`explicit-foreground-text` under `SYNARA_CUA_FIXTURE_FOREGROUND=approved-once`.
Gateway stub repaired to model task consent (`gateway.ts` — routine
background approved, foreground denied, denials recorded), closing the two
pre-existing gateway failures with their real assertions exercised.

Not done from the spec: 10× consecutive stability runs (3 so far). The
"decisive experiment" it asked for ran differently than planned — instead of
1-vs-3 windows of the same mechanism, the mechanism itself was replaced after
the input matrix proved AXSelectedText dead on Chromium.

## Correction, 2026-09-17 (appended)

The `open -n -a` launch form cited above is now known to steal focus; the
verified silent form is `open -g -n -a`. The fixture launch line is a known
bug being fixed separately. Launch-path skew remains a real certification
concern; only the flag choice changes.

Lane granularity amendment, 2026-09-18: the `semanticTextInLane` key narrowed
from `pid` to `(pid, window_id)` — the exact granularity of the native rev-12
semantic lease. Writes to different windows of one pid now overlap at the
driver instead of queueing server-side; writes to one exact window still
serialize (a second concurrent native lease on the same pid+window is refused
outright, so the lane orders rather than risks a refusal), and the hold/gap
pacing params are unchanged. The original same-pid race rationale was already
disproven by the input matrix — the real defect was the dead AXSelectedText
route — so the pid-wide lane was defence-in-depth, not load-bearing. Server
unit tests cover same-window ordering, same-pid cross-window overlap, and a
three-window same-pid interleave.
