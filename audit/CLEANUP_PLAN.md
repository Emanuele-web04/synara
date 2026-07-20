# Synara Cleanup Audit and Execution Plan

> Generated: 2026-07-19
> Status: implementation complete — focused verification passed; heavyweight workspace checks not authorized
> Scope: monolith decomposition, duplicated logic/views/CSS/functions, unused files/imports
> Source of truth: this file only; no per-file cleanup documents

## Objective and boundaries

Refactor the existing code incrementally so the largest multi-responsibility modules have tested,
cohesive boundaries; repeated knowledge has one domain owner; duplicate views/styles/functions are
consolidated; and dead files/imports are deleted. Preserve public behavior and existing service/store
facades while callers migrate. File count and line reduction are diagnostics, never success metrics:
an extraction is accepted only when it creates a stable responsibility owner, reduces coupling or
subscription/lifecycle scope, or makes behavior independently testable without prop-drilling or a
relocated controller parameter list.

Explicitly out of scope:

- product features, visual redesigns, performance work, protocol changes, schema migrations, and bug
  fixes unrelated to a refactor
- splitting files only to meet a line-count target
- moving cohesive JSX/logic without reducing coupling, cognitive load, or runtime work
- changing render/subscription/event/streaming/scroll/IPC/persistence semantics as cleanup collateral
- generic `utils`, universal provider bases, one-implementation interfaces, or wrapper-only moves
- generated output, dependencies, build output, vendored assets, and immutable migration DDL
- the optional AGENTS/README/500-LOC-policy hygiene pass unless the user approves it later

## Orientation and scan coverage

- Stack: TypeScript/Bun monorepo; React/Vite web app; Effect-based server; Electron desktop; Astro
  marketing site; Vitest tests; Oxlint/Oxfmt/Turbo workspace tooling.
- Architecture: schema-only contracts, shared runtime utilities with explicit subpath exports, server
  service contracts plus Effect Layers, normalized web stores, and Electron main/preload boundaries.
- Inventory reviewed: **1,813 files / 545,245 physical LOC**.
  - Web + marketing: 909 files / 248,054 LOC (649 production, 260 tests/browser files).
  - Server: 667 files / 246,207 LOC (435 production, 232 tests/integration files).
  - Desktop + contracts + shared + effect-acp + scripts: 237 files / 50,984 LOC
    (151 production, 86 tests).
- Static passes: line/function size inventory, local import reachability, exact token-window duplicate
  scan, repo-wide reference search, and a narrowly configured Oxlint `no-unused-vars` scan.
- Baseline: 145 non-test logic/style files exceed 500 physical lines. Size alone does not place a file
  in the tracker; only a demonstrated responsibility seam or duplicate owner does.
- Baseline unused diagnostics: **40** unused imports/locals/parameters/functions across source and
  tests.

## Highest-value findings

### Monoliths with stable seams

| Pri | File                                                               |    LOC | Demonstrated responsibilities / intended boundary                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | `apps/web/src/components/ChatView.tsx`                             | 11,971 | One 10,857-line component owns provider catalog, voice, automation setup, composer persistence, send/queue/steer, transcript following, terminal control, dialogs, and layout. Adopt existing provider/voice hooks first, then extract responsibility controllers without moving list scroll ownership. |
| P0  | `apps/web/src/components/Sidebar.tsx`                              |  7,940 | Navigation, pins, archive/delete, project-run lifecycle, drag/drop, PR queries, and duplicated thread rows. Extract one row owner and controller hooks while preserving selector granularity.                                                                                                           |
| P0  | `apps/web/src/composerDraftStore.ts`                               |  5,185 | Types/schema, model/draft normalization, blob persistence/migration, Zustand actions, and hooks. Preserve one public facade/storage key; split pure migration, attachments, model selection, and actions.                                                                                               |
| P0  | `apps/web/src/store.ts`                                            |  4,714 | Persistence, snapshot normalization, projections, event reduction, sync actions, and React wiring. Preserve pure reducer/facade APIs.                                                                                                                                                                   |
| P0  | `apps/desktop/src/main.ts`                                         |  3,722 | Logging, updater, backend supervision, protocol/static serving, IPC, windows, and lifecycle. Keep bootstrap in `main.ts`; extract a few existing controllers.                                                                                                                                           |
| P0  | `apps/desktop/src/browserManager.ts`                               |  2,149 | OAuth/popups, tab commands, runtime lifecycle, suspension, and state synchronization. Keep a facade; extract popup, tab-runtime, and state operations after characterization.                                                                                                                           |
| P1  | `apps/server/src/provider/Layers/ClaudeAdapter.ts`                 |  5,590 | Pure error/token/request/message mapping plus a 3,900-line live session implementation. Move pure Claude modules first; keep Layer/service exports stable.                                                                                                                                              |
| P1  | `apps/server/src/provider/Layers/OpenCodeAdapter.ts`               |  4,733 | Runtime event mapping, model inventory/catalog normalization, and live orchestration. Extract the two pure owners before touching lifecycle.                                                                                                                                                            |
| P1  | `apps/server/src/codexAppServerManager.ts`                         |  3,684 | Session/process lifecycle, transport/routing, discovery/catalog, recovery, and event projection. Keep the manager API; extract discovery and transport collaborators.                                                                                                                                   |
| P1  | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |  3,728 | Pure event/activity mapping, payload bounding, delivery buffers, worker recovery, and replay. Extract mapping/bounding first; keep replay/lifecycle in the Effect Layer and preserve one-way transcript behavior.                                                                                       |
| P1  | `apps/web/src/components/chat/MessagesTimeline.tsx`                |  3,847 | List follow/scroll ownership plus user, work, and tool row renderers. Keep LegendList and bottom-stick ownership together; extract memoized row views and transition hooks.                                                                                                                             |
| P1  | `apps/web/src/routes/_chat.settings.tsx`                           |  3,801 | One component subscribes to and renders every settings domain. Move existing panel seams into panel-owned components and migrate bespoke disclosure UI to the shared motion primitives.                                                                                                                 |
| P1  | `packages/contracts/src/orchestration.ts`                          |  2,291 | Read models, commands, events, and RPC/projection schemas. Split by schema family while preserving the current public export surface.                                                                                                                                                                   |
| P1  | `apps/server/src/git/Layers/GitCore.ts`                            |  2,911 | Execution/locks, status/remotes, commit/push/pull, and branch/worktree/stash. Extract private factories behind the existing GitCore service.                                                                                                                                                            |
| P1  | `apps/server/src/terminal/Layers/Manager.ts`                       |  2,569 | Process inspection, stream/title parsing, PTY lifecycle/backpressure, and history persistence. Extract pure process/parser modules then history storage; keep the manager service.                                                                                                                      |

Large but currently cohesive and deliberately not scheduled: `providerRuntime.ts`, `rpc.ts`,
`contracts/model.ts`, `shared/terminalThreads.ts`, `toolCallLabel.ts`, and `whatsNew/entries.ts`.

### Repeated knowledge with a clear owner

- `store.ts:625-731`: `normalizeProjectFromReadModel` and `normalizeProjectFromShell` have identical
  bodies; one project normalizer should accept their shared shape.
- Profile selection logic is duplicated between `profileSelectors.ts`, `profileHeatmap.ts`, and
  `profileUsage.ts`; `profileSelectors.ts` is the live owner.
- Terminal-context synchronization is duplicated in `ChatView.tsx:1005-1020` and
  `KanbanNewTaskDialog.logic.ts:17-34`; `lib/terminalContext.ts` owns it.
- Automation warning acknowledgement is duplicated in the automation list/detail routes;
  `automationDraft.ts` owns the pure update.
- Pinned-message and marker environment rows duplicate edit/jump/rename/keyboard/remove behavior;
  one focused editable checklist row should adapt their domain differences.
- Pinned and normal Sidebar thread rows duplicate provider/status/PR/meta/actions behavior; one row
  component should own it with small variants.
- ACP turn-local ID/tool scoping, active-turn clearing, cost/prompt/cwd helpers drift between Droid
  and Grok adapters; `AcpAdapterSessionSupport.ts` owns only transport-independent behavior.
- ProviderHealth repeats the same CLI version-probe state machine for at least five providers; one
  probe owns missing/timeout/nonzero/success while provider auth/model follow-ups stay local.
- `toPersistenceSqlOrDecodeError` is copied in at least eight persistence Layers;
  `persistence/Errors.ts` is the owner.
- Projection thread-message DB schema/decoding is duplicated between snapshot query and repository;
  one persistence-internal row module should own it.
- Desktop backend shutdown setup is duplicated in `main.ts`; BrowserManager repeats window-open and
  active-tab workflows; each belongs to its existing supervisor/manager.
- Contracts repeat full/shell thread field knowledge and the browser command interface; shared schema
  fields and a shared `BrowserApiCommands` interface should preserve optionality differences.
- Small domain-owned consolidations: Git unique branch naming, release GitHub-output serialization,
  sensitive argument redaction, agent alias records, marketing platform SVGs, and profile
  token-attribution SQL. Implementation characterization rejected provider semver normalization and
  thread-lock sharing: their leading-`v`/malformed-segment and effect-evaluation timing semantics
  differ.

Rejected as bad abstractions: universal provider adapters, generic record/string helpers, migration
DDL sharing, two merely similar provider model normalizers, and CSS selector merging where repeated
selectors intentionally contribute different cascade layers.

### Dead code and unused baseline

Confirmed dead/superseded production modules:

- `apps/server/src/attachmentUpload.ts` and its obsolete standalone test; managed attachment upload
  is owned by `managedAttachmentStore.ts`/`http.ts`.
- `apps/web/src/components/profile/profileHeatmap.ts` and `profileUsage.ts`; live code uses
  `profileSelectors.ts`.
- `apps/web/src/historyBootstrap.ts`; referenced only by its own test.
- `apps/web/src/singleChatPanelStore.ts`; referenced only by its own test and superseded by current
  panel state.
- `apps/web/src/components/chat/userMessagePreview.ts`; runtime uses `userMessageCollapse.ts`, with
  one test-only constant import to migrate.

Test-only estimator `components/timelineHeight.ts` remains tracked separately because browser geometry
tests still import it even though production uses LegendList's fixed estimate. Delete or move it only
when the timeline tests assert live behavior instead of a non-production model.

The scoped unused scan found 40 diagnostics, including stale imports in web, server, and desktop;
unused callbacks/derived values in `ChatView`, `Sidebar`, settings, terminal/model/theme code; dead
OpenCode/projector helpers; and stale test fixtures. CLN-001 is complete only when the same focused
scan returns zero without underscore-renaming unused values.

## Execution tracker

Status values: `TODO`, `IN_PROGRESS`, `DONE`, `BLOCKED`, `REJECTED`.

| ID      | Pri | Status | Workstream                                                                                                                                                                                   | Primary validation                                                          |
| ------- | --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| CLN-001 | P0  | DONE   | Remove all 40 unused imports/locals/functions/parameters; delete computations made solely for dead values.                                                                                   | focused Oxlint unused scan; affected unit tests                             |
| CLN-002 | P0  | DONE   | Delete confirmed dead/superseded modules and obsolete tests; migrate the remaining collapse constant import.                                                                                 | web/server focused tests; repo-wide reference scan                          |
| CLN-003 | P0  | DONE   | Consolidate exact low-risk domain logic: project normalization, profile selectors, terminal-context sync, automation warning updates, persistence error mapper.                              | existing owner tests plus affected caller tests                             |
| CLN-004 | P1  | DONE   | Consolidate focused duplicated views/motion: Sidebar row variants, pinned/marker editable row, settings/branch/environment disclosure controls, marketing platform icon.                     | web unit/browser tests and disclosure tests                                 |
| CLN-005 | P1  | DONE   | Consolidate server/desktop repeated workflows: ACP support helpers, provider-health probe, branch naming, semver, provider locks, redaction, desktop shutdown/tab activation, GitHub output. | focused subsystem suites                                                    |
| CLN-010 | P0  | DONE   | Decompose `store.ts` and its test by persistence/normalization/projection/event reducer while keeping the facade.                                                                            | `apps/web/src/store.test.ts` and selector tests                             |
| CLN-011 | P0  | DONE   | Decompose `composerDraftStore.ts` and its test by migration, attachments, model selection, and actions while preserving storage compatibility.                                               | composer draft/store tests                                                  |
| CLN-012 | P0  | DONE   | Shrink `ChatView`: adopt existing provider-model and voice hooks, then extract automation setup, terminal actions, composer send/queue, and dialog/layout owners.                            | ChatView logic/browser suites and hook tests                                |
| CLN-013 | P0  | DONE   | Shrink `Sidebar`: shared thread row, pin/archive/delete controller, project-run controller, with selector granularity unchanged.                                                             | Sidebar logic/UI/import plus new row characterization                       |
| CLN-014 | P1  | DONE   | Split `MessagesTimeline`, `session-logic`, chat route surfaces, and their tests along existing row/derivation/surface seams without changing scroll-follow semantics.                        | timeline unit/browser suites; session logic tests                           |
| CLN-015 | P1  | DONE   | Reassess settings by stable workflow ownership; extract only independently changing panels that reduce lifecycle/subscription or duplicated-logic scope, and intentionally retain cohesive route-local UI. | focused workflow/render/disclosure tests                                    |
| CLN-020 | P1  | DONE   | Decompose Claude and OpenCode adapters only along independently testable pure mapper/catalog seams; retain cohesive live lifecycle orchestration.                                           | adapter and runtime suites                                                  |
| CLN-021 | P1  | DONE   | Decompose Codex app-server manager into discovery/catalog and transport/routing collaborators; consolidate send/steer input shaping.                                                         | manager and transport suites                                                |
| CLN-022 | P1  | DONE   | Extract the pure runtime-event activity projector and bounded-payload policy; intentionally retain delivery buffers, replay, caches, and lifecycle orchestration in the Layer.              | focused projection tests; targeted unused scan; source bundles              |
| CLN-023 | P1  | DONE   | Extract Git status wire parsing and terminal subprocess probing behind the existing facades; retain process, mutation, PTY, output, persistence, and lifecycle orchestration.                | focused parser/probe tests plus one Git wiring filter                       |
| CLN-024 | P2  | DONE   | Consolidate the duplicated projection message-row codec without changing SQL/query shape; retain the already-shared token-attribution CTE in its current owner.                              | focused codec plus selected repository/snapshot cases                       |
| CLN-030 | P0  | DONE   | Extract only the packaged static-protocol routing policy from Electron `main.ts`; retain logging, updater, backend, window, IPC, and bootstrap lifecycles as cohesive owners.                 | focused resolver tests and targeted desktop bundle                          |
| CLN-031 | P0  | DONE   | Extract only BrowserManager's long-lived Electron session/security policy; retain popup, tab-runtime, CDP, mutable state, timers, and event lifecycle behind the facade.                     | focused session-policy characterization and manager bundle                  |
| CLN-032 | P1  | DONE   | Extract only the pure resumable-update HTTP/retry/checksum/header policy behind its existing facade; retain AppSnap persistence, stream engine/adapter, and artifact build phases.           | selected existing resumable-download policy tests and bundle                |
| CLN-033 | P1  | DONE   | Consolidate the 19 duplicate browser commands plus identical state subscription inside `ipc.ts`; retain runtime orchestration schema families and distinct event surfaces.                 | selected bridge adapter tests and targeted bundles                          |
| CLN-034 | P2  | DONE   | Consolidate repeated alias scans inside the existing canonical subagent-state decoder; retain the cohesive decoder/index module and context-specific alias sets.                           | one filtered shared decoder characterization and bundle                     |
| CLN-035 | P2  | REJECTED | Retain the cohesive native AppSnap capture until deterministic Swift selection/sizing/PNG-limit characterization and a helper capture smoke mode exist.                                    | gate audit only; no safe implementation verification exists                 |
| CLN-040 | P2  | DONE   | Final reference/duplicate/unused rescan, retained-monolith review, `timelineHeight.ts` reassessment, and before/after metrics; no broad tests without authorization.                        | static scans and targeted source/reference checks                           |

## Ordered execution and safety gates

1. **Deletion baseline:** CLN-001 → CLN-002. These must produce a clean unused/reference scan before
   structural work begins.
2. **Exact consolidation:** CLN-003 → CLN-005. Add direct characterization first where an owner lacks
   coverage. Delete every superseded implementation in the same task.
3. **Web state before view controllers:** CLN-010 → CLN-011 → CLN-012 → CLN-013 → CLN-014 → CLN-015.
   Never couple virtualizer measurement to bottom-stick behavior; tool/work-only activity must not
   retrigger live transcript auto-follow.
4. **Server pure seams before lifecycles:** CLN-020 → CLN-021 → CLN-022 → CLN-023 → CLN-024. Public
   Service/Layer/manager APIs stay stable until all internal callers and tests migrate.
5. **Desktop/contracts:** CLN-030 → CLN-031 → CLN-032 → CLN-033 → CLN-034 → CLN-035.
6. **Closeout:** CLN-040. Re-run the same static scans and record exact before/after file/function/unused
   metrics.

For every tracker item:

1. Re-read this file and mark exactly one item `IN_PROGRESS`.
2. Name the proposed owner, intended benefit, tradeoff, and any hot-path/subscription impact; reject
   wrapper-only movement before editing.
3. Add/confirm the smallest characterization gate before moving behavior-bearing code.
4. Make one cohesive, reversible extraction or consolidation at a time, deleting its superseded
   duplicate in the same change.
5. Run the smallest focused tests after each meaningful move.
6. Update this tracker and record results before starting the next item.
7. Do not commit unrelated work. If commits are created, keep each tracker item independently
   reviewable and revertible.

## Validation policy

- Use `bun run test`, never `bun test`.
- Focused tests run throughout the refactor loop.
- Per repository instructions, do not run `bun fmt`, `bun lint`, or `bun typecheck` unless the user
  explicitly requests them in the current conversation. They are therefore a final authorization
  gate, not permission inferred from this plan.
- No task is marked done on file movement alone: callers, obsolete code, and redundant tests must be
  removed, and focused behavior gates must pass.

## Progress log

- 2026-07-19 — Orientation and parallel read-only scan complete. One consolidated plan created; no
  production files changed yet.
- 2026-07-19 — CLN-001 started from a 40-diagnostic unused-symbol baseline.
- 2026-07-19 — CLN-001 complete: unused diagnostics **40 → 0**; 35 files changed,
  **134 net code lines removed**. Focused verification passed: web keybindings 58/58, web
  activation/terminal/timeline/theme 99/99, server GitCore 86/86, and `git diff --check`.
  Central verification caught and corrected one over-eager mechanical deletion before closure.
- 2026-07-19 — CLN-002 started after confirming a clean worktree checkpoint at `7c5c3b3f5`.
- 2026-07-19 — CLN-002 complete: 11 dead source/test files deleted and **947 net code
  lines removed**. Target reference scan found no remaining imports/callers; the unrelated browser
  fixture name `attachmentUploadSequence` remains. Unused diagnostics remain at zero. Focused live
  owner verification passed: profile/timeline 51/51, attachment route 6/6, and managed attachment
  repository 12/12; `git diff --check` passed.
- 2026-07-19 — CLN-003 started from the exact-duplication owners identified in the audit.
- 2026-07-19 — CLN-003 complete: project normalization **2 → 1**; terminal-context sync/equality
  **2 each → 1 each**; automation warning mutation **3 → 1**; persistence SQL/decode mapper
  **9 → 1**; duplicate profile selector modules remain deleted. The change removed **109 net code
  lines**. Focused verification passed across 11 unique test files (web 290 tests, server repository
  gates 11 tests, and the added snapshot-query gate 10 tests); unused diagnostics and
  `git diff --check` passed.
- 2026-07-19 — CLN-004 started; appearance and interaction are characterization constraints, not
  redesign targets.
- 2026-07-19 — CLN-004 complete: pinned and standard Sidebar rows now share one identity/status
  content owner, shrinking `Sidebar.tsx` from **7,940 → 7,675 LOC** while leaving its wrapper event
  and drag controllers in place; pinned-message and marker edit/jump/rename behavior moved from
  **2 implementations → 1** Environment-domain component; **4 bespoke disclosure motion paths →
  0** in the targeted settings/branch/environment controls; and the two marketing pages now share
  one typed platform-icon owner. Combined verification passed: web unit **131/131**, browser
  **10/10**, marketing production build, repo scan **1,811 files / 0 unused diagnostics**, and
  `git diff --check`.
- 2026-07-19 — CLN-005 started from the repeated server/desktop workflows identified in the audit.
- 2026-07-19 — CLN-005 complete: ACP active-turn/cost/Plan-prompt/cwd bookkeeping moved from
  **2 implementations → 1** and Grok adopted the existing turn-local item/tool scoping owner;
  provider CLI version-probe outcomes moved from **9 state machines → 1** classifier; sensitive
  process-argument regexes **2 → 1** while caller-specific truncation stayed local; Git branch
  collision loops **2 → 1**; release GitHub-output serializers **2 → 1**; desktop shutdown preflight
  **2 → 1**, browser window-open policy **2 → 1**, and active-tab transitions **5 → 1**. Semver and
  provider-lock candidates were retained after characterization exposed different edge-case/timing
  semantics. Combined focused verification passed across **15 files / 259 tests**, plus the desktop
  build and isolated Electron smoke; repo scan **1,819 files / 0 unused diagnostics** and
  `git diff --check` passed.
- 2026-07-19 — CLN-010 started; the public store facade, persistence keys, and reducer behavior are
  compatibility constraints.
- 2026-07-19 — CLN-010 complete: `store.ts` shrank from **4,671 → 341 LOC** and now retains only
  the stable public facade, Zustand wiring, and local UI actions. State, persistence, normalization,
  projection, and orchestration event reduction have five explicit acyclic owners; the split's
  production family is **4,783 LOC** including module-boundary overhead. Exact project mapping and
  upsert knowledge moved from **2 implementations → 1** each. The 4,168-line store test moved into
  facade/persistence (**516 LOC**), projection, and event-reducer suites with one shared fixture
  module; one exact duplicate case was deleted and replaced by a normalized-record identity gate.
  All 94 unique original behavior names remain covered. Combined focused verification passed across
  **11 files / 158 tests**; the public export/action surface is unchanged, the import graph is
  acyclic, repo unused diagnostics remain **0 across 1,827 files**, and `git diff --check` passed.
- 2026-07-19 — CLN-011 started; the existing facade, storage key/schema compatibility, attachment
  ownership, and granular selector identity are characterization constraints.
- 2026-07-19 — CLN-011 complete: `composerDraftStore.ts` shrank from **5,185 → 158 LOC** and now
  owns only public re-exports, Zustand/persistence wiring, hooks, and promotion batch helpers. Domain,
  model selection, attachment lifetime/verification, migration/serialization, and actions have
  exactly five internal owners; the production family is **5,420 LOC** including boundary overhead.
  The old store↔`composerSend` source cycle was removed by placing image cloning with draft transfer
  and re-exporting it from the send module. The 3,423-line test moved into core/facade (**553 LOC**),
  attachment, model, and persistence suites with one shared fixture module (**3,470 LOC** total);
  two overlapping sticky-update cases now share one two-row contract, and three identity/facade
  characterizations were added. The **27-name export set** and all **61 state/interface members**
  match the original. Combined focused verification passed across **10 files / 180 tests**; the
  dependency graph is acyclic, repo unused diagnostics remain **0 across 1,836 files**, and
  `git diff --check` passed.
- 2026-07-19 — CLN-012 started; transcript follow/virtualization ownership, send/queue ordering,
  provider selection, terminal synchronization, and dialog behavior are characterization constraints.
- 2026-07-20 — CLN-012 complete: `ChatView.tsx` shrank from **11,930 → 10,902 LOC** while retaining
  the transcript list, message/work derivation, selection anchoring, and bottom-stick ownership.
  Provider model/agent discovery moved from **2 owners → 1**, voice recording/transcription from
  **2 → 1**, searchable model shaping from **3 → 1**, and fullscreen image overlays from **2 → 1**.
  Focused automation setup (**230 LOC**) and chat-terminal (**359 LOC**) controllers now own their
  state/effects; direct terminal-store subscriptions in `ChatView` fell from **23 → 0**, provider
  queries from **21 → 8**, callbacks from **186 → 157**, refs from **68 → 60**, and state hooks from
  **22 → 18**. The proposed send/queue god hook was deliberately retained after its measured port
  crossed **~34 independent mutable concerns**; moving it would worsen the architecture. Transcript
  follow now keys only on real message count/tail changes, with a browser characterization proving
  buffering, approvals, and tool-only rows do not re-stick while real/live message changes do.
  Combined verification passed across **25 files / 547 tests** (unit/support 475, shared overlay
  browser 2, full `ChatView` browser 70); no import cycle was introduced, repo unused diagnostics
  remain **0 across 1,843 files**, and `git diff --check` passed.
- 2026-07-20 — CLN-013 started from the 7,675-line post-row-consolidation Sidebar. Selector
  granularity, project/thread optimistic reconciliation, disclosure motion, route activation, and
  context-menu behavior are characterization constraints; wrapper-only and god-hook moves are
  rejected.
- 2026-07-20 — CLN-013 complete: `Sidebar.tsx` shrank from **7,675 → 6,555 LOC**. Thread pin,
  archive/undo, single/batch delete, and split-view reconciliation moved into a focused **714 LOC**
  controller; project script discovery, server attribution, run lifecycle, and dialog state moved
  into a **299 LOC** controller. Sidebar and Kanban active-thread deletion sequencing moved from
  **2 implementations → 1** shared **121 LOC** owner; optimistic pin reconciliation moved from
  **2 loops → 1** pure helper; and two render-only forwarding functions were deleted. The resulting
  production family is **7,689 LOC**, including boundary overhead, and retains narrow store
  selectors rather than one broad controller subscription. Combined focused verification passed
  across **16 files / 208 unit tests** and **2 files / 3 browser tests**; default targeted Oxlint,
  repo unused diagnostics across **1,850 files**, and `git diff --check` all passed. Disclosure
  motion and transcript-follow behavior were untouched.
- 2026-07-20 — CLN-014 started. Real transcript messages remain the only live-output follow signal;
  list/virtualizer measurement stays one-way and co-owned with the timeline. Extraction candidates
  must reduce a demonstrated responsibility or duplicate owner, not merely relocate JSX.
- 2026-07-20 — CLN-014 complete: the three targeted production roots shrank from **8,776 → 3,333
  LOC**. `MessagesTimeline.tsx` moved its cohesive work/tool presentation into one **1,172 LOC**
  owner and fell from **3,847 → 2,622 LOC**; the unreachable modal tool-details view was deleted in
  favor of the live inline owner (**2 views → 1**), the local basename duplicate now uses the shared
  path owner, and two dead forwarding/always-null functions were removed. `_chat.$threadId.tsx`
  fell from **2,420 → 193 LOC** and now owns only hydration/recovery dispatch; split (**1,032 LOC**),
  single (**963 LOC**), and shared lazy surface primitives (**201 LOC**) have explicit owners, while
  desktop browser-panel subscriptions moved from **2 implementations → 1** stable **44 LOC** hook.
  `session-logic.ts` fell from **2,509 → 518 LOC** while preserving its import facade; pending
  interaction replay moved from **2 state machines → 1** **256 LOC** owner, and the cohesive work-log
  projection/collapse/timeline domain moved to one **1,776 LOC** owner. Its **4,061 LOC** test split
  into **910 / 506 / 2,630 LOC** owners with the original test-name multiset preserved and no new
  fixture layer. The dead work-log presentation version export was deleted. Combined verification
  passed across **21 files / 544 unit tests** and **6 files / 80 browser tests**; the real-message-only
  auto-follow characterization passed three additional consecutive focused runs after isolating
  mount-time tail retries. Independent implementation, route, and coverage reviews are clean; repo
  unused diagnostics remain **0 across 1,860 files**, and `git diff --check` passed.
- 2026-07-20 — CLN-015 started from the 3,797-line settings route. Panel ownership, local selector
  granularity, shared disclosure motion, and provider install/reset semantics are compatibility
  constraints; generic form abstractions and one-file-per-control splits are rejected.
- 2026-07-20 — CLN-015 acceptance criteria tightened: line count and file count are explicitly not
  goals. Desktop integration, storage, provider-install, and other candidates must prove an
  independently changing lifecycle/workflow or duplicated-knowledge owner with focused coverage;
  presentational panel moves are rejected when they only relocate JSX or add settings subscriptions.
- 2026-07-20 — CLN-015 complete after the preference-panel extraction was explicitly rejected.
  General, Appearance, and Behavior remain one cohesive route-owned settings surface. Desktop
  notifications/AppSnap, model discovery/editing, provider picker/update/install workflows,
  conversation storage, and advanced auth/recovery now have five domain-owned modules; the route
  retains the single `useAppSettings` subscription and keeps stateful owners mounted while inactive
  so drafts, disclosures, native request ordering, pending mutations, and IPC guards preserve their
  original route lifetime. Inactive owners render no DOM and model discovery remains active-section
  gated. One provider field schema now owns install rendering, dirty/open/reset/read/write behavior;
  provider update action UI **2 → 1**, worktree association rules **2 → 1**, archived recency
  comparators **2 → 1**, target-scroll effects **2 → 1**, and Git-writing dirty normalization
  **2 → 1**. The dead provider-installs target was deleted, two missing settings-search entries were
  restored, and custom-model overflow now uses shared disclosure motion. The former **3,797 LOC**
  route is **1,114 LOC**, while its cohesive production owner family is **3,742 LOC**; these are
  descriptive measurements, not acceptance criteria. Final changed-only verification passed across
  **3 unit files / 69 tests** and **3 browser files / 5 tests**, plus the earlier focused model and
  workflow gates, a targeted route bundle, **0 unused diagnostics across 17 touched files**, two
  independent runtime/maintainability reviews, and `git diff --check`. Tradeoff: domain modules stay
  mounted for route-lifetime safety, so this change intentionally does not claim fewer settings
  queries/effects. Remaining risk: destructive worktree UI sequencing still relies partly on its
  focused lower-level archive tests rather than one end-to-end delete-click browser case.
- 2026-07-20 — CLN-020 started with pure mapping/catalog seams as the only extraction candidates.
  Live session/process/reconnect/event orchestration remains in each adapter unless characterization
  proves a smaller independently owned workflow. File size alone is not a reason to split.
- 2026-07-20 — CLN-020 complete with exactly two pure domain owners. `claudeTokenUsage.ts` now owns
  context-window selection, token/cache arithmetic, usage snapshots, accumulated-usage merging, and
  warning decisions; the adapter retains warning de-duplication, event emission/order, SDK control,
  session state, process management, and all live lifecycle. `OpenCodeDiscovery.ts` now owns model,
  provider, agent, and command catalog normalization; the adapter retains discovery connection
  orchestration plus every streaming, event, recovery, startup, resume, and send-turn path. This
  moved Claude from **5,590 → 5,336 LOC** and OpenCode from **4,733 → 4,084 LOC**, but the accepted
  benefit is direct ownership and focused characterization rather than line reduction. Repeated
  Claude prompt/cache arithmetic now has one implementation, and OpenCode's three local numeric
  guards now use the existing token-usage owner. The tradeoff is two substantive module boundaries
  (**309 / 639 LOC**) and a small pure warning decision object only on warning paths. OpenCode
  discovery is outside runtime hot paths; Claude warning cadence, cardinality, and order are
  explicitly characterized, including the original deferred large-prompt warning. The proposed
  OpenCode event projector and all lifecycle splits were rejected as hot-path/tightly coupled moves;
  the broad Claude SDK mapper was retained because moving it now would mostly relocate code.
  Focused verification passed once in each new owner: Claude **24/24** and OpenCode **14/14**. Both
  production adapters bundled, the changed seven TypeScript files have **0 unused diagnostics**, and
  `git diff --check` passed. Remaining risk: the large adapter lifecycle suites were intentionally
  not rerun, so integration confidence relies on unchanged orchestration wrappers plus the focused
  pure behavior gates.
- 2026-07-20 — CLN-021 started as a boundary audit, not a mandate to split the manager. Candidate
  owners must be independently testable discovery/catalog policy, pure request shaping, or a
  transport collaborator with an already explicit lifecycle. Process startup, JSON-RPC routing,
  recovery, and session/turn coordination stay together unless the existing tests expose a stable
  seam; wrapper-only moves and callback-heavy controller extraction are rejected.
- 2026-07-20 — CLN-021 complete with two pure boundaries and no lifecycle split.
  `provider/codexDiscoveryCatalog.ts` (**430 LOC**) now owns deterministic normalization of untrusted
  skills, model, plugin-list, and plugin-detail responses; its detailed fixtures moved out of the
  manager suite while lean request-wiring coverage remains. `codexTurnInput.ts` (**44 LOC**) owns
  the exact text → image → skill → mention wire projection shared by send and active steer, while
  validation and routing-map timing remain in the manager. The manager fell from **3,683 → 3,229
  LOC**; its production owner family is **3,703 LOC**, illustrating that responsibility ownership,
  not line reduction, is the benefit. At the adapter boundary, native attachment/file-prompt/model
  preparation moved from **2 implementations → 1**, Codex model option projection from **3 → 1**,
  and the existing prompt-image owner gained one optional error factory so Codex preserves its prior
  method label and native error cause. The tradeoff is two explicit module hops plus that narrow
  optional policy hook. Discovery is not a hot path; turn dispatch remains one attachment pass with
  concurrency four, the same input ordering, and dispatch only after preparation. The existing
  `codexAppServerTransport.ts` remains the transport owner. Process startup, request routing,
  caches, discovery-session reuse, approvals, streaming notifications, recovery, and teardown were
  intentionally retained because separating them would introduce callback-heavy lifecycle
  indirection. Focused verification ran once per changed behavior: discovery catalog **5/5**, turn
  input **3/3**, manager wiring **5/5** with 85 unrelated cases skipped, adapter preparation **2/2**,
  and prompt attachments **1/1**. Both production entrypoints bundled, all nine touched TypeScript
  files have **0 unused diagnostics**, and `git diff --check` passed. Remaining risk: the broad
  manager/adapter suites and workspace typecheck were intentionally not run under the user's
  small-test constraint.
- 2026-07-20 — CLN-022 started with transcript semantics as a hard boundary: only real assistant
  text activity may drive live-output follow, and tool/work/pending activity must not be reclassified
  by cleanup. Pure event/activity derivation and payload bounding are candidates; delivery buffers,
  worker recovery, replay ordering, and Layer state remain together unless an existing collaborator
  and focused timing coverage prove an independent owner.
- 2026-07-20 — CLN-022 complete: `providerRuntimeActivityProjection.ts` now owns the deterministic
  provider-event to bounded-activity policy, context/model-usage normalization, reasoning-row policy,
  and activity-update identity. This is a stable owner because it depends only on provider/activity
  contracts and is directly testable; the ingestion Layer remains the owner of dispatch, buffering,
  replay, caches, generated-image settlement, subagent materialization, and terminal lifecycle. The
  benefit is isolated policy coverage and a smaller stateful workflow; the tradeoff is one import hop
  on the event-ingestion hot path. The implementation preserves the same synchronous allocation and
  serialization work, introduces no callbacks or additional passes, and explicitly proves that
  assistant text/lifecycle events do not become work activity. The focused projection suite passed
  **6/6** once; both source entrypoints bundled, the three touched TypeScript files have **0 unused
  diagnostics**, and `git diff --check` passed. `ProviderRuntimeIngestion.ts` moved from **3,728** to
  **2,730** lines while the cohesive projector is **1,032** lines; these are descriptive, not targets.
  Remaining risk: the broad ingestion suite was intentionally not rerun under the user's small-test
  constraint. Replay/lifecycle extraction was rejected as callback-heavy and timing-sensitive; the
  assistant delivery-mode correlation state machine remains a separately reviewable future seam.
- 2026-07-20 — CLN-023 started with two independently owned seams. `gitStatusParsing.ts` will own
  pure porcelain/numstat/byte-line interpretation and consolidate repeated numstat summarization;
  it must not change Git command count, concurrency, caches, mutation locking, or fallbacks.
  `terminal/subprocessActivity.ts` will own OS process-tree capture/classification and consolidate
  duplicate descendant classification while preserving the single shared `ps` snapshot per poll,
  `pgrep` fast path, timeouts, caps, and conservative fallback. The intended benefit is direct
  protocol-policy coverage without loading either lifecycle manager; the tradeoff is a small internal
  dependency hop on two polling/status hot paths. Git execution/mutation workflows and terminal PTY,
  output, ACK, persistence, exit, and polling lifecycle remain intentionally cohesive.
- 2026-07-20 — CLN-023 complete: `gitStatusParsing.ts` owns the pure porcelain-v2, numstat,
  configured-merge-ref, and byte-line codecs. GitCore keeps command execution, concurrency,
  refresh/cache behavior, mutation locking, fallback policy, and its public facade. The repeated
  numstat parsing/summarization path and identical `quoteGitCommand` implementation were removed.
  `terminal/subprocessActivity.ts` now owns OS process-tree probing and child classification; the
  duplicated snapshot/fallback classifier was consolidated, while Manager still captures exactly
  one shared process snapshot before the per-session `Promise.all` and owns every PTY/output/event/
  persistence/polling decision. The benefit is direct protocol coverage and less lifecycle-file
  coupling; the tradeoff is one internal import hop in each status/poll path, with no additional
  process invocations or data passes. Focused verification ran once per seam: Git parser **4/4**,
  adversarial real-repository Git wiring **1/1** with 85 unrelated cases skipped, and subprocess
  classification **6/6**. Both production entrypoints bundled, all six touched TypeScript files have
  **0 unused diagnostics**, and `git diff --check` passed. GitCore is **2,757** lines with a cohesive
  **206**-line parser; TerminalManager is **2,322** lines with a **254**-line probe. Remaining risk:
  uncommon malformed Git wire variants and live Windows process probing were not exercised; broad
  GitCore/TerminalManager suites were intentionally not run under the small-test constraint.
- 2026-07-20 — CLN-024 started with one accepted duplication boundary: a persistence-owned message
  row codec will replace the identical schemas and parallel JSON/optional-field decoders in
  `ProjectionThreadMessages` and `ProjectionSnapshotQuery`. It will expose two explicit direct
  mappings rather than a callback/generic adapter, preserving each consumer's output shape and
  allocation count. Every SQL statement, error label, ordering rule, global 2,000-message window,
  export cap behavior, and repository query remains textually local and unchanged. The profile
  token-attribution CTE is already a single shared implementation used by live and archive paths;
  moving it to a tiny file would only relocate code, so it is intentionally retained. The similar
  surrounding joins/delta calculations have different lifetime and fallback semantics and will not
  be unified.
- 2026-07-20 — CLN-024 complete: `projectionThreadMessageRow.ts` is now the single owner of the
  persisted message schema, JSON metadata decoding, nullable dispatch/sequence fields, and the two
  direct repository/orchestration mappings. Both superseded schemas and converters were deleted.
  SQL remains in the original callers with unchanged query text, ordering, global message window,
  per-thread export behavior, decode sites, and error labels; snapshot hydration still performs one
  bounded query rather than routing through the repository. The benefit is one authoritative storage
  format and less drift-prone conversion logic; the tradeoff is two explicit output functions in a
  **74**-line persistence module, avoiding a generic mapper and any additional hot-path allocation.
  Focused verification ran once: codec **3/3**, repository attachment preservation **1/1** with seven
  unrelated cases skipped, and snapshot hydration/causal ordering/2,000-cap plus uncapped export
  **3/3** with seven unrelated cases skipped. All three production entrypoints bundled, the four
  touched TypeScript files have **0 unused diagnostics**, and `git diff --check` passed. Remaining
  risk is limited to persisted row variants beyond the characterized schema; broad persistence and
  snapshot suites were intentionally not run. Token attribution remains intentionally retained as
  one already-shared CTE; live/archive surrounding SQL is semantically different, not duplicate.
- 2026-07-20 — CLN-030 started after rejecting a broad Electron decomposition. The accepted owner is
  `desktopStaticProtocol.ts`: synchronous URL/path containment, asset-vs-SPA fallback, existence,
  and file-not-found response policy. It is independently testable and changes with packaged static
  routing/security rather than Electron lifecycle. `main.ts` retains privileged scheme registration,
  static-root/bundle validation, the protocol callback and its exact `whenReady` call position. The
  benefit is direct security-policy characterization and a thinner callback; the tradeoff is one
  synchronous resolver call per packaged asset/navigation request. Root/fallback paths will be
  precomputed once, with no async I/O, additional URL parse, IPC, logging, or startup-order change.
  Logging/updater/backend/window/IPC/bootstrap splits were rejected because they share teardown,
  recovery, callback state, or strict Electron ordering and would only create controllers.
- 2026-07-20 — CLN-030 complete: `desktopStaticProtocol.ts` now owns the full synchronous packaged
  request policy: URL/percent decoding, normalized containment, asset detection, nested indexes, SPA
  fallback, existence checks, and Electron file-not-found responses. `main.ts` retains root/bundle
  preparation and the registration callback at the same startup position; the superseded helpers and
  callback branches were deleted. The resolver precomputes its root/prefix/fallback once and performs
  the same URL parse and synchronous existence checks per request, so the import hop adds no async I/O
  or startup/lifecycle work. The benefit is direct security-policy coverage; the tradeoff is a **51**-
  line domain module and one resolver call in the packaged renderer request path. Focused resolver
  verification passed **5/5** once, the `main.ts` production entrypoint bundled, the three touched
  TypeScript files have **0 unused diagnostics**, and `git diff --check` passed. Remaining risk: the
  real Electron protocol callback and Windows path behavior were not runtime-smoked; broad desktop
  tests were intentionally not run. The cohesive **3,666**-line lifecycle entrypoint is otherwise
  intentionally retained rather than split for line count.
- 2026-07-20 — CLN-031 started after rejecting popup, tab-runtime, and generic state controllers as
  callback-heavy lifecycle moves. `BrowserSessionPolicy` is the accepted owner for the persistent
  Electron partition, user-agent/client-hint/language header policy, per-WebContents UA application,
  and hardened OAuth popup options. It changes with browser security/session compatibility and needs
  no callbacks into BrowserManager. The benefit is independently testable security policy and removal
  of header/session concerns from the manager; the tradeoff is one long-lived object plus delegation
  during configuration and content creation. Configuration must remain once-per-manager but retry on
  failure, keep both partition-wide and per-content UA application, preserve case-insensitive in-place
  header replacement, and survive manager `dispose()`. Popup/tab listeners, microtask ordering, state
  versioning, runtime budgets, CDP, timers, teardown, and event emission remain intentionally local.
- 2026-07-20 — CLN-031 complete: the **102**-line `BrowserSessionPolicy` now owns the persistent
  partition, cached Chrome-compatible identity, client-hint/language request headers, per-content UA
  fallback, and hardened OAuth popup options. BrowserManager constructs it once and only delegates at
  the original configuration/content/popup call sites; the partition constant remains re-exported
  through the existing module. The superseded session fields, methods, shared-helper imports, and
  header replacer were removed. The benefit is independently testable security/session policy; the
  tradeoff is one long-lived object and a delegation call outside navigation/state hot paths. Focused
  verification passed **5/5** once, covering configure-once, failure retry, case-insensitive in-place
  headers without Electron tokens, shared UA identity, and popup hardening. The BrowserManager
  production entrypoint bundled, the three touched TypeScript files have **0 unused diagnostics**, and
  `git diff --check` passed. Remaining risk: the live Electron session interceptor was not exercised
  and the existing broader manager characterization was intentionally not rerun. Popup/tab/runtime/
  state/timer/CDP lifecycles remain cohesive in the **2,017**-line manager.
- 2026-07-20 — CLN-032 started with one accepted policy boundary. `resumableUpdateDownloadPolicy.ts`
  will own the synchronous progress/content-range/checksum, response classification, retry budget,
  redirect-origin credential, and request-header rules, re-exported through the existing downloader
  facade. It changes independently from sockets/files/cancellation/Electron adapter lifecycle and is
  already directly characterized. Retry `>` limits, immediate first reconnect after fresh progress,
  response codes, origin/default-port equivalence, auth stripping against the original feed URL,
  header casing, and SHA-512 compatibility must remain byte-for-byte equivalent. The benefit is
  isolated security/retry policy; the tradeoff is one cohesive internal module with no meaningful
  network/startup overhead. AppSnap persistence, streaming/flush/cancel/idle-timeout settlement, the
  small adapter, and desktop artifact phase ordering are intentionally retained because extracting
  them would cross durability, callback, teardown, or release safety gates.
- 2026-07-20 — CLN-032 complete: the **191**-line policy module owns the unchanged synchronous
  configuration, progress, content-range, checksum, HTTP response, retry-cap/backoff, origin, and
  auth/header rules. `resumableUpdateDownload.ts` re-exports the same public facade and retains every
  socket/file/cancellation/flush/idle-timeout/adapter path; all superseded policy implementations were
  deleted. The benefit is isolated review and characterization of the security/retry rules; the
  tradeoff is one internal import in the response/retry path with no extra passes or I/O. A single
  filtered facade run passed **30/30** policy tests with seven lifecycle cases skipped, the combined
  downloader/policy entrypoint bundled, both touched TypeScript files have **0 unused diagnostics**,
  and `git diff --check` passed. Remaining risk: idle-timeout and stream/adapter integration tests were
  intentionally not rerun because their code did not change.
- 2026-07-20 — CLN-035 rejected after a deterministic-gate audit. Native `WindowCapture.swift`
  directly reads live workspace/window/display state; selection, titled-window preference, filtering,
  the 8,192-pixel cap, 10 MiB PNG limit, and 20-attempt reduction loop have no fixture-driven Swift
  tests or helper self-test mode. Existing scripts prove compilation/signing/packaging only, Electron
  smoke never invokes capture, and manager tests fake the helper protocol. Splitting the cohesive
  **613**-line native owner would therefore move system-sensitive behavior without safety coverage.
  Reconsider only after pure fixture-based selection/sizing/limit tests and a compiled-helper capture
  smoke mode exist. Benefit of retention: no focus/attachment-limit regression; tradeoff: the large
  native file remains intentionally cohesive.
- 2026-07-20 — CLN-033 started with one type-only duplicate boundary. A private in-file
  `BrowserControlMethods` interface will become the single owner of the 19 identical methods shared
  by `DesktopBridge.browser` and `NativeApi.browser`; each surface keeps its differently named/event
  methods. This is erased TypeScript structure, so it adds no schema, import, bundle, startup,
  allocation, or runtime behavior. The benefit is preventing preload/web adapter signature drift;
  the tradeoff is slightly less self-contained interface hovers. Broad orchestration family splits
  are rejected because shell/detail omission/defaults and client/server turn-start differences are
  performance or trust-boundary semantics, not accidental duplication. No new contracts file or
  barrel export will be created.
- 2026-07-20 — CLN-033 complete: private `BrowserControlMethods` is now the single owner of the 19
  shared commands plus the type-identical `onState`; `DesktopBridge` and `NativeApi` intersect only
  their distinct event names. The duplicate declarations were deleted and the value-unused
  `EditorId` import became type-only. The benefit is drift prevention between preload and web
  adapters; the tradeoff is one local type lookup in editor hovers, with zero runtime cost. The two
  selected adapter cases passed **1/1** each, contracts IPC/desktop preload/web adapter entrypoints
  all bundled, `ipc.ts` has **0 unused diagnostics**, and `git diff --check` passed. Remaining risk is
  declaration-level compatibility beyond those adapters because the heavyweight workspace typecheck
  was intentionally not run; runtime schemas, channel names, implementations, and exports are
  unchanged.
- 2026-07-20 — CLN-034 started after rejecting a decoder/index file split and universal alias helper.
  `buildSubagentAgentState` is already the correct owner, but it scans seven alias groups twice and
  repeats role trimming/suppression. The accepted change reads each canonical field once, sanitizes
  role once, and constructs the same output. This removes doubled hot-path work without a new module,
  export, generic utility, intermediate decoded snapshot, extra traversal, or allocation pass. Alias
  precedence and object-map/array fallback semantics must remain unchanged. Receiver, identity-hint,
  provider-thread collection, and web action reads retain their distinct key sets and requested-model
  semantics. Benefit: visible precedence and fewer scans during server ingestion/web work-log
  derivation; tradeoff: several well-named locals in the existing **708**-line cohesive owner.
- 2026-07-20 — CLN-034 complete: `buildSubagentAgentState` now reads seven alias groups into canonical
  locals once and sanitizes role once before constructing the same optional output. Superseded
  duplicate reads were deleted: static scan sites fell **14 → 7**, fully populated runtime rows fall
  **14 → 7** alias scans, and role sanitization falls **2 → 1**. No module, export, traversal,
  intermediate snapshot, or public API was added. The benefit is lower ingestion/work-log work and
  visible field precedence; the tradeoff is seven local names in the existing cohesive owner. The
  filtered table-driven object-map/array alias characterization passed **2/2** with 22 unrelated
  cases skipped, the production subagent entrypoint bundled, both touched TypeScript files have
  **0 unused diagnostics**, and `git diff --check` passed. Remaining risk is uncommon alias
  combinations beyond the matrix, mitigated by unchanged alias arrays and ordering; the broader
  shared suite and workspace typecheck were intentionally not run.
- 2026-07-20 — CLN-040 started as a read-only closeout gate. The rescan covers repo-owned source
  references, unused symbols/exports/files, exact/near duplicated logic/views/CSS/functions, and the
  largest retained files including `timelineHeight.ts`. Only true P0/P1 findings with a stable owner
  and focused safety gate may reopen implementation; large cohesive files, trust-boundary checks, and
  semantic variants will be recorded as intentionally retained. No broad tests, formatter, lint, or
  workspace typecheck will run without explicit authorization.
- 2026-07-20 — CLN-040's first rescan reopened four P1 pure mappings and all four are now
  consolidated in existing owners. `model.ts` owns Cursor CLI reasoning-effort parsing (two copies
  deleted); `threadSummary.ts` owns approval request-kind mapping (the work-log copy deleted);
  `AcpAdapterSupport.ts` owns ACP tool-kind canonicalization (two copies deleted); and
  `AcpAdapterSessionSupport.ts` owns requested session-mode alias/fallback selection (Cursor/Grok
  copies deleted while provider alias arrays stay local). No lifecycle, event order, schema, or new
  production file was introduced. Focused verification ran once: Cursor parser **8/8**, server/web
  integration **1/1** each; approval mapping **7/7**; ACP tool/mode policy **2/2** with 12 unrelated
  cases skipped. All affected shared/server/web entrypoints bundled, the 15 touched files have
  **0 unused diagnostics**, and `git diff --check` passed. Remaining risk: live ACP configuration,
  broad work-log/model suites, bundle-size impact, and workspace typecheck were intentionally not run;
  call-site ordering and pure mapping bodies remain unchanged.
- 2026-07-20 — CLN-040 complete: the final dead-surface pass deleted **20** unused exports, helpers,
  types, aliases, and compatibility declarations from their existing domain owners, with **8 lines
  added / 212 deleted** across 16 source files. No replacement abstraction or production file was
  introduced. The benefit is a smaller public/internal surface and less misleading compatibility
  code; the tradeoff is that downstream consumers outside this monorepo would no longer see the
  removed exports, which were proven unreferenced by every repo-owned caller. A repo-wide narrow
  unused scan passed with **0 warnings / 0 errors across 1,891 files**; exact deleted-symbol searches,
  affected entrypoint bundles, and `git diff --check` also passed. No tests were run for this deletion-
  only batch, per the user's small-verification constraint.
- 2026-07-20 — The final duplicate scan covered **1,282 production files** with exact function-body,
  token-window, long-literal, JSX/view, and CSS-selector inventories. After the four pure mappings
  above, it found no remaining P0/P1 duplicate with one stable owner and a focused safety gate.
  Repeated SQL column lists, migration-local DDL, CSS cascade/variant selectors, semver parsing,
  provider text-generation wrappers, and inline checkmark SVG geometry remain intentionally local
  because their query shapes, compatibility rules, control flow, or visual DOM differ. Consolidating
  them would erase meaningful ownership or change behavior.
- 2026-07-20 — Large lifecycle/render owners intentionally retained: the remaining `ChatView`,
  `Sidebar`, provider adapters, Electron bootstrap, browser runtime, replay/delivery, Git, PTY, and
  native AppSnap sections share local state and ordering heavily. Further extraction currently fails
  the independent-owner test and risks prop-drilling, controller parameter bags, extra subscriptions,
  circular dependencies, or teardown/streaming regressions. `timelineHeight.ts` is also retained as
  an independent geometry oracle used by unit and browser comparisons; deleting it would weaken the
  transcript safety gate. Transcript subscription granularity, LegendList behavior, and the rule that
  only real assistant text drives live-output follow were not changed.

## Closeout metrics (descriptive only)

These measurements describe the result; they were never extraction targets.

| Existing owner | Baseline LOC | Closeout LOC | Decision |
| --- | ---: | ---: | --- |
| `ChatView.tsx` | 11,971 | 10,902 | Stable workflows extracted; render/scroll owner retained |
| `Sidebar.tsx` | 7,940 | 6,555 | Row/action seams extracted; navigation owner retained |
| `composerDraftStore.ts` | 5,185 | 158 | Persistence, migration, attachment, and selection owners extracted |
| `store.ts` | 4,714 | 341 | Reducer/projection/persistence owners extracted behind facade |
| Desktop `main.ts` | 3,722 | 3,666 | Static protocol extracted; bootstrap lifecycle retained |
| `browserManager.ts` | 2,149 | 2,017 | Session policy extracted; mutable runtime retained |
| `ClaudeAdapter.ts` | 5,590 | 5,336 | Pure mapping extracted; session lifecycle retained |
| `OpenCodeAdapter.ts` | 4,733 | 4,084 | Pure mapping/catalog seams extracted; lifecycle retained |
| `codexAppServerManager.ts` | 3,684 | 3,229 | Discovery/transport seams extracted behind manager facade |
| `ProviderRuntimeIngestion.ts` | 3,728 | 2,730 | Pure activity projection extracted; replay/delivery retained |
| `MessagesTimeline.tsx` | 3,847 | 2,622 | Row/derivation seams extracted; list-follow owner retained |
| Settings route | 3,801 | 1,114 | Independently changing panels extracted |
| Contracts orchestration | 2,291 | 2,291 | Intentionally retained schema family |
| `GitCore.ts` | 2,911 | 2,757 | Pure parsing extracted; mutation/locking retained |
| Terminal `Manager.ts` | 2,569 | 2,322 | Pure probes/parsers extracted; PTY lifecycle retained |
| **Selected-owner total** | **68,835** | **50,124** | **18,711 fewer lines through owned seams/deletion** |

Final verification intentionally excludes broad suites and the heavyweight `bun fmt`, `bun lint`,
and `bun typecheck` workspace pass. Project instructions prohibit running those commands without an
explicit request, and the user asked to avoid repeated long-running checks. Their status is therefore
**not run**, not passed. Remaining risk is integration/type compatibility outside the focused gates;
the cleanup itself preserves current facades wherever they are repo-owned and covered.
