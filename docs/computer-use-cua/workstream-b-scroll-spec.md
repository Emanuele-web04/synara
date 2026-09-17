# Scroll v2 spec (workstream B)

## Status: implemented 2026-09-17 (native rev 16, commit `78bc88bae`)

Shipped and live-verified on TextEdit on this VM. What landed matches this
spec with these measured facts:

- Two axes plus held modifiers ride one wheel gesture: the driver takes
  signed `delta_x`/`delta_y` ticks (±50 per axis per dispatch) and a modifier
  list, and posts pixel-unit (`ScrollEventUnit::PIXEL`) wheel deltas with the
  modifier flags set on each event. Requests still quantize to 120-pixel
  notches per axis.
- AX scrollbar presses are tried first only for an unmodified vertical
  scroll carrying an element token; horizontal, diagonal, modified, or
  non-semantic requests go straight to the wheel path. Gearing is keyed per
  route (`window|ax` vs `window|wheel`) so the two never share a ratio.
- macOS now runs the common before/after measurement loop inside the agreed
  budget: at most two injected legs (48 px probe plus corrected remainder)
  and at most three captures including the caller observation. Wrong-way or
  zero-travel measurements are suppressed, never learned, never replayed.
- Gearing persists in `computer-scroll-gearing.json` beside control state
  (64-entry cap, versioned envelope; a corrupt or missing file degrades to
  gearing 1, never to a failure).
- Live on TextEdit: background pixel scrolls land both directions; a
  two-axis-plus-modifier request dispatches as one event; a pid-only scroll
  refuses closed.
- Measured limitation, stated honestly: TextEdit ignores horizontal wheel
  deltas. NSScrollView wants continuous trackpad deltas for horizontal
  travel, so `delta_x` is a no-op there. This is a toolkit limitation, not a
  refusal.
- The driver's keystroke scroll path is unreachable through Synara
  admission (an exact pid plus window_id is required), so its refusal of
  delta/modifier requests is defense-in-depth rather than a live gate.

The "Current state" section below describes the rev-15 baseline this spec
was written against; it is kept for history.

## Problem

macOS scroll is quantized, single axis, and unmeasured. One operation maps to 120 pixel notches with a cap of 50. Two axis requests are refused. Modified scrolls are refused. No travel is measured on macOS, so no correction is learned. Kartik reports the agent has trouble scrolling: large requests land far from target, small requests vanish into notch rounding, and the loop cannot see what moved.

## Current state

The backend scroll entry point lives in `apps/server/src/computer/CuaComputerBackend.ts:1198`. It refuses two axis input at `apps/server/src/computer/CuaComputerBackend.ts:1205` and refused modifiers at `apps/server/src/computer/CuaComputerBackend.ts:1211`. The 120 pixel notch conversion sits at `apps/server/src/computer/CuaComputerBackend.ts:1227` with the 50 notch cap at `apps/server/src/computer/CuaComputerBackend.ts:1230`. The pixel test that pins this behavior sits at `apps/server/src/computer/CuaComputerBackend.test.ts:867`.

The manager has a closed loop for other platforms but skips it on macOS. The before capture is skipped for macOS at `apps/server/src/computer/ComputerManager.ts:1726`. The macOS branch injects without measuring or learning at `apps/server/src/computer/ComputerManager.ts:1736`.

The measurement math already exists and is platform neutral. The correlator entry point is `apps/server/src/computer/scrollCalibration.ts:240`. The per window gearing store is `apps/server/src/computer/scrollCalibration.ts:357`. The shared pixel to notch constant is `apps/server/src/computer/scrollUnits.ts:32`.

The native wheel poster is `scroll_wheel_at_xy` in `apps/desktop/patches/cua-driver/0001-synara-native.patch:4874`. The patch hunks around that line only change cancellation gating, not wheel semantics, so the driver still posts one direction per call with fixed sleeps between ticks.

The tool surface keeps two safety rules that this spec preserves. Requests are clamped to half the captured frame at `apps/server/src/agentGateway/computerTools.ts:2405`. A fourth consecutive unchanged scroll on one window is refused at `apps/server/src/agentGateway/computerTools.ts:2429`. The streak tracker behind that refusal is declared at `apps/server/src/agentGateway/computerTools.ts:847`.

The parity matrix agrees: the scroll row at `docs/computer-use-cua/v2-parity-matrix.md:13` lists one axis, no modifiers, 120 pixel notches, max 50, no travel measurement on macOS, half frame clamp, and repeat unchanged refusal. Gap item 3 at `docs/computer-use-cua/v2-parity-matrix.md:43` ranks Scroll v2 as the loudest usability gap at P1.

## Approach

Extend the existing measurement pipeline to macOS. Do not build a second loop.

1. Measure on macOS. Take the before capture on macOS exactly as other platforms do, then settle, recapture, and correlate with the existing estimator. Keep measurement best effort: a failed capture or a refused correlation leaves the scroll delivered and unmeasured. Never replay an uncertain scroll to get a cleaner reading.
2. Guard the observation budget. macOS captures cost a native round trip each. Cap the work per scroll request at two captures (before plus one after per injected leg) and at most two injected legs (probe plus corrected remainder). Reuse the after capture as the caller observation, as the current code already does. No extra verification captures beyond the settle and measure pair. Small requests at or below probe size use one leg and one after capture.
3. Prefer AX scroll actions, fall back to wheel. When the target node exposes an AX scroll action through its element token, dispatch it first for that leg. On refusal or absence, fall back to the wheel path. Record which route each leg used in the result so gearing never mixes AX travel with wheel travel for one window key. AX legs learn under an AX key, wheel legs under a wheel key.
4. Support two axes and modifiers in the driver patch. Extend `scroll_wheel_at_xy` to accept a signed X and Y tick count plus modifier flags in one call, posted as one gesture. Keep the per tick sleeps bounded so a 50 notch delivery stays inside the existing action timeout. The backend keeps refusing only what the driver still cannot express, and reports the injected delta per axis in `scrollDelta`.
5. Persist per app gearing. Keep the in memory `ScrollGearingStore` as the hot path. Add a durable per app fallback keyed by bundle id or app name, loaded at manager start and written after each accepted learn. Window keys still win over app keys. A window with no samples inherits its app fallback instead of 1. Bound the durable file the same way the memory map is bounded. A corrupt or missing file degrades to gearing 1, never to a failure.
6. Keep every safety semantic. The half frame clamp stays in the tool layer. The fourth unchanged refusal stays. Fail closed refusal semantics stay: stale geometry, off Space, paused input, and uncertain delivery never replay. Corrective legs are pre planned from learned gearing, not retries of a refused call. A leg that returns `dispatched-unknown` ends the request with what is known, and clears grounding as today.

## Interfaces

Backend (`CuaComputerBackend.scroll`):

- Accepts `dx` and `dy` together. Accepts an optional modifier list and forwards it to the driver.
- Returns `scrollDelta` with both axes as injected pixels.
- Keeps current refusal codes for empty targets and out of range amounts. Adds no new retry behavior.

Driver patch (`scroll_wheel_at_xy`):

- New args: signed X ticks, signed Y ticks, modifier flags. One gesture per call.
- Keeps cancellation gating and target checks. Reports ticks posted per axis or a structured refusal.

Manager (`scrollCalibrated`):

- macOS follows the same probe, plan, inject, measure, learn flow as other platforms, with the two leg and two capture budget above.
- Result `scroll` object gains `route` per leg (`ax` or `wheel`), keeps `requested`, `injected`, optional `traveledY`, and optional `gearing`.
- Gearing lookup order: window route key, then app route fallback, then 1.

Durable gearing store:

- Path under the existing control state directory. JSON map of app key to `{ gearing, samples, updatedAt }`.
- Read once at startup, written after each accepted learn, capped at 64 entries with oldest eviction. Unverified claim: the exact control state directory path is not cited here because no line was read to confirm it.

## Acceptance criteria

- Fixture matrix passes across AppKit, Electron, and webview apps: each fixture scrolls a known pixel request and asserts injected deltas match the planned values within notch rounding.
- Measured travel on macOS falls within tolerance: for a 480 pixel request on a pixel true fixture, reported `traveledY` is within 25 percent of requested after at most one probe. Unverified claim: the 25 percent figure is a new proposal, not a measured baseline.
- Large scrolls land near target: a request above probe size into an unmeasured window splits into probe plus corrected remainder, and total travel is within 30 percent of requested on the second request to the same window. Unverified claim: the 30 percent figure is a new proposal.
- Two axis scrolls deliver both axes in one driver call on fixtures that support it.
- Modified scrolls forward modifiers to the driver instead of refusing, on fixtures that support them.
- Latency budget respected: a calibrated macOS scroll completes within the existing 35 second action timeout, with at most two injected legs and at most three captures total including the caller observation.
- Safety semantics intact: half frame clamp, fourth unchanged refusal, stale geometry refusal, and no replay of uncertain scrolls all covered by passing tests.
- Parity matrix scroll row and Gap item 3 updated or confirmed consistent on landing.

## Tests and evidence

- Backend unit tests: two axis plus modifier forwarding, notch math per axis, cap refusal, `scrollDelta` reporting. Extend the fixture at `apps/server/src/computer/CuaComputerBackend.test.ts:867`.
- Manager tests: macOS probe split, gearing learn from measured travel, wrong way travel suppressed, app fallback inheritance, observation budget caps (count captures and injections per request).
- Calibration tests: extend the suite around `apps/server/src/computer/scrollCalibration.ts:240` with macOS scale captures (Retina scale 2) and repetitive content alias refusal.
- Driver tests: patched `scroll_wheel_at_xy` posts X and Y ticks with flags on a harness, and refuses cleanly when the target is gone.
- Evidence: fixture run logs showing requested, injected, traveled, and gearing per leg for each app class, plus the latency of each leg. Runs on a signed app with fresh permissions are required before any claim of certified behavior.

## Risks

- AppKit smooth scrolling smears travel across frames. The settle delay may need per app tuning within the latency budget. Mitigation: keep the fixed settle default and record per leg timing in evidence.
- Correlator aliasing on repetitive content teaches wrong gearing. Mitigation: keep the absolute and distinct minimum bars, and drop wrong way samples.
- AX scroll actions may move different distances than wheel ticks in one app. Mitigation: separate gearing keys per route, never shared.
- Durable gearing can go stale when an app updates its toolkit. Mitigation: smoothing already adapts, and the file stores sample counts so old entries decay. Unverified claim: decay behavior is proposed, not yet designed in detail.
- Observation budget pressure on slow machines. Mitigation: hard caps on legs and captures, and best effort degradation to unmeasured delivery.

## Open decisions

- Exact tolerance percentages for travel assertions. Proposed 25 percent single request and 30 percent corrected large scroll, pending fixture data.
- Whether horizontal travel needs its own correlator or keeps sharing the vertical gearing. Proposed: keep sharing, since only vertical travel is measurable from row correlation.
- Exact durable file path and schema versioning. Proposed: beside control state, versioned envelope, pending implementer check.
- Whether AX scroll becomes the default first attempt for all targets or only for nodes that advertise the action. Proposed: only advertised nodes, to avoid surprising custom scrollers.

## Implementer brief

1. Read the scroll method at `apps/server/src/computer/CuaComputerBackend.ts:1198`, the macOS branch at `apps/server/src/computer/ComputerManager.ts:1736`, the estimator at `apps/server/src/computer/scrollCalibration.ts:240`, and the tool guard at `apps/server/src/agentGateway/computerTools.ts:2429`.
2. Extend the driver patch at `apps/desktop/patches/cua-driver/0001-synara-native.patch:4874` for two axis plus modifiers. Keep cancellation gating.
3. Wire the backend to forward both axes and modifiers, and to try AX scroll actions first when the target token supports them.
4. Remove the macOS measurement skip while adding the leg and capture budget caps.
5. Add the durable per app gearing fallback with bounded size and corrupt file tolerance.
6. Write the tests listed above first, then implement. Update the parity matrix scroll row at `docs/computer-use-cua/v2-parity-matrix.md:13` on landing.
7. Do not weaken any fail closed refusal. Do not replay uncertain scrolls. Do not exceed the observation budget.
