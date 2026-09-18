# Open-source extraction plan — computer-use/Cua stack

Assessment of what in the computer-use stack can ship outside the Synara
repository, what can go back upstream to `trycua/cua`, and what must stay
internal. Companion to `workstream-f-opensource-spec.md` (the boundary and
governance spec) and `open-package-file-list.md` (the proposed package file
list). This document is the component-level engineering view: what each piece
is, where it lives, what form its extraction takes, and what it costs to
maintain.

State recorded at native revision 20, driver `0.28.2` / `fc188250`
(`packages/shared/src/cuaDriverRelease.json`).

## Upstream license and PR-back feasibility

**License.** cua-driver is MIT, Copyright (c) 2025 Cua AI, Inc. — the workspace
manifest declares `license = "MIT"`
(`cua-src:libs/cua-driver/rust/Cargo.toml`) and the verbatim license text is
preserved at `docs/computer-use-cua/CUA-LICENSE.txt`. The Synara repository is
also MIT (LICENSE, T3 Tools Inc and Emanuele Di Pietro). There is no license
barrier in either direction: MIT permits vendoring the driver with patches,
publishing derived patches, and contributing changes back.

**Source checkout.** `/Users/devin/repos/cua-src` is a sparse mirror filtered
to `libs/cua-driver`, pinned at upstream `fc188250b` (0.28.2), remote proxied
to `github.com/trycua/cua`. The filtered tree carries no CONTRIBUTING or CLA
file — confirm upstream's contribution terms on GitHub before opening PRs, and
check whether a CLA bot gates external commits.

**Upstream appetite.** Upstream demonstrably lands macOS input-delivery
changes: the revision-15 rebase notes record inherited upstream PRs #2907
(click-delivery split), #3704 (cursor-overlay exclusion), #3687
(embedded-host build fix), #3616 (snapshot identity rework) and #3404
(`apps/desktop/patches/cua-driver/README.md`). The driver is upstream's
product too — fixes that make it more correct under a supervising host are
plausible contributions.

**Policy (workstream F, owner decision).** Small standalone fixes go upstream
as ordinary contributions. The Synara native patch stays a checked-in patch
file with a pin manifest — never a silent fork. When a fix lands upstream, the
patch is rebased and the rebase is recorded the way revision 15 is. Every
upstream send needs Synara-side maintainer review first.

## Extractable components

Form legend: **upstream PR** (contribute to trycua/cua), **package module**
(ships in the open package as a library file), **reference implementation**
(ships as documented example code, product seams injected), **artifact**
(already a self-contained shippable file), **stays internal**.

| #   | Component                                                                                                                              | Where                                                                                                                                                                                                                                                                                                                                       | Form                                                                                                                                                                                                                                                                                                           | Maintenance cost                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Host wire protocol: bounded transport, effect taxonomy, `cancel_input` + cleanup ack, tool allowlists                                  | `packages/shared/src/cuaDriverProtocol.ts`                                                                                                                                                                                                                                                                                                  | **package module** — already a leaf (imports only `node:net` + the release manifest)                                                                                                                                                                                                                           | Low: changes only on protocol revisions                                                                                                                                        |
| 2   | `cancel_input` lifecycle: generation handshake, retirement, held-input release fallback, orphan sweep                                  | `apps/desktop/src/cuaDriverHost.ts` (`retire` :1115, `terminate` :1093, `sweepOrphanedCuaDrivers` :158, handshake :996)                                                                                                                                                                                                                     | **reference implementation** — product seams already constructor-injected (`releaseHeldInput`, `checkPermissions`, `frameTap`); needs frameTap/desktop-epoch/browser-label extraction                                                                                                                          | Medium-high: the file is 1,417 lines of intertwined policy                                                                                                                     |
| 3   | Native cancellation core: input-admission gate, release-on-unwind, daemon `cancel_input`, cleanup ack                                  | `0001-synara-native.patch` hunks in `input/cancellation.rs`, `serve.rs`, `keyboard.rs`, `mouse.rs`                                                                                                                                                                                                                                          | **stays a patch** — architectural, Synara-specific auth model (authenticated embedded parent + exact child PID); upstreaming is a design negotiation, not a PR                                                                                                                                                 | Recurring rebase cost per upstream release                                                                                                                                     |
| 4   | AX exact-range text selection (`select_text`, rev 20)                                                                                  | the `select_text` hunks inside `0001-synara-native.patch` (new `tools/select_text.rs` ~380 lines + 11 registration hunks; formerly standalone `0002-select-text.patch`, folded during the `7fe7c33f` rebase); TS glue `CuaComputerBackend.selectText` :1684, `ComputerManager.selectText` :3028, contracts `COMPUTER_SELECT_TEXT_RANGE_MAX` | **upstream PR** for the Rust tool — self-contained modulo `ActionResult`/registry plumbing; TS glue is thin and stays with the backend contract                                                                                                                                                                | Low-medium: bounded new tool; registry rows are the friction                                                                                                                   |
| 5   | Settle observation (`wait_for_settle`, rev 18)                                                                                         | `0001` patch `tools/wait_for_settle.rs` (~515 lines); `CuaComputerBackend.waitForSettle` :792, `ComputerManager.waitForSettle` :1224 + `settleAfterAction` :1389 (observer→fixed fallback, sticky "unsupported"), `computer_wait settle:true` (`computerTools.ts` :2483)                                                                    | **upstream PR** for the AXObserver tool — read-only, no input admission, attractive standalone; the fallback policy is Synara's                                                                                                                                                                                | Low-medium                                                                                                                                                                     |
| 6   | Background-input boundary: delivery-mode scoping, exclusive/scoped concurrency, per-window semantic lanes, observation-budget env vars | `DesktopOperationQueue.ts` (whole file), `semanticTextInLane` (`CuaComputerBackend.ts` :1140, constants :136), host env `SYNARA_CUA_*_OBSERVATION_MS` (`cuaDriverHost.ts` :943-949), native `background_input.rs`/`background_mutation.rs` gate                                                                                             | Mixed: the **policy stays Synara's**; `DesktopOperationQueue` is a generic writer-barrier/ keyed-reader primitive extractable to `packages/shared` (only dep is `ComputerBackendError` — needs an injected error ctor); the env-var knobs are already in the patch and could be upstreamed as documented flags | Medium: concurrency invariants carry real test weight (`DesktopOperationQueue.test.ts`, 259 lines)                                                                             |
| 7   | The native patch set itself                                                                                                            | `apps/desktop/patches/cua-driver/` (`0001` 10,072 lines / 44 file-hunks, `0002` 754 / 12, README, `native-keymap.diff` + notes), `cuaDriverRelease.json`, `apps/desktop/scripts/provision-cua-driver.mjs`                                                                                                                                   | **artifact** — already the extraction unit: patch + pin manifest + provision script + revision notes                                                                                                                                                                                                           | Medium, predictable: rebase per upstream release (rev-15 precedent), `synara_native_revision` literal and `patchSha256` must move together (README documents the failure mode) |
| 8   | Smaller native diffs with standalone value                                                                                             | rev-8/9 orphan reaping (host-PID liveness poll; `catch_unwind` → `exit(0)`), rev-19 xdotool keymap vocabulary, rev-6/7 AX multi-attribute batch + bounded parallel fetch                                                                                                                                                                    | **upstream PR candidates** — genuine bug fixes and a self-contained keymap; the strongest first sends                                                                                                                                                                                                          | Low per PR                                                                                                                                                                     |
| 9   | Qualification fixtures                                                                                                                 | `apps/desktop/src/cuaFixtures/` (cancellation, electron, focusProbe, gateway, live, native), `scripts/computer-use-fixtures/`                                                                                                                                                                                                               | **package module** candidate — owned-target fixture harness is what makes the patch's claims auditable; `gateway.ts` wires Synara provider context and needs a seam                                                                                                                                            | Medium                                                                                                                                                                         |
| 10  | Generic helpers                                                                                                                        | `utf8Truncation.ts` (pure), `computerGeometry.ts`, `scrollUnits.ts`, `screenshotFrames.ts` (frame→desktop mapping), `waitForWindow.ts`/`waitForControl.ts`                                                                                                                                                                                  | **package module** if the package includes a backend contract; otherwise they ride with `ComputerBackend.ts`                                                                                                                                                                                                   | Low                                                                                                                                                                            |

## What stays Synara-internal

The product policy plane. Mechanism may ship; these decisions, tables and
ownership semantics do not.

- **Approval** — `ComputerApprovalGate.ts` (consent rendezvous on
  `ProviderApprovalDecision`, per-thread/turn grants, publish-to-card
  callback), `COMPUTER_APPROVAL_REQUIRED_TOOLS` (`computerTools.ts` :120),
  `PROVIDERS_WITHOUT_APPROVAL_GATE` (`approvalGate.ts`). The _requirement_
  that mutating tools need consent is a documented open-package guardrail;
  the rendezvous into Synara's approval UI is product.
- **Denylist** — `computerDenylist.ts`: the bundle-id/name list (1Password,
  Keychain, Bitwarden, Dashlane, security agents) and the no-override stance.
  A package may ship the matcher shape with an empty or sample list; the
  policy content is Synara's call and stays current only with the product.
- **Audit log** — `computerAuditLog.ts`: append-only bounded JSONL beside
  `computer-control.json`, argument summarization that never records typed
  text or clipboard payloads. Evidence policy, not mechanism.
- **Kill switch / durable control** — `ComputerControlState.ts` and the
  revoke path (`computerRevoke.test.ts` covers the semantics): per-thread
  disable with frozen generations so a rapid off/on cannot revive queued
  authority.
- **Thread ownership and attribution** — `computerTaskContext.ts`,
  `CuaComputerTask` (`threadId`/`turnId`), `agentSessionLabel` /
  `browserSessionLabel` minting (`cuaDriverHost.ts` :90-119), the turn lease
  and denylist/audit/approval orchestration inside `ComputerManager.ts`
  (4,625 lines), `Layers/ComputerLeaseReactor.ts`, `wsComputerHandlers.ts`,
  the `agentGateway` wiring, and `packages/contracts` schemas. This is the
  product's spine; extracting it is a rewrite, not a move.
- **Desktop lifecycle gates** — `computerDesktopLifecycle.ts`: the
  powerMonitor→pause mapping is 35 generic lines, but what it plugs into
  (`pauseDesktop`/`resumeDesktop`, `desktopObservationRequired`) is the
  host's product policy. Borderline; ship the mechanism inside the reference
  host, keep the wiring internal.
- **Browser family** — `CUA_BROWSER_TOOLS`, browser lifecycle sessions, the
  desktop `browser*` managers. A separate consent model, already excluded
  from the desktop allowlists; out of the first milestone regardless.
- **Recording/history surfaces** — `start_recording`, `replay_trajectory`,
  `history_*`. Held internal until a privacy policy exists (parity-matrix
  gap 14, workstream-F acceptance criterion 14).
- **Preview transport** — `computerFrameTap.ts`, `stillFramePublisher.ts`,
  `screenshotFrames.ts` route/publish side. Product UX.
- **Permission/setup policy** — `computerSetupSignal.ts`,
  `packages/shared/src/computerGrants.ts`, the AppSnap permission helper
  path: which grants are requested, when, and how the setup card surfaces.

## Reconciliation with workstream F

The spec's Interfaces table proposes shipping the tool layer
(`computerTools.ts`), approval gate, manager and backend as package
interfaces. This plan draws a narrower first milestone — the driver-facing
stack (patch, pin, protocol, reference host, fixtures, docs) — and treats the
agent-facing tool layer as a decision-gated phase 4, because shipping it
runnable pulls in `packages/contracts`, the Effect runtime, the provider
capability model and the approval UI seam. The two positions are compatible:
the spec defines the _outer_ boundary and its guardrail requirements; this
plan sequences toward it. **Decision D1 (Kartik):** confirm whether the first
open milestone is the driver-facing stack only, or the full tool layer.

## Recommended order

- **Phase 0 — protocol completeness (done, this change).**
  `CuaCleanupAcknowledgement` + `cuaCleanupAcknowledged` moved into
  `packages/shared/src/cuaDriverProtocol.ts`; `cuaDriverHost.ts` consumes the
  shared predicate; unit tests pin the four-field gate. Closes the
  `open-package-file-list.md` "protocol file gap" for criterion 6.
- **Phase 1 — upstream leaf fixes.** Send the smallest standalone diffs
  first to establish the relationship and shrink the patch: rev-19 keymap
  vocabulary, rev-8/9 orphan/liveness reaping, rev-6/7 AX fetch batching.
  Each is one bounded diff with an upstream-shaped motivation.
- **Phase 2 — upstream new tools.** `wait_for_settle` then `select_text` as
  new-tool PRs (registry + tool + tests). Order after phase 1 so the same
  files' context is stable. If upstream declines, they remain patch revisions
  — the patch is the fallback artifact, not a fork.
- **Phase 3 — package the driver-facing stack.** Patch set + pin manifest +
  provision script + protocol module + reference host (cuaDriverHost with
  product seams injected) + fixtures + the docs corpus. Gate on the
  workstream-F acceptance criteria (license files, guardrails, audit, kill
  switch, denylist behavior, disclosure process).
- **Phase 4 — tool layer (decision-gated on D1).** If the broader line is
  chosen: extract the effect-taxonomy/refusal-semantics contract document
  first, then assess `computerTools.ts`/`ComputerManager.ts` against the
  contracts+Effect dependency wall. Expect a split: mechanism out, policy
  in.
- **Never.** Denylist content, audit policy, thread/turn ownership, cursor
  attribution labels, provider approval wiring, browser family, recording
  surfaces.

## Verification status of this assessment

Verified in-tree this session: license texts and Cargo license fields; the
sparse checkout pin and remote; all cited file paths and line numbers; the
patch hunk inventory (44 + 12 file-hunks); the shared protocol module's
dependency-freeness (now including `cuaCleanupAcknowledged`, covered by 14
passing tests and the 57 `cuaDriverHost` retirement/cancellation tests).

Asserted, not verified: upstream's current contribution terms and any CLA
(filtered checkout carries none); upstream's willingness on each named PR
candidate — appetite is inferred from the five upstream PRs the rev-15 rebase
inherited, not from maintainer contact. The malware-risk premise behind open
sourcing the stack at all is carried per handoff §5.7 and remains a claim a
reviewer must check, per the spec.
