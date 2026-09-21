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
  AI, Inc (`docs/computer-use-cua/CUA-LICENSE.txt:1`, `:3`). Resolved
  2026-09-17: the root `package.json` now declares `"license": "MIT"` (`:4`),
  matching the LICENSE file and `apps/server/package.json:4` — the acceptance-3
  question is answered in the manifest.

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
- Verification: implemented per the safe default on 2026-09-17 — refuse all
  listed surfaces with no override in v1. `apps/server/src/computer/computerDenylist.ts`
  lists password managers (1Password, Bitwarden, Dashlane, LastPass) and macOS
  security surfaces (Keychain Access, Passwords.app, System Settings/System
  Preferences, SecurityAgent) matched by app name, bundle id, bundle-id prefix,
  executable path, and `pid <n>` consent key. Refusals carry the typed code
  `computer_denylist_refused`. Enforcement: admission (`ComputerManager.ts:539`,
  `:578`), direct window targeting, point and semantic resolution, keyboard
  aim, window mutations, app visibility, scoped reads (state, tree, verify,
  zoom), window/region captures, and post-action observation. `computer_list_windows`
  remains allowed for presence enumeration; content-bearing reads refuse. The
  pane's own input (no thread id) is exempt like the lease. Tests:
  `apps/server/src/computer/computerDenylist.test.ts` — 12 cases including
  bundle-id-only matching via pid resolution. Acceptance 12's live refusal run
  on one listed app is still required; the sandbox cannot produce it.

## 7. Audit log retention

- Recommendation: local only, bounded size, documented in the privacy note.
- Safe default: shortest retention that still supports abuse review, documented
  the same way.
- Verification: implemented per the recommendation on 2026-09-17 — local only,
  bounded, documented. `apps/server/src/computer/computerAuditLog.ts` appends
  one JSON line per mutating call to `computer-audit.jsonl` beside
  `computer-control.json` in the server state dir (wired at
  `Layers/ComputerService.ts:60`), capped at 10,000 entries and 2 MB with
  drop-oldest compaction, mode 0600 inside a 0700 directory, writes serialized
  on a private chain and flushed on `manager.dispose()`. Each record carries
  ISO timestamp, tool name, threadId/turnId, resolved target (window id, pid,
  app), a sanitized argument summary (payload keys become character/item
  counts — typed text and clipboard contents are never written), and the
  effect (`verified`/`dispatched-unknown`/`not-dispatched` from the delivery
  taxonomy, or `refused`/`error` with a code). Records are written at the
  gateway seam where the final effect is known (`computerTools.ts:1240`–`:1258`),
  never awaited, and writer failures are swallowed. A thread whose control is
  off records nothing — enforced at the manager seam (`ComputerManager.ts:601`
  –`:603`) so the kill switch cannot produce evidence rows. Tests:
  `apps/server/src/computer/computerAuditLog.test.ts` — 10 cases covering
  sanitization, caps/compaction, serialized appends, write-failure swallowing,
  and the disabled-writes-nothing rule. Acceptance 9's three-action
  completeness run still needs a live desktop. Raw recording and history
  surfaces stay internal until a privacy policy exists
  (`v2-parity-matrix.md:31`).
- Update (merged on `pr-1227`): a structured session-history sibling landed
  on the same posture — `apps/server/src/computer/computerRecording.ts`
  writes one bounded NDJSON session under `computer-recordings/` in the
  server state dir (2,000 steps / 4 MiB per session; 64 files / 32 MiB /
  7 days aggregate; 0600 in 0700; serialized writes, failures swallowed,
  disabled control records nothing). `redacted` fidelity keeps payload args
  as `{chars, sha256}`; `full` is an approval-gated opt-in that still keeps
  protected-field payloads hashed. `computer_replay` is dry-run by default,
  approval-gated, and re-resolves targets plus driven-app consent fresh per
  step — the "no silent replay of mutations" line holds. Raw driver
  recording stays internal; the privacy-policy gate applies to merge, same
  as it did to this audit log. Full contract:
  `docs/computer-use-cua/session-recording.md`.

## 8. Kill switch form

- Recommendation: visible stop control plus physical Escape handling.
- Safe default: visible stop control only, Escape as a fast follow.
- Verification: the composer turn stop is the always-visible stop affordance
  (`ComputerPreviewPopover.tsx:9`–`:10`; `ChatView.tsx:2771`,`:3297`). A
  dedicated stop-label helper exists (`ComputerPanel.logic.ts:379`–`:387`) but
  a rendered consumer was not found — v1 ships the visible stop only, per the
  safe default; no physical Escape tap was added. A physical emergency release
  exists only on KWin and Hyprland (`Meta+Shift+Esc`,
  `packages/contracts/src/computer.ts:179`,`:182`–`:185`). macOS has no global
  release (`ComputerPanel.logic.ts:371`–`:374`). The acceptance-10 latch is
  verified 2026-09-17: `setControlEnabled(false)` disables the thread in
  memory and bumps the durable generation before cleanup can yield
  (`ComputerManager.ts:830`–`:839`), cancels pending approval prompts through
  `computerApprovalGate.cancelThread`, aborts live authorities, calls
  `backend.stopInput()`, and releases the desktop lease; queued and in-flight
  calls refuse with `controlRevoked` and a request carrying a pre-stop
  generation can never re-arm control — regression-tested in
  `apps/server/src/computer/computerRevoke.test.ts` ("a stale generation
  cannot revive control after stop, and re-enable mints a fresh one"). The
  once-per-release live run remains required.

## 9. Locked use and history

- Recommendation: out of v1, per gap item 14, until safety and privacy decisions
  land.
- Safe default: out, with raw tools staying internal.
- Verification: locked operation does not exist; pause on lock does
  (`computerDesktopLifecycle.ts:26`–`:35`, `v2-parity-matrix.md:29`). Gap item
  14 targets Later (`v2-parity-matrix.md:54`). Acceptance 14 requires these
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
