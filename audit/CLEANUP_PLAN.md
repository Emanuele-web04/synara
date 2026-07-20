# Synara Cleanup Audit and Execution Plan

> Generated: 2026-07-19
> Status: in progress — CLN-022 active
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
| CLN-023 | P1  | TODO   | Split GitCore and Terminal Manager behind existing service facades.                                                                                                                          | GitCore and terminal manager/parser/history suites                          |
| CLN-024 | P2  | TODO   | Share projection message row decoding and profile token-attribution SQL without changing query shape.                                                                                        | snapshot/repository/profile suites                                          |
| CLN-030 | P0  | TODO   | Decompose Electron `main.ts` into logging, updater, backend supervision, static protocol, and window controllers; keep lifecycle/bootstrap.                                                  | add characterization, then desktop focused suites/smoke                     |
| CLN-031 | P0  | TODO   | Split BrowserManager into popup, tab-runtime, and state operations behind its facade.                                                                                                        | new manager characterization + browser session tests                        |
| CLN-032 | P1  | TODO   | Split AppSnap persistence, resumable download policy/engine/adapter, and desktop artifact build phases.                                                                                      | existing AppSnap/download/build tests                                       |
| CLN-033 | P1  | TODO   | Split contracts orchestration schema families and consolidate shared thread/browser API fields while preserving exports.                                                                     | contracts orchestration/rpc/ws tests; desktop preload/web API tests         |
| CLN-034 | P2  | TODO   | Split shared subagent decoding from identity indexing and centralize alias-key readers.                                                                                                      | shared subagent tests                                                       |
| CLN-035 | P2  | TODO   | Split native AppSnap capture only after a deterministic Swift characterization/smoke gate exists.                                                                                            | native build/smoke plus selection/limit checks                              |
| CLN-040 | P2  | TODO   | Final reference/duplicate/unused rescan; reassess `timelineHeight.ts`; update before/after metrics.                                                                                          | focused suites, then optional heavyweight pass only with user authorization |

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
