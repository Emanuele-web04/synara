# Workstream F: open-source boundary and governance spec

## Problem

Kartik wants the computer use system to be open source. The line for what ships open is still undecided. Without a clear line, extraction work cannot start. A wrong line either leaks Synara product code or ships a package nobody can reuse. This spec sets the recommended line, the guardrails that must ship with the code, and the decisions Kartik still owns. Per handoff section 5.7 and item 2 of the decision shortlist in 11.3, the working recommendation is that the driver patch, host protocol, tool layer, and docs ship open under a permissive license while Synara product code stays as is.

## Current state

The tree already carries two licenses. The Synara repo is MIT, held by T3 Tools Inc and Emanuele Di Pietro (`LICENSE:1`, `LICENSE:3`). The Cua driver redistribution license is MIT, held by Cua AI Inc (`docs/computer-use-cua/CUA-LICENSE.txt:1`, `docs/computer-use-cua/CUA-LICENSE.txt:3`). The redistribution license is referenced from the computer use README (`docs/computer-use-cua/README.md:15`). A full read of `package.json:1` through the end of the file shows no license field, so the root manifest states no license of its own. This is unverified as a problem, but an auditor will flag it.

The shippable open core already exists as files. The native patch is checked in (`apps/desktop/patches/cua-driver/0001-synara-native.patch`, existence verified by glob). The pin manifest records driver 0.28.2, source commit, archive checksum, patch checksum, native revision 15, and Rust 1.97.1 (`packages/shared/src/cuaDriverRelease.json:2`, `packages/shared/src/cuaDriverRelease.json:5`). The host protocol contract lives beside it (`packages/shared/src/cuaDriverProtocol.ts`, existence verified by glob). The tool layer is the provider gateway plus the server computer stack. The docs corpus is `docs/computer-use-cua/` with provenance records (`docs/computer-use-cua/import-provenance.json:9`).

Synara product code is the rest. That means the provider gateway wiring, account and billing paths, the Synara chat UI and stores, updater and release machinery, and anything outside the computer use seam. None of that is proposed for the open package.

The release path today publishes signed first party artifacts. Tag pushes matching `v*.*.*` trigger the release workflow (`.github/workflows/release.yml:4`). Manual dispatch defaults to build only with no publication (`.github/workflows/release.yml:13`, `docs/release.md:7`). Published macOS artifacts must be signed (`docs/release.md:24`). Windows publication uses an explicit version scoped unsigned exception, else Azure signing is required (`docs/release.md:24`). The workflow builds macOS DMGs, a Linux AppImage, and a Windows installer (`.github/workflows/release.yml:170`, `.github/workflows/release.yml:180`, `.github/workflows/release.yml:185`). CLI publication is optional and off unless enabled (`docs/release.md:89`). Whether the open package would reuse this workflow or get its own is unverified and left as an open decision.

Guardrails exist in part. Control is disabled by default for new conversations (`docs/computer-use-cua/README.md:46`). Foreground operations always need explicit per action approval (`docs/computer-use-cua/README.md:52`). The approval gate caps pending consent at 128 global and 8 per thread (`apps/server/src/computer/ComputerApprovalGate.ts:18`). The desktop pauses input on screen lock, sleep, and session resign (`apps/desktop/src/computerDesktopLifecycle.ts:27`). Raw session tools, raw recording tools, driver configuration, cursor ownership, and the browser family are deliberately not agent facing; `invoke_menu`, `set_window_frame`, `verify_state`, `list_apps`, `zoom`, and `kill_app` became agent-facing on 2026-09-17 under per-action approval and Synara-side read-back (`docs/computer-use-cua/capability-audit-2026-09-16.md` "2026-09-17 update"). The README states the local capability is a boundary against accidental authority inheritance, not a sandbox against same user malware (`docs/computer-use-cua/README.md:54`). A regulator style audit log, a user visible kill switch, a password manager denylist, and per app always allow rules are unverified in the tree. This spec treats them as build items, not as present facts.

## Approach

Ship one open package under a permissive license. Keep Synara product code out of it.

The open package contains four parts. First, the driver patch plus its pin manifest and patch notes. Second, the host protocol: socket framing, capability check, handshake, methods, cancellation protocol, and cleanup acknowledgement semantics. Third, the tool layer contract: the agent facing tool list, targeting and approval semantics, effect taxonomy (`not-dispatched`, `dispatched-unknown`, `verified`), and the Space and freshness refusal rules. Fourth, the docs: README, permission guide, capability audit, qualification records, and evidence ledgers.

License the package MIT or Apache 2.0. MIT matches both parent licenses already in the tree. Keep `CUA-LICENSE.txt` attribution in every copy. Record the Synara side as MIT too, with its current holders. The exact pick is an open decision below.

For trycua/cua fixes, use two paths. Small general fixes go upstream as contributions to trycua/cua where they stand alone. The Synara native patch stays a checked in patch file with a pin manifest, as today. Never fork silently. When a fix lands upstream, rebase the patch and record it the way revision 15 is recorded. Which fixes go upstream first is per case and needs maintainer review on the Synara side before sending.

These guardrails ship WITH the code, not after it. Visible session state: the user always sees when an agent session is active and which app it targets. Per app approvals: allow, always allow, and deny, with launch approvals. Denylist: password managers and similar sensitive surfaces are refused or need explicit per step consent. Audit log: every mutating action is recorded with target, time, and effect. Kill switch: one action stops all agent input immediately, including physical Escape where the platform allows it. No evasion: no anti detection tricks, no hidden operation, no masking that hides activity from the user. No TCC bypass: the package never routes around Accessibility or Screen Recording consent, and protected prompts stay synthetic input free. Disclosure process: if a consent bypass class bug is ever found, it is reported through a documented channel, fixed first, and disclosed after the fix ships.

Where the tree stands on each guardrail today: per action approval exists, always allow does not, and the matrix flags that as a safety tradeoff needing a decision (`docs/computer-use-cua/v2-parity-matrix.md:27`). Pause on lock exists, operation while locked does not. The audit log, kill switch UI, and denylist are build items. No guardrail may be cut to hit a date. A missing guardrail blocks the open release.

This spec agrees with gap item 14 of the parity matrix. Locked use and history stay out of the first open milestone (`docs/computer-use-cua/v2-parity-matrix.md:54`). Raw recording tools stay internal until a privacy policy exists (`docs/computer-use-cua/capability-audit-2026-09-16.md:28`, `docs/computer-use-cua/v2-parity-matrix.md:31`). No recording or history surface ships open before that policy lands.

The malware risk conclusion is carried per handoff section 5.7 and is unverified by this spec author. The stated conclusion: this capability class has been public for a decade, the abuse bottleneck is TCC consent plus distribution, neither is changed by this code, so the marginal risk of open sourcing is low, and the design still resists misuse. Do not cite this as a proven fact. Treat it as a per handoff claim that a reviewer must still check.

## Interfaces

The open package is defined by files, not by prose. An auditor checks each row.

| Interface        | File                                                       | Role                                                   |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Native patch     | `apps/desktop/patches/cua-driver/0001-synara-native.patch` | All Synara native changes on the pinned driver         |
| Pin manifest     | `packages/shared/src/cuaDriverRelease.json`                | Version, source, checksums, native revision, toolchain |
| Host protocol    | `packages/shared/src/cuaDriverProtocol.ts`                 | Socket, handshake, methods, cancellation, cleanup ack  |
| Desktop host     | `apps/desktop/src/cuaDriverHost.ts`                        | Child lifetime, generation retirement, allowlist       |
| Lifecycle gates  | `apps/desktop/src/computerDesktopLifecycle.ts`             | Pause on lock, sleep, session resign                   |
| Approval gate    | `apps/server/src/computer/ComputerApprovalGate.ts`         | Consent rendezvous, queue caps                         |
| Tool surface     | `apps/server/src/agentGateway/computerTools.ts`            | Agent facing tools and approval routing                |
| Backend          | `apps/server/src/computer/CuaComputerBackend.ts`           | Targeting, geometry, effect semantics                  |
| Orchestration    | `apps/server/src/computer/ComputerManager.ts`              | Leases, scheduling, Space policy                       |
| Upstream license | `docs/computer-use-cua/CUA-LICENSE.txt`                    | Cua attribution, MIT text                              |
| Repo license     | `LICENSE`                                                  | Synara MIT text and holders                            |
| Capability audit | `docs/computer-use-cua/capability-audit-2026-09-16.md`     | What is exposed and what is deliberately withheld      |
| Overview         | `docs/computer-use-cua/README.md`                          | Contracts, limits, setup, provenance                   |
| Provenance       | `docs/computer-use-cua/import-provenance.json`             | Imported heads and paths                               |
| Parity matrix    | `docs/computer-use-cua/v2-parity-matrix.md`                | Parity claims, gaps, targets, evidence                 |

Anything not in this table and not listed in the Approach section stays product code. If a new file is needed for the open package, add it to this table first.

## Acceptance criteria

An auditor can verify each item file by file. All items must pass before the open release.

1. `CUA-LICENSE.txt` ships in the package with Cua AI attribution intact.
2. The package license file names MIT or Apache 2.0, and every source file header or notice matches it.
3. The root `package.json` license question is resolved: either a license field is added or a written note explains why it stays absent.
4. The patch applies to a pristine checkout of the pinned source commit and reproduces the tree byte for byte.
5. The pin manifest version, source, checksums, native revision, and toolchain match the actual patch and the built binary report.
6. The protocol file documents every method the host accepts, including `cancel_input`, the ack fields, and the refusal taxonomy.
7. The tool list in the package matches the audited surface. No raw session, raw recording, menu, or window frame tool is reachable by an agent.
8. Every mutating tool documents its approval requirement, its targeting rule, and its effect values.
9. The audit log records every mutating action with target identity, timestamp, and effect. The auditor runs three actions and finds three entries.
10. The kill switch stops in flight input and blocks new input until the user re enables it. The auditor tests it once per release.
11. Session state is visible during any active run: target app, active versus paused, and how to stop it.
12. The denylist refuses or escalates password manager surfaces. The auditor tests one listed app and sees the refusal.
13. No code path requests, scripts, or documents a TCC bypass. The string scan for bypass helpers is clean and recorded.
14. Locked use and history surfaces are absent from the package, matching gap item 14.
15. The disclosure process exists as a file: where to report, fix first timelines, and how disclosure ships.
16. Upstream versus own repo placement is decided in writing, with contribution rules for trycua/cua fixes.
17. The malware risk claim is either verified by a reviewer or labeled per handoff in the release notes. It is never stated as proven without evidence.

## Tests and evidence

License checks run in CI. Assert `CUA-LICENSE.txt` exists with the MIT text and the Cua AI line. Assert the package license file exists and matches the chosen license. Assert the `package.json` license question has a recorded answer. These are static file tests. They need no permissions and run in the sandbox.

Provenance checks run in CI. Assert the patch sha equals the manifest `patchSha256`. Assert the upstream archive sha equals the manifest `sha256`. Assert the native revision literal in the driver source equals the manifest `nativeRevision`. The manifest values are read from `packages/shared/src/cuaDriverRelease.json:2` onward, and the patch notes record the coupling rule.

Surface checks run in CI. Assert the agent facing tool list equals the allowlist. Assert raw session tools, raw recording tools, driver configuration, cursor ownership, and the browser family are unreachable. (`invoke_menu`, `set_window_frame`, and `verify_state` became agent-facing on 2026-09-17 — see the audit's update section.) The audit is the source of truth for intent (`docs/computer-use-cua/capability-audit-2026-09-16.md:22`). The tool list is the source of truth for fact.

Behavioral evidence needs a signed app with fresh macOS grants, so it is Tier 3 or higher and cannot run in the agent sandbox. Required runs before the open release: three concurrent background targets while the human uses a fourth app, one kill switch run, one denylist refusal run, one lock screen pause run, and one audit log completeness run. Save evidence JSON plus before and after images under `docs/computer-use-cua/evidence/` in the existing pattern. Source checks never substitute for these runs.

## Risks

Private API drift can break the driver on a macOS update. The 26.4 argument order hazard is the known example. Keep availability flags, version gates, and fail closed fallbacks on every private path. Run the canary probe before any OS bump. This risk is per handoff and matches the tree history.

TCC identity churn can strand grants. Grants attach to the signed bundle. Ad hoc rebuilds change identity. Keep the helper signing identity stable and keep the stale grant guidance current.

A bypass class bug would be severe in an open release. The disclosure file plus fix first policy bounds this, but only if the channel is monitored. Name an owner before release.

Overbroad extraction leaks product code. The Interfaces table is the control. Anything outside the table needs a written addition before it ships.

Under scoped extraction ships an unusable package. The acceptance runs catch this: if the three target run fails with only open files, the seam is wrong and must move before release.

Distribution is the abuse bottleneck B, per the handoff malware conclusion. Open sourcing changes distribution by definition. The per handoff claim says marginal risk is low. This spec does not verify that claim. A reviewer must still weigh it before release.

## Open decisions

Kartik decides the boundary. Each item has a recommendation and a safe default. Silence means the safe default.

1. What ships. Recommendation: driver patch, host protocol, tool layer, docs. Safe default: ship nothing until this is confirmed in writing.
2. Where it lives. Recommendation: its own repo under a permissive license, with general fixes contributed upstream to trycua/cua. Safe default: stay in tree with no extraction and no upstream sends.
3. Which license. Recommendation: MIT, matching both parent licenses. Safe default: MIT, since Apache 2.0 adds patent text nobody has reviewed here.
4. Upstream fix flow. Recommendation: general fixes go upstream first, then rebase the patch. Safe default: patch only, no upstream sends, until a maintainer owns the flow.
5. Per app always allow. Recommendation: build it with explicit user consent per app, revocable in one place. Safe default: keep per action approval only, no always allow.
6. Denylist scope. Recommendation: password managers plus system security surfaces, refused or per step consent. Safe default: refuse all listed surfaces with no override in v1.
7. Audit log retention. Recommendation: local only, bounded size, documented in the privacy note. Safe default: shortest retention that still supports abuse review, documented the same way.
8. Kill switch form. Recommendation: visible stop control plus physical Escape handling. Safe default: visible stop control only, Escape as a fast follow.
9. Locked use and history. Recommendation: out of v1, per gap item 14, until safety and privacy decisions land. Safe default: out, with raw tools staying internal.
10. Release reuse. Recommendation: decide whether the open package reuses the Synara release workflow or gets its own signed pipeline. Safe default: no open binaries until signing and provenance for the new repo are proven. Docs and source only.

## Implementer brief

Scope: produce the extraction plan and the guardrail build list. No code changes in this task. No new capabilities. No bypasses.

Read first: handoff sections 5.7 and 11.3 item 2 (per handoff source), then `docs/computer-use-cua/README.md:1` through `docs/computer-use-cua/README.md:76` for contracts and limits, then `docs/computer-use-cua/capability-audit-2026-09-16.md:1` through `docs/computer-use-cua/capability-audit-2026-09-16.md:38` for the exposure line, then `docs/computer-use-cua/v2-parity-matrix.md:29` through `docs/computer-use-cua/v2-parity-matrix.md:54` for locked use and history, then `docs/release.md:5` through `docs/release.md:27` for the signed versus unsigned policy.

Deliver: a file list for the open package matching the Interfaces table, a guardrail gap list naming what exists versus what must be built, a draft disclosure file, and a decision sheet for the ten open decisions with the recommendation and safe default for each. Mark every claim you could not verify as unverified. Keep sentences short and plain. Propose no code, no bypasses, no new capabilities.

Done proof: this spec passes the doc checker with all nine headings, the gate lint passes, every file claim carries a valid `path:line` cite, and the report back quotes both check outputs plus lists every unverified claim.
