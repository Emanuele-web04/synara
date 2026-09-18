# Open package file list — workstream F deliverable

This file list defines the proposed open package. It mirrors the Interfaces table
in `workstream-f-opensource-spec.md`. Every row was checked against the tree on
branch `pr-1227`. Rows marked verified exist at the cited path. This is a docs
deliverable: no file moves, no code changes, no new capabilities.
`extraction-plan.md` carries the component-level companion: what each piece is,
its extraction form, maintenance cost, and the recommended order.

The spec's control rule applies: anything not in the Interfaces table and not
listed in the spec's Approach section stays product code. A new file needs a
written addition to the table before it ships.

## Core table rows

| Interface        | File                                                       | Role                                                   | Verified in tree                                        |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Native patch     | `apps/desktop/patches/cua-driver/0001-synara-native.patch` | All Synara native changes on the pinned driver         | Yes                                                     |
| Pin manifest     | `packages/shared/src/cuaDriverRelease.json`                | Version, source, checksums, native revision, toolchain | Yes (`:2`–`:7`)                                         |
| Host protocol    | `packages/shared/src/cuaDriverProtocol.ts`                 | Socket, handshake, methods, cancellation, cleanup ack  | Yes, but partial coverage — see gap note below          |
| Desktop host     | `apps/desktop/src/cuaDriverHost.ts`                        | Child lifetime, generation retirement, allowlist       | Yes (allowlist at `:334`; `cancel_input` at `:805`)     |
| Lifecycle gates  | `apps/desktop/src/computerDesktopLifecycle.ts`             | Pause on lock, sleep, session resign                   | Yes (`:26`–`:35`)                                       |
| Approval gate    | `apps/server/src/computer/ComputerApprovalGate.ts`         | Consent rendezvous, queue caps                         | Yes (`:18`–`:19`)                                       |
| Tool surface     | `apps/server/src/agentGateway/computerTools.ts`            | Agent facing tools and approval routing                | Yes (30 `computer_*` tools; gated set at `:112`–`:145`) |
| Backend          | `apps/server/src/computer/CuaComputerBackend.ts`           | Targeting, geometry, effect semantics                  | Yes                                                     |
| Orchestration    | `apps/server/src/computer/ComputerManager.ts`              | Leases, scheduling, Space policy                       | Yes                                                     |
| Upstream license | `docs/computer-use-cua/CUA-LICENSE.txt`                    | Cua attribution, MIT text                              | Yes (`:1`, `:3`)                                        |
| Repo license     | `LICENSE`                                                  | Synara MIT text and holders                            | Yes (`:1`, `:3`–`:4`)                                   |
| Capability audit | `docs/computer-use-cua/capability-audit-2026-09-16.md`     | What is exposed and what is deliberately withheld      | Yes                                                     |
| Overview         | `docs/computer-use-cua/README.md`                          | Contracts, limits, setup, provenance                   | Yes                                                     |
| Provenance       | `docs/computer-use-cua/import-provenance.json`             | Imported heads and paths                               | Yes (`:9`)                                              |
| Parity matrix    | `docs/computer-use-cua/v2-parity-matrix.md`                | Parity claims, gaps, targets, evidence                 | Yes                                                     |

## Approach-section additions

The spec's Approach section names these as part of the package. They are not in
the Interfaces table. Each needs a written table addition before it ships.

| Item               | File or directory                                          | Verified in tree | Note                                                                                  |
| ------------------ | ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Patch notes        | `apps/desktop/patches/cua-driver/README.md`                | Yes              | Records the revision coupling rule and per-revision history.                          |
| Permission guide   | `docs/computer-use-cua/permission-guide.md`                | Yes              | Named in the Approach docs list.                                                      |
| Qualification      | `docs/computer-use-cua/qualification.md`                   | Yes              | Revision 1 evidence and limits.                                                       |
| Qualification base | `docs/computer-use-cua/qualification-upstream-baseline.md` | Yes              | Upstream baseline record.                                                             |
| Evidence ledgers   | `docs/computer-use-cua/evidence/`                          | Yes              | Existing evidence pattern; required runs for the open release are listed in the spec. |

## Dependency caveat — unverified

The listed source files import sibling files that are not in the table (for
example `computerGeometry.ts`, `uiTreeTargeting.ts`, `screenshotFrames.ts`,
`scrollUnits.ts`, `DesktopOperationQueue.ts` under `apps/server/src/computer/`,
and `packages/contracts` types). Whether the package compiles with only the
listed files plus their import closure is unverified. The import closure needs a
written audit before extraction. This is a file list only; no move is proposed.

## Protocol file gap — resolved 2026-09-17

Original finding (checked on `pr-1227`): the protocol file was 181 lines, named
no `cancel_input`, and carried no cleanup-acknowledgement shape — spec
acceptance criterion 6 unmet.

Current state (native revision 20): `packages/shared/src/cuaDriverProtocol.ts`
documents `metadata`, `cancel_input` and the four-field acknowledgement in its
protocol notes (`:13`–`:57`), types it as `CuaCleanupAcknowledgement` (`:213`),
and exports the strict acceptance predicate `cuaCleanupAcknowledged` (`:229`)
that `apps/desktop/src/cuaDriverHost.ts` `retire()` now calls (`:1169`). The
predicate is pinned by unit tests in `cuaDriverProtocol.test.ts`. Criterion 6's
documentation half is met; the auditor still verifies criterion 6 end-to-end
against a live `cancel_input` exchange at package time.

## Stays out

Per the spec and the parity matrix, these remain product code or internal
surfaces: raw session tools, raw recording tools, driver configuration, cursor
ownership, the `browser_*` family, locked use, and history surfaces
(`docs/computer-use-cua/capability-audit-2026-09-16.md` "Deliberately
constrained native tools"; `v2-parity-matrix.md:54`). Raw recording stays
internal until a privacy policy exists.
