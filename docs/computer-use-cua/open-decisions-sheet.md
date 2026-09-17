# Open decisions sheet — workstream F deliverable

The ten open decisions from `workstream-f-opensource-spec.md`, each with the
spec's recommendation and safe default. Kartik decides. Silence means the safe
default. Verification notes record what was checked in the tree on branch
`pr-1227`; anything not checked is marked unverified.

## 1. What ships

- Recommendation: driver patch, host protocol, tool layer, docs.
- Safe default: ship nothing until this is confirmed in writing.
- Verification: all fifteen Interfaces-table rows exist in the tree — see
  `open-package-file-list.md`. The import closure of the listed files is
  unverified and needs a written audit before extraction.

## 2. Where it lives

- Recommendation: its own repo under a permissive license, with general fixes
  contributed upstream to trycua/cua.
- Safe default: stay in tree with no extraction and no upstream sends.
- Verification: no separate repo or upstream fork exists today — unverified
  beyond this checkout.

## 3. Which license

- Recommendation: MIT, matching both parent licenses.
- Safe default: MIT, since Apache 2.0 adds patent text nobody has reviewed here.
- Verification: Synara repo is MIT, held by T3 Tools Inc and Emanuele Di Pietro
  (`LICENSE:1`, `:3`–`:4`). The Cua redistribution license is MIT, held by Cua
  AI, Inc (`docs/computer-use-cua/CUA-LICENSE.txt:1`, `:3`). The root
  `package.json` has no license field — verified by reading the manifest;
  `apps/server/package.json:4` declares MIT. The missing root field needs a
  recorded answer per acceptance criterion 3.

## 4. Upstream fix flow

- Recommendation: general fixes go upstream first, then rebase the patch.
- Safe default: patch only, no upstream sends, until a maintainer owns the flow.
- Verification: the patch-plus-manifest pattern exists today
  (`apps/desktop/patches/cua-driver/0001-synara-native.patch`,
  `packages/shared/src/cuaDriverRelease.json:5`–`:6`, native revision 15). No
  upstream send process exists — unverified; none found in docs.

## 5. Per app always allow

- Recommendation: build it with explicit user consent per app, revocable in one
  place.
- Safe default: keep per action approval only, no always allow.
- Verification: per action approval exists (`computerTools.ts:112`–`:145`).
  Per-app always allow does not (`v2-parity-matrix.md:27`). A session-scoped
  provider-level "Always allow" exists (`ClaudeAdapter.ts:347`,
  `ComposerPendingApprovalPanel.tsx:55`); it is not a per-app computer rule.
  The matrix flags this as a safety tradeoff needing an explicit decision.

## 6. Denylist scope

- Recommendation: password managers plus system security surfaces, refused or
  per step consent.
- Safe default: refuse all listed surfaces with no override in v1.
- Verification: no denylist exists in the computer stack — scan-only negative,
  unverified beyond the scan. Acceptance 12 requires a refusal run on one
  listed app.

## 7. Audit log retention

- Recommendation: local only, bounded size, documented in the privacy note.
- Safe default: shortest retention that still supports abuse review, documented
  the same way.
- Verification: no audit log exists — scan-only negative, unverified beyond the
  scan. Acceptance 9 requires target, timestamp, and effect per mutating action.
  Raw recording and history surfaces stay internal until a privacy policy
  exists (`v2-parity-matrix.md:31`).

## 8. Kill switch form

- Recommendation: visible stop control plus physical Escape handling.
- Safe default: visible stop control only, Escape as a fast follow.
- Verification: the composer turn stop is the always-visible stop affordance
  (`ComputerPreviewPopover.tsx:9`–`:10`; `ChatView.tsx:2771`,`:3297`). A
  dedicated stop-label helper exists (`ComputerPanel.logic.ts:379`–`:387`) but
  a rendered consumer was not found — surfacing is unverified. A physical
  emergency release exists only on KWin and Hyprland (`Meta+Shift+Esc`,
  `packages/contracts/src/computer.ts:179`,`:182`–`:185`). macOS has no global
  release (`ComputerPanel.logic.ts:371`–`:374`). Acceptance 10 requires
  stopping in-flight input and blocking new input until re-enabled.

## 9. Locked use and history

- Recommendation: out of v1, per gap item 14, until safety and privacy decisions
  land.
- Safe default: out, with raw tools staying internal.
- Verification: locked operation does not exist; pause on lock does
  (`computerDesktopLifecycle.ts:26`–`:35`, `v2-parity-matrix.md:29`). Gap item
  14 targets Later (`v2-parity-matrix.md:52`). Acceptance 14 requires these
  surfaces absent from the package.

## 10. Release reuse

- Recommendation: decide whether the open package reuses the Synara release
  workflow or gets its own signed pipeline.
- Safe default: no open binaries until signing and provenance for the new repo
  are proven. Docs and source only.
- Verification: tag pushes matching `v*.*.*` trigger the release workflow
  (`.github/workflows/release.yml:4`–`:6`); manual dispatch defaults to build
  only (`docs/release.md:8`). Published macOS artifacts must be signed
  (`docs/release.md:24`); Windows uses an explicit version-scoped unsigned
  exception else Azure signing (`docs/release.md:24`–`:27`,`:138`–`:144`). CLI
  publication is optional and off unless enabled (`docs/release.md:87`–`:89`).
  Whether the open package reuses this workflow is undecided — per spec, an
  open decision.

## Cross-cutting

- The malware-risk conclusion stays labeled per handoff, never stated as proven
  (acceptance 17). Source: `workstream-f-opensource-spec.md` Approach, and
  handoff `synara-cu-v2-mega-handoff-2026-09-16.md` section 5.7. Unverified by
  this deliverable.
- The disclosure channel and owner are placeholders in
  `security-disclosure-draft.md`. An unmonitored channel is a release blocker
  per the spec's Risks section.
