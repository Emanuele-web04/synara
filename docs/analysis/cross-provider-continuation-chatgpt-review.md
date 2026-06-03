# Cross-Provider Continuation ChatGPT Review

Updated: 2026-06-03
Branch: `codex/provider-handoff-v5-polish`
Worktree: `/Users/joegarbarino/Desktop/synara-provider-handoff-v5`

## Feature Summary

This PR finishes the linked-thread version of cross-provider continuation. In a provider-bound thread, the provider/model picker still allows same-provider model changes and now exposes "Continue with..." rows for other usable providers. Choosing a target provider opens a confirmation dialog, then reuses the existing `thread.handoff.create` linked handoff flow.

This is intentionally not same-thread provider switching. The original provider session remains unchanged, and provider-native hidden state, pending approvals, callbacks, runtime state, and provider tool state do not transfer.

## What Changed

- Extracted provider handoff confirmation UI into `ProviderHandoffDialog`.
- Kept handoff state, preview state, copy state, and command dispatch ownership in `ChatView`.
- Added context-preview disclosure browser coverage for collapsed state, expansion, copy, image-copy notice, queued-turn warning, Cancel, and Continue callbacks.
- Preserved current draft transfer behavior from V2: prompt, assistant selections, terminal contexts, and current images copy to the target draft; queued follow-ups stay on the source thread.
- Kept context preview source of truth from V3: web preview and server bootstrap use `@t3tools/shared/handoffContext`.
- Polished header/sidebar continuation labels and tooltips for latest continuation plus extra-count behavior.
- Changed `ChatView.browser.tsx` composer lookup from `[contenteditable="true"]` to `[data-testid="composer-editor"]`.
- Kept same-thread provider segments deferred to V6.

## Files Touched

- `apps/web/src/components/chat/ProviderHandoffDialog.tsx`
- `apps/web/src/components/chat/ProviderHandoffDialog.browser.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.browser.tsx`
- `apps/web/src/components/chat/ProviderModelPicker.tsx`
- `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`
- `apps/web/src/components/chat/ComposerModelEffortPicker.tsx`
- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/chat/ChatHeader.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/SidebarMetaChip.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/lib/threadHandoff.ts`
- `apps/web/src/lib/threadHandoff.test.ts`
- `apps/server/src/orchestration/handoff.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `packages/shared/package.json`
- `packages/shared/src/handoffContext.ts`
- `packages/shared/src/handoffContext.test.ts`
- `docs/analysis/cross-provider-continuation-roadmap.md`
- `docs/analysis/cross-provider-continuation-chatgpt-review.md`

## Verification

Passed:

- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun install --frozen-lockfile`
- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/lib/threadHandoff.test.ts src/components/chat/ChatHeader.test.ts src/components/Sidebar.logic.test.ts src/components/ChatView.logic.test.ts src/composerDraftStore.test.ts` from `apps/web`
  - 5 files, 197 tests passed.
- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58127 bun run test:browser src/components/chat/ProviderHandoffDialog.browser.tsx --api 58128 --reporter=verbose --testTimeout 30000 --hookTimeout 30000 --teardownTimeout 30000` from `apps/web`
  - 1 file, 3 tests passed.
- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58111 bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58112 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web`
  - 1 file, 18 tests passed.
- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test` from `packages/shared`
  - 14 files, 141 tests passed.
- `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` from `apps/server`
  - 2 files, 58 tests passed. Node emitted the existing experimental SQLite warning.
- `git -c core.fsmonitor=false diff --check -- ...` with explicit V1-V5 handoff paths
  - Passed.

Blocked or skipped:

- Focused `ChatView.browser.tsx` handoff-flow coverage was attempted but not retained. The focused run stayed at `Loading projects...` and could not mount `[data-testid="composer-editor"]`; the neighboring pre-existing `"opens the composer model picker"` focused run failed the same way, so this appears to be a ChatView browser hydration/MSW issue rather than a handoff-specific regression.
- Final browser reruns later failed before test import with Vite/Babel dependency-resolution errors: `Yallist is not a constructor` and `_browserslist.findConfigFile is not a function`. Direct inspection showed installed `browserslist@4.28.1` does not expose `findConfigFile`. Earlier dialog and picker browser passes are recorded above.
- Broad `git status` / `git diff` scans hung locally after dependency install, apparently due Git/fsmonitor scanning. Intended file inspection used explicit untracked/path checks instead.
- `bun fmt`, `bun lint`, and `bun typecheck` were skipped per the V5 plan and repo instruction.

## Known Limitations

- Continuation is linked-thread handoff only.
- Same-thread provider segments are not implemented.
- Source-side continuation state is derived from projected target-thread handoff metadata; no reverse persisted source-thread field exists.
- Sidebar source chips navigate to the latest visible continuation only; older continuations are available from the header menu.
- Archived target continuations are not promoted in compact source UI.
- Context preview is context-only; it excludes the provider wrapper and latest draft message.
- Final bootstrap truncation can differ if the user edits the first target-thread message before sending.
- Current draft image copy is best-effort and does not add provider capability gating.
- Queued follow-up turns stay on the original thread.

## V6 Deferred Architecture

V6 is the future same-thread provider segment architecture. It should not start without an explicit planning phase covering:

- Durable transcript segment model.
- Per-segment provider/session binding.
- Segment dividers and UI affordances.
- Rollback/replay semantics.
- Persistence migration strategy.
- Reconnect, partial stream, approval, callback, and runtime failure behavior.
- Provider adapter contract implications.

## Review Questions

1. Does the dialog/component split keep the right boundary: UI in `ProviderHandoffDialog`, state and command dispatch in `ChatView`?
2. Is the linked-handoff product copy honest enough about what transfers and what does not?
3. Are the source/target continuation labels and tooltips clear without making the sidebar too noisy?
4. Is the V2 image draft-copy policy safe enough, or should V6 or a later linked-handoff polish add provider capability gating before send?
5. Does the shared `@t3tools/shared/handoffContext` API look stable enough, or should the naming/budget helper be adjusted before merge?
6. What is the best way to restore reliable full `ChatView.browser.tsx` handoff-flow coverage, given the focused-run project hydration blocker?
