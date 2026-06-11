# Decompose the large web components
_Plan written 2026-06-09. Branch:_ `feat/pr-review-interface`_._
## Recommendation
Decompose the top five files by **extracting cohesive units into named sibling modules**, one file at a time, biggest-first, with `bun typecheck` + targeted tests between each. Every extraction is **behavior-preserving**: move code, fix imports, change nothing else. We do **not** rewrite the hard cores (`onSend`, the orchestration event switch, the streaming hot-path) — those stay put until there's a real reason to touch them.

This is the same method already proven on this branch: `MessagesTimeline` went from 2,367 → 1,417 lines by extracting `workEntryRow.tsx` + `userMessageBody.tsx`, zero behavior change, typecheck-clean.
## The targets
| File | Lines | Extractable | Realistic end size | Convention to follow |
|---|---|---|---|---|
| `components/ChatView.tsx` | 8,531 | ~2,500 (handlers → hooks) | ~5,500 | `ChatView.logic.ts`, `ChatView.selectors.ts`, `chat/*` hooks |
| `components/Sidebar.tsx` | 6,032 | ~2,500–3,000 | ~3,000–3,500 | `Sidebar.logic.ts`, new `Sidebar.*.tsx` + `useSidebar*` hooks |
| `store.ts` | 4,104 | ~2,000 (slices) | ~200 (thin re-export) | `storeSelectors.ts`, `threadDerivation.ts`, new `storeSlices/*` |
| `composerDraftStore.ts` | 3,478 | ~1,500 | ~1,000 | `composerDraftStore.test.ts`, new slice modules |
| `routes/_chat.settings.tsx` | 3,398 | ~1,800 | ~1,200 | existing `components/settings/*` primitives |
## Principles (apply to every file)
1. **Behavior-preserving only.** Move definitions, re-import them, keep JSX/classNames/logic byte-identical. No "while I'm here" changes.
  
2. **One file per cycle, verify between.** `bun typecheck` after each extraction; run the file's existing test (`store.test.ts`, `composerDraftStore.test.ts`, `MessagesTimeline.test.tsx`) where one exists. Full `fmt`/`lint`/`typecheck` once at the end of each file's cycle.
  
3. **Reuse the established split.** Don't invent new conventions where one exists (`*.logic.ts` for pure functions, `components/settings/*` for panels, `chat/*` for chat hooks).
  
4. **Stop at the hard cores.** Three things are explicitly out of scope for a mechanical pass — flagged per-file below. Touching them is a separate, opt-in refactor.
  
5. **Each extraction is its own reviewable diff.** No giant cumulative PR.
  

* * *
## File 1 — `store.ts` (do FIRST)
**Why first:** it's the dependency root. Slicing it clarifies the data model that ChatView and Sidebar both consume, and the wins are genuinely isolated. Zustand single-store today; pure transition helpers at module scope.

**Phase 1 — clean wins (low risk):**

- `storePersistence/hydration.ts` — `readPersistedState`, `persistState`, `persistAppStateNow`, debouncer, `beforeunload`, subscriber (~150 lines). Only reads `state.projects`.
  
- `storeSlices/projects.ts` — project normalize/upsert/remove + actions + `projectCwdKey`/`basenameOfPath` (~180 lines). Only cross-link is read-only `projectId` on Thread.
  
- `storeSlices/threadProposedPlans.ts` — normalize + equality + slice builder + one event handler (~100 lines).
  

**Phase 2 — interdependent slices (medium):**

- `storeSlices/sidebarSummaries.ts` (~120) — summary projection + signal derivation.
  
- `storeSlices/threadActivities.ts` (~200) — normalize, dedup, scoring, capping.
  
- `storeSlices/threadMessages.ts` (~200) — normalize + streaming merge. **Blocker:** hot-path merge reads turn/session state → extract `selectLiveMessageState(state, prev)` as a pure param.
  
- `storeSlices/threadShell.ts` (~250) — shell + session metadata.
  

**Phase 3 — hard core (opt-in, flag before doing):**

- `storeSlices/threadTurns.ts` (~300) — turn lifecycle + diff + revert. Revert touches messages/activities/plans atomically; needs a `revertThreadByTurnCount` orchestrator.
  
- **Event dispatcher** — `applyOrchestrationEvent` is a 16-way switch (~600 lines). Converting to a per-slice handler registry is the highest-value move but the riskiest. **Decision needed before starting.**
  

**End state:** `store.ts` becomes a thin store-creation + re-export layer (~200 lines). `storeSelectors.ts`/`threadDerivation.ts` unchanged.

* * *
## File 2 — `composerDraftStore.ts`
Zustand + persistence middleware. Naturally slice-shaped. Sibling test exists.

**Pre-step:** extract shared cleanup utils first — `revokeObjectPreviewUrl`, `revokeDraftPreviewUrls`, `revokeQueuedTurnPreviewUrls`, `shouldRemoveDraft` → `composerDraftUtils.ts`. Many actions depend on these, so they must move before the slices.

**Order (easy → hard):**

1. Runtime/interaction modes (~60) — trivial setters.
  
2. Queued turns (~130) — list ops + URL revoke callback.
  
3. Assistant selections (~130) — dedup/normalize only.
  
4. Terminal contexts (~270) — already leans on `lib/terminalContext`.
  
5. Images/attachments (~80 actions + ~950 hydration/storage helpers) — large helper surface; move persistence code carefully.
  
6. Draft-thread metadata (~380) — clean boundary, but cleanup loops call revoke utils.
  
7. Model selection + options (~290 + ~450 helpers) — hardest: sticky-state sync, per-provider merge, legacy migrations.
  

**Keep central:** `partialize`/`merge`/`migrate` persistence wiring, and the cross-slice orchestrators `clearComposerContent` / `copyTransferableComposerState`.

* * *
## File 3 — `routes/_chat.settings.tsx`
Easiest structurally — 11 panels rendered by inline functions, and `components/settings/` already holds the shared primitives (`SettingsSection`, `SettingsRow`, `SettingResetButton`, etc.). Each panel becomes `components/settings/<Name>Settings.tsx` taking `{settings, defaults, updateSettings}` + section-specific props.

**Order (easy → hard):**

1. Notifications (64) · 2. Behavior (174) · 3. Appearance (213) · 4. General (195) · 5. Sandboxes (219) · 6. Advanced (97) · 7. Worktrees (109) · 8. Provider visibility (62) · 9. Provider updates (73) · 10. Archived threads (100) · 11. Git-text-gen model (47).
  

**Hard / defer:** Custom models (~~140, four interdependent per-provider state maps) and Provider installs (~~424, cascading per-provider field ternaries). Extract a `ProviderInstallRow.tsx` to cut nesting before attempting the rest.

**Pragmatic stop point:** panels 1–7 drop the route to ~1,200 lines in ~2–3 hours. Provider/model sections can wait.

* * *
## File 4 — `Sidebar.tsx`
`Sidebar.logic.ts` (1,101 lines) already exists for pure functions — move more there; put components/hooks in new `Sidebar.*` files.

**Tier 1 — zero coupling (~740 lines):**

- `Sidebar.utilities.ts` — `formatRelativeTime`, `toThreadPr`, `prStatusIndicator`, `terminalStatusFromThreadState`, `resolveWorktreeBadgeLabel`, `resolveThreadRowMetaChips`, jump-label helpers (move into existing `Sidebar.logic.ts`).
  
- `Sidebar.icons.tsx` — `WorktreeBadgeGlyph`, `ThreadStatusTrailingGlyph`, `ProviderAvatarWithTerminal`, `ThreadPrStatusBadge`.
  
- `Sidebar.menus.tsx` — `ProjectSortMenu`, `ThreadSortMenuItems`, `ChatSortMenu`, `SidebarPrimaryAction`.
  
- `Sidebar.sortable.tsx` — `SortableProjectItem`, `SortableWorkspaceItem`. · `Sidebar.picker.tsx` — `SidebarSegmentedPicker`. · `Sidebar.subagent.tsx`.
  

**Tier 2 — prop-passing components (~1,330 lines):** `Sidebar.threads.tsx` (row renderers), `Sidebar.project.tsx`, `Sidebar.workspace.tsx`, `Sidebar.desktopUpdate.tsx`, `Sidebar.search.tsx` (already semi-isolated).

**Tier 3 — hooks (~880 lines):** `useSidebarThreadActions`, `useSidebarProjectActions`, `useSidebarDragDrop`, `useSidebarKeybindings`, `useSidebarThreadSelection`.

**Keep in main:** the ~2,500-line JSX return + state orchestration.

* * *
## File 5 — `ChatView.tsx` (do LAST)
Biggest and most entangled. The 3-file convention (`.logic.ts`, `.selectors.ts`) and many `chat/*` hooks already exist — extend them. The model-selection memos (~lines 1449–1864) are already well-modularized; leave them.

**Phase 1 — clean hooks (low risk):**

- `hooks/useExpandedImagePreview.ts` (~~50) ·~~ `ChatView.dispatch.ts` ~~(~~180, local dispatch state) · `ChatView.environment.ts` (~~250, runtime/interaction/env mode) · timeline dismissal callbacks (~~85).
  

**Phase 2 — medium hooks:**

- `useTerminalWorkspace.ts` (~~280, 18 callbacks → store) ·~~ `useProjectScripts.ts` ~~(~~270) · `usePendingUserInputHandling.ts` (~~210) ·~~ `useTranscriptScrolling.ts` ~~(~~180) · `useQueuedComposerTurns.ts` (~~90) ·~~ `useComposerTriggers.ts` ~~(~~270, slash/mention cursor machine) · voice recording (~190 → existing `useComposerVoiceController.ts`).
  

**Hard core — DO NOT extract mechanically:**

- `onSend` (657 lines, lines 5254–5911) — choreographs 20+ state mutations. Leave whole.
  
- `onEditUserMessage`, `onImplementPlanInNewThread`, `onPromptChange` — wired into the send/optimistic-update flow. Leave whole.
  

**End state:** ~5,500 lines, with ~3,000 lines of handler logic relocated into testable hooks. Still large, but the send choreography stays intact and the surface is readable.

* * *
## Suggested sequence
`store.ts` → `composerDraftStore.ts` → `_chat.settings.tsx` → `Sidebar.tsx` → `ChatView.tsx`.

Stores first (they define the data model the components consume), settings next (lowest risk, fast confidence), then the two big components. Each file is its own cycle ending in a green typecheck + its existing tests; each extraction within a file is a separate reviewable commit.
## Decisions I need from you
1. **Event-dispatcher refactor (store.ts Phase 3):** mechanical slice extraction only, or also convert the 16-way `applyOrchestrationEvent` switch into a handler registry? The registry is the biggest maintainability win and the biggest risk.
  
2. **Depth per file:** stop at the "pragmatic stop point" for each (clean + medium tiers), or push through the hard tiers too?
  
3. **Commit granularity:** one commit per extraction (more, smaller diffs) or one per file (fewer, larger)?
  
4. **Tests:** add new sibling `.test.ts` for each extracted store slice, or rely on the existing aggregate store tests during the move?
