# Synara Cleanup Audit and Execution Plan

> Generated: 2026-07-19
> Status: in progress — CLN-010 complete
> Scope: monolith decomposition, duplicated logic/views/CSS/functions, unused files/imports
> Source of truth: this file only; no per-file cleanup documents

## Objective and boundaries

Refactor the existing code incrementally so the largest multi-responsibility modules have tested,
cohesive boundaries; repeated knowledge has one domain owner; duplicate views/styles/functions are
consolidated; and dead files/imports are deleted. Preserve public behavior and existing service/store
facades while callers migrate.

Explicitly out of scope:

- product features, visual redesigns, performance work, protocol changes, schema migrations, and bug
  fixes unrelated to a refactor
- splitting files only to meet a line-count target
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

| Pri | File | LOC | Demonstrated responsibilities / intended boundary |
|---|---|---:|---|
| P0 | `apps/web/src/components/ChatView.tsx` | 11,971 | One 10,857-line component owns provider catalog, voice, automation setup, composer persistence, send/queue/steer, transcript following, terminal control, dialogs, and layout. Adopt existing provider/voice hooks first, then extract responsibility controllers without moving list scroll ownership. |
| P0 | `apps/web/src/components/Sidebar.tsx` | 7,940 | Navigation, pins, archive/delete, project-run lifecycle, drag/drop, PR queries, and duplicated thread rows. Extract one row owner and controller hooks while preserving selector granularity. |
| P0 | `apps/web/src/composerDraftStore.ts` | 5,185 | Types/schema, model/draft normalization, blob persistence/migration, Zustand actions, and hooks. Preserve one public facade/storage key; split pure migration, attachments, model selection, and actions. |
| P0 | `apps/web/src/store.ts` | 4,714 | Persistence, snapshot normalization, projections, event reduction, sync actions, and React wiring. Preserve pure reducer/facade APIs. |
| P0 | `apps/desktop/src/main.ts` | 3,722 | Logging, updater, backend supervision, protocol/static serving, IPC, windows, and lifecycle. Keep bootstrap in `main.ts`; extract a few existing controllers. |
| P0 | `apps/desktop/src/browserManager.ts` | 2,149 | OAuth/popups, tab commands, runtime lifecycle, suspension, and state synchronization. Keep a facade; extract popup, tab-runtime, and state operations after characterization. |
| P1 | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | 5,590 | Pure error/token/request/message mapping plus a 3,900-line live session implementation. Move pure Claude modules first; keep Layer/service exports stable. |
| P1 | `apps/server/src/provider/Layers/OpenCodeAdapter.ts` | 4,733 | Runtime event mapping, model inventory/catalog normalization, and live orchestration. Extract the two pure owners before touching lifecycle. |
| P1 | `apps/server/src/codexAppServerManager.ts` | 3,684 | Session/process lifecycle, transport/routing, discovery/catalog, recovery, and event projection. Keep the manager API; extract discovery and transport collaborators. |
| P1 | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | 3,728 | Pure event/activity mapping, payload bounding, delivery buffers, worker recovery, and replay. Extract mapping/bounding first; keep replay/lifecycle in the Effect Layer and preserve one-way transcript behavior. |
| P1 | `apps/web/src/components/chat/MessagesTimeline.tsx` | 3,847 | List follow/scroll ownership plus user, work, and tool row renderers. Keep LegendList and bottom-stick ownership together; extract memoized row views and transition hooks. |
| P1 | `apps/web/src/routes/_chat.settings.tsx` | 3,801 | One component subscribes to and renders every settings domain. Move existing panel seams into panel-owned components and migrate bespoke disclosure UI to the shared motion primitives. |
| P1 | `packages/contracts/src/orchestration.ts` | 2,291 | Read models, commands, events, and RPC/projection schemas. Split by schema family while preserving the current public export surface. |
| P1 | `apps/server/src/git/Layers/GitCore.ts` | 2,911 | Execution/locks, status/remotes, commit/push/pull, and branch/worktree/stash. Extract private factories behind the existing GitCore service. |
| P1 | `apps/server/src/terminal/Layers/Manager.ts` | 2,569 | Process inspection, stream/title parsing, PTY lifecycle/backpressure, and history persistence. Extract pure process/parser modules then history storage; keep the manager service. |

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

| ID | Pri | Status | Workstream | Primary validation |
|---|---|---|---|---|
| CLN-001 | P0 | DONE | Remove all 40 unused imports/locals/functions/parameters; delete computations made solely for dead values. | focused Oxlint unused scan; affected unit tests |
| CLN-002 | P0 | DONE | Delete confirmed dead/superseded modules and obsolete tests; migrate the remaining collapse constant import. | web/server focused tests; repo-wide reference scan |
| CLN-003 | P0 | DONE | Consolidate exact low-risk domain logic: project normalization, profile selectors, terminal-context sync, automation warning updates, persistence error mapper. | existing owner tests plus affected caller tests |
| CLN-004 | P1 | DONE | Consolidate focused duplicated views/motion: Sidebar row variants, pinned/marker editable row, settings/branch/environment disclosure controls, marketing platform icon. | web unit/browser tests and disclosure tests |
| CLN-005 | P1 | DONE | Consolidate server/desktop repeated workflows: ACP support helpers, provider-health probe, branch naming, semver, provider locks, redaction, desktop shutdown/tab activation, GitHub output. | focused subsystem suites |
| CLN-010 | P0 | DONE | Decompose `store.ts` and its test by persistence/normalization/projection/event reducer while keeping the facade. | `apps/web/src/store.test.ts` and selector tests |
| CLN-011 | P0 | TODO | Decompose `composerDraftStore.ts` and its test by migration, attachments, model selection, and actions while preserving storage compatibility. | composer draft/store tests |
| CLN-012 | P0 | TODO | Shrink `ChatView`: adopt existing provider-model and voice hooks, then extract automation setup, terminal actions, composer send/queue, and dialog/layout owners. | ChatView logic/browser suites and hook tests |
| CLN-013 | P0 | TODO | Shrink `Sidebar`: shared thread row, pin/archive/delete controller, project-run controller, with selector granularity unchanged. | Sidebar logic/UI/import plus new row characterization |
| CLN-014 | P1 | TODO | Split `MessagesTimeline`, `session-logic`, chat route surfaces, and their tests along existing row/derivation/surface seams without changing scroll-follow semantics. | timeline unit/browser suites; session logic tests |
| CLN-015 | P1 | TODO | Split settings route into panel-owned components with local subscriptions. | focused settings render/disclosure tests |
| CLN-020 | P1 | TODO | Decompose Claude and OpenCode adapters along pure mapper/catalog seams; split their tests in lockstep. | adapter and runtime suites |
| CLN-021 | P1 | TODO | Decompose Codex app-server manager into discovery/catalog and transport/routing collaborators; consolidate send/steer input shaping. | manager and transport suites |
| CLN-022 | P1 | TODO | Decompose ProviderRuntimeIngestion into pure activity mapping, bounded payload helpers, state/buffer coordinator, and Layer/replay owner. | ingestion/buffer/projection suites |
| CLN-023 | P1 | TODO | Split GitCore and Terminal Manager behind existing service facades. | GitCore and terminal manager/parser/history suites |
| CLN-024 | P2 | TODO | Share projection message row decoding and profile token-attribution SQL without changing query shape. | snapshot/repository/profile suites |
| CLN-030 | P0 | TODO | Decompose Electron `main.ts` into logging, updater, backend supervision, static protocol, and window controllers; keep lifecycle/bootstrap. | add characterization, then desktop focused suites/smoke |
| CLN-031 | P0 | TODO | Split BrowserManager into popup, tab-runtime, and state operations behind its facade. | new manager characterization + browser session tests |
| CLN-032 | P1 | TODO | Split AppSnap persistence, resumable download policy/engine/adapter, and desktop artifact build phases. | existing AppSnap/download/build tests |
| CLN-033 | P1 | TODO | Split contracts orchestration schema families and consolidate shared thread/browser API fields while preserving exports. | contracts orchestration/rpc/ws tests; desktop preload/web API tests |
| CLN-034 | P2 | TODO | Split shared subagent decoding from identity indexing and centralize alias-key readers. | shared subagent tests |
| CLN-035 | P2 | TODO | Split native AppSnap capture only after a deterministic Swift characterization/smoke gate exists. | native build/smoke plus selection/limit checks |
| CLN-040 | P2 | TODO | Final reference/duplicate/unused rescan; reassess `timelineHeight.ts`; update before/after metrics. | focused suites, then optional heavyweight pass only with user authorization |

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
2. Add/confirm the smallest characterization gate before moving behavior-bearing code.
3. Make one cohesive, reversible extraction or consolidation at a time.
4. Run the smallest focused tests after each meaningful move.
5. Update this tracker and record results before starting the next item.
6. Do not commit unrelated work. If commits are created, keep each tracker item independently
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
