# Cross-Provider Continuation Roadmap

Updated: 2026-06-03
Status: V1-V5 linked handoff implemented; draft review PR prepared
Decision: GO for linked handoff flow; STOP for same-thread provider segments until V6 architecture.

## Purpose

This file is the living roadmap for making cross-provider continuation feel like a first-class Synara product feature. Update it whenever the scope, order, acceptance criteria, or implementation status changes.

The product concept is:

> Continue this conversation with another provider.

It is not:

> Switch the provider inside the same native session.

The first implementation should reuse linked handoff threads. It must not imply that provider-native hidden state, resume cursors, pending approvals, callback ids, or provider runtime state are transferred.

## Current Findings

- Active threads are provider-bound after they have messages, turns, or a provider session.
- `ChatView.tsx` derives `lockedProvider` from the session provider, thread model selection, or draft provider.
- `ProviderModelPicker.tsx` now keeps locked-provider model changes first and exposes "Continue with..." rows for cross-provider linked handoff.
- `ProviderCommandReactor` rejects a turn when the requested provider differs from the thread-bound provider.
- `useThreadHandoff` already creates a new thread, imports messages and activities, copies transferable composer state, syncs the shell snapshot, and navigates to the new thread.
- `thread.handoff.create` stores target-thread handoff metadata with `sourceThreadId`, `sourceProvider`, `importedAt`, and `bootstrapStatus`.
- Target handoff threads display clickable "Continued from ..." affordances in the header/sidebar.
- Source threads display derived "Continued with ..." affordances when projected target handoff threads point back to them.
- Source-side continuation links are derived from projected target-thread `handoff.sourceThreadId` metadata, not persisted as a separate reverse field.
- `@t3tools/shared/handoffContext` builds bounded text context from imported handoff messages, source provider, thread title, branch, worktree, earlier summary, and recent messages.
- The server runtime and V3 web preview use the same shared context builder and the same handoff wrapper-overhead budget helper.
- Handoff bootstrap context is text-only. Imported messages may carry attachment metadata, but the provider-facing bootstrap text does not transfer attachment payloads.
- Composer draft transfer currently copies prompt, assistant selections, terminal contexts, current images, matching persisted image attachment records, and matching non-persisted image ids to the target thread while preserving the source draft.
- Blob-backed current image preview URLs are cloned with `URL.createObjectURL(image.file)` when available. Data URL previews and persisted attachment records are preserved as-is.
- Queued follow-up turns stay on the source thread in V2 and are not copied by `copyTransferableComposerState`.
- Handoff is already gated against busy/running work, pending approvals, pending user input, no transferable messages, unavailable providers, and repeated handoff before native follow-up.

## Version Roadmap

| Version | Status | Decision | Goal | Acceptance Criteria |
| --- | --- | --- | --- | --- |
| V0 | Done | GO | Investigation/design only. | Current provider lock, handoff primitives, context packet, draft behavior, and test surface are understood. |
| V1 | Completed | GO | Expose cross-provider continuation from the locked provider/model picker. | Selecting another provider in a provider-bound thread opens a clear "Continue with ..." confirmation flow that reuses existing handoff creation. |
| V2 | Completed | GO | Improve draft preservation across handoff. | Prompt, assistant selections, terminal contexts, and current draft images are preserved on the target draft; source draft is unchanged; queued follow-ups are explicitly left on the source thread. |
| V3 | Completed | GO | Add context preview. | Preview uses shared context generation, stays context-only, and is visible from the provider handoff confirmation dialog. |
| V4 | Implemented | GO | Add richer visible thread linking. | Target shows clickable "Continued from ..."; source shows latest "Continued with ..." plus additional targets in header; links survive refresh because they are derived from projection state. |
| V5 | Implemented | GO | Final linked handoff polish and review PR. | Provider handoff confirmation dialog is extracted, focused browser coverage covers dialog copy/preview/callbacks, picker browser coverage still passes, source/target link labels are clearer, and ChatGPT review artifact exists. |
| V6 | Future only | STOP | Same-thread provider segments. | Do not build until there is a durable segment model, per-segment provider/session binding, transcript dividers, rollback/replay semantics, and migration strategy. |

## V1 Implementation Checklist

Recommended PR title:

> Expose cross-provider handoff from provider picker

V1 scope:

- Update the locked-provider picker state so same-provider model selection still appears first.
- Add a "Continue with..." section listing available target providers.
- Target-provider rows must request handoff; they must not call normal `onProviderModelChange`.
- Add optional picker props for handoff targets and handoff request handling.
- Add a confirmation dialog from `ChatView.tsx` using the existing dialog primitives.
- Use product language like "Continue this conversation with Claude" and "Claude will receive a compact context packet from this thread."
- State that the original provider session stays unchanged.
- State that provider-native hidden state, approvals, and callback state cannot transfer.
- Warn when the source composer draft includes images, persisted attachments, or queued turns because those are not copied in V1.
- Preserve the existing source draft behavior.
- Reuse `onCreateHandoffThread` / `createThreadHandoff` for the actual handoff.
- Leave server provider-binding guards intact.
- Do not change contracts, persistence, provider adapters, or server handoff context generation.

V1 must not include:

- Same-thread provider mutation.
- Provider session segment schema.
- Context preview.
- Reverse source-thread linking.
- New provider adapter behavior.
- Broad migrations or projection changes.

## V1 Files

Actual edit set:

- `apps/web/src/components/chat/ProviderModelPicker.tsx`
- `apps/web/src/components/chat/ComposerModelEffortPicker.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`

No new component was added; the confirmation dialog is local to `ChatView.tsx` because it reuses existing handoff state and callbacks there.

Deferred edit set:

- `apps/web/src/components/ChatView.browser.tsx`; targeted picker coverage was added, but full ChatView browser coverage remains blocked by a focused-run composer mount issue in the existing harness. Stable `ChatView.logic.test.ts` coverage was added for dialog copy, and stable `ProviderModelPicker.browser.tsx` coverage exercises picker-originated handoff requests.

Expected no-touch areas:

- `packages/contracts`
- `apps/server/src/provider`
- `apps/server/src/orchestration` except tests only if a surprising gap is found
- persistence migrations

## V2 Files

Actual edit set:

- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `docs/analysis/cross-provider-continuation-roadmap.md`

Expected no-touch areas stayed untouched:

- `packages/contracts`
- `apps/server/src/provider`
- `apps/server/src/orchestration`
- persistence migrations

## V2 Implementation Notes

- `copyTransferableComposerState(sourceThreadId, targetThreadId)` remains the public store action.
- Current draft images are copied into the target draft.
- Blob preview URLs are cloned when possible so the source and target drafts do not share the same revocation-sensitive blob URL.
- Data URL previews and matching persisted attachment records are preserved.
- `nonPersistedImageIds` are copied only when they still match copied current images.
- Source drafts are left unchanged.
- Source queued follow-up turns are not copied. Target queued turns, if any already exist, remain target-local state.
- No provider capability gating was added for images; existing send-time validation remains responsible for dispatch compatibility.
- Dialog copy now says current images are copied when present and queued follow-ups stay on the original thread when present.

## V3 Files

Actual edit set:

- `packages/shared/package.json`
- `packages/shared/src/handoffContext.ts`
- `packages/shared/src/handoffContext.test.ts`
- `apps/server/src/orchestration/handoff.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/web/src/lib/threadHandoff.ts`
- `apps/web/src/lib/threadHandoff.test.ts`
- `apps/web/src/components/ChatView.tsx`
- `docs/analysis/cross-provider-continuation-roadmap.md`

Expected no-touch areas stayed untouched:

- `packages/contracts`
- `apps/server/src/provider`
- persistence migrations
- same-thread provider/session semantics

## V3 Implementation Notes

- Added `@t3tools/shared/handoffContext` as the shared context source of truth.
- Server `handoff.ts` is now a compatibility re-export adapter over the shared module.
- `ProviderCommandReactor` now computes handoff bootstrap budget through the shared helper instead of a local wrapper-overhead constant.
- Web handoff preview reuses `buildThreadHandoffImportedMessages(thread)`, then calls the shared context builder.
- Preview budget is computed from the current source composer prompt because V2 copies that prompt to the target draft.
- The confirmation dialog renders a collapsed "Context preview" section only when preview text exists.
- The preview is context-only, not the full provider input wrapper or latest draft message.
- Copy button support was added to the preview block; no new RPC or contract method was added.

## V4 Files

Actual edit set:

- `apps/web/src/lib/threadHandoff.ts`
- `apps/web/src/lib/threadHandoff.test.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/chat/ChatHeader.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/SidebarMetaChip.tsx`
- `docs/analysis/cross-provider-continuation-roadmap.md`

Expected no-touch areas stayed untouched:

- `packages/contracts`
- `apps/server`
- persistence migrations
- provider adapters
- same-thread provider/session semantics

## V4 Implementation Notes

- Outgoing source-thread links are derived from existing projected target-thread handoff metadata.
- No reverse source-thread contract field, migration, or server command was added.
- Header target-side "Continued from ..." badges navigate back to the source thread.
- Header source-side "Continued with ..." badges navigate to the latest target continuation, with a menu for additional continuations.
- Sidebar rows show compact incoming/outgoing handoff meta chips and navigate to the source/latest target when clicked.
- Archived target continuations are not promoted into compact outgoing link UI.
- This is still a visibility/navigation slice; final hardening should audit the full cross-provider continuation UX before planning V5.

## V5 Files

Actual edit set:

- `apps/web/src/components/chat/ProviderHandoffDialog.tsx`
- `apps/web/src/components/chat/ProviderHandoffDialog.browser.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.browser.tsx`
- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/chat/ChatHeader.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/lib/threadHandoff.ts`
- `apps/web/src/lib/threadHandoff.test.ts`
- `docs/analysis/cross-provider-continuation-roadmap.md`
- `docs/analysis/cross-provider-continuation-chatgpt-review.md`

Carried-forward V1-V4 handoff files in the clean V5 worktree:

- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/handoff.ts`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/SidebarMetaChip.tsx`
- `apps/web/src/components/chat/ComposerModelEffortPicker.tsx`
- `apps/web/src/components/chat/ProviderModelPicker.tsx`
- `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `packages/shared/package.json`
- `packages/shared/src/handoffContext.ts`
- `packages/shared/src/handoffContext.test.ts`

Expected no-touch areas stayed untouched:

- `packages/contracts`
- `apps/server/src/provider`
- persistence migrations
- provider adapters
- provider runtime/session mutation
- same-thread provider/session semantics

## V5 Implementation Notes

- V5 remains linked-thread continuation only. It preserves `thread.handoff.create` and does not add same-thread provider segments.
- Provider handoff confirmation UI moved from `ChatView.tsx` into `ProviderHandoffDialog.tsx`; state and command ownership stay in `ChatView.tsx`.
- The extracted dialog preserves V1-V3 copy: compact context packet, original provider session unchanged, provider-native/tool state not transferred, prompt/selections/terminal contexts copied, current images copied, queued turns stay on source.
- The dialog preview remains collapsed by default, shows character count, supports copy, and renders only when preview text exists.
- `ChatView.browser.tsx` composer lookup now uses `[data-testid="composer-editor"]` instead of `[contenteditable="true"]`.
- Source/target continuation affordances have clearer accessible labels/tooltips, including latest continuation plus extra-count wording.
- Sidebar source chips still stay compact and navigate to the latest visible continuation only; older continuations remain available from the header menu.
- `docs/analysis/cross-provider-continuation-chatgpt-review.md` is the external review artifact for ChatGPT; see [cross-provider-continuation-chatgpt-review.md](./cross-provider-continuation-chatgpt-review.md).
- Full `ChatView.browser.tsx` handoff-flow coverage was attempted but not retained because focused runs of that file remain blocked at project hydration (`Loading projects...`) and cannot mount the composer even for the neighboring pre-existing model-picker spec.

## Final Hardening Audit Before V5

Status: Completed on 2026-06-03.

Purpose:

- Confirm V1-V4 do not accidentally imply same-thread provider switching.
- Confirm the roadmap records every intentional simplification before V5 planning.
- Re-run targeted tests that cover shared handoff context, web handoff helpers, draft transfer, header/sidebar links, picker behavior, and server bootstrap budget behavior.
- Keep `bun fmt`, `bun lint`, and `bun typecheck` skipped unless explicitly requested.

Intentional simplifications to keep visible:

- Cross-provider continuation is still linked-thread handoff, not same-thread provider mutation.
- Source-side reverse links are derived from projected target handoff metadata; no reverse field, migration, or server command exists.
- Sidebar source chips navigate to the latest visible continuation only; older continuations are available from the header menu.
- Archived target continuations are not promoted in compact source UI.
- Context preview is context-only; it excludes the provider wrapper and latest draft message.
- Context preview final truncation can change if the user edits the first target-thread message before sending.
- Current draft images are copied best-effort; no provider image-capability gating was added in V2.
- Queued follow-up turns stay on the original thread.
- Provider-native hidden state, pending approvals, callbacks, and provider runtime/tool state never transfer.

Pre-V5 gates:

- Fix or replace the focused `ChatView.browser.tsx` harness before relying on it for dialog interaction coverage.
- Decide whether V5 is really same-thread provider segments or a final polish pass over linked handoff UX.
- If V5 means same-thread segments, require a planning phase before implementation.
- Same-thread segments need a durable segment model, per-segment provider/session binding, transcript dividers, rollback/replay semantics, migration strategy, and failure/reconnect behavior before code changes.

Hardening result:

- No new server provider-binding, contracts, migrations, provider adapters, or provider runtime changes are needed for V1-V4.
- Targeted web, shared, server, browser picker, and whitespace diff checks passed.
- Full `ChatView.browser.tsx` dialog interaction coverage remains the main pre-V5 verification gap because the focused browser harness cannot currently mount the composer.

## V1 Test Plan

Targeted automated tests:

- `ProviderModelPicker.browser.tsx`: locked threads show same-provider models plus Continue rows.
- `ProviderModelPicker.browser.tsx`: clicking a target provider calls the handoff request callback, not `onProviderModelChange`.
- `ProviderModelPicker.browser.tsx`: unavailable target providers are disabled or absent with clear labeling.
- `ProviderModelPicker.browser.tsx`: same-provider model selection still works.
- `ChatView.browser.tsx`, if stable: choosing a target provider opens the confirmation dialog; Cancel leaves the current thread unchanged; Continue dispatches `thread.handoff.create`.
- Existing `threadHandoff.test.ts` and `composerDraftStore.test.ts` should continue to cover model resolution and transferable draft behavior.

Manual verification:

- Start an isolated dev instance, not the default shared dev instance.
- Open a provider-bound thread.
- Open the provider/model picker.
- Confirm same-provider model changes still work.
- Choose another provider and verify the Continue dialog copy.
- Cancel and confirm the source thread remains unchanged.
- Confirm and verify a linked handoff thread opens.
- Verify target thread handoff badge appears.
- Verify source draft text is preserved in source and copied to target.
- Verify images/attachments/queued turns are warned about if present.
- Capture screenshots or video for upstream PR.

Commands to run when Bun is available:

```sh
cd /Users/joegarbarino/Desktop/Synara\ PR/apps/web
bun run test src/components/chat/ProviderModelPicker.browser.tsx src/lib/threadHandoff.test.ts src/composerDraftStore.test.ts

cd /Users/joegarbarino/Desktop/Synara\ PR/apps/server
bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts

cd /Users/joegarbarino/Desktop/Synara\ PR
git diff --check
```

Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested in the current conversation.

## Scope Change Log

| Date | Change | Reason |
| --- | --- | --- |
| 2026-06-03 | Created roadmap and selected V1 picker flow as next buildable slice. | User wanted a persistent plan/checklist to avoid losing scope and next steps. |
| 2026-06-03 | Implemented V1 through the existing linked handoff flow; no server/provider-binding/context-generation changes were made. | V1 is a UI exposure of existing handoff primitives, not a new provider-session architecture. |
| 2026-06-03 | Deferred ChatView browser test coverage to a harness-fix pass. | Bun is now available through `/Users/joegarbarino/.hermes/node/bin`, but focused `ChatView.browser.tsx` runs cannot find the composer editor even for a pre-existing spec. |
| 2026-06-03 | Used direct local Vitest binaries as a fallback for targeted non-browser tests. | The repo is Bun-managed, but Bun is not installed in this shell; installed `node_modules/.bin/vitest` is available. |
| 2026-06-03 | Installed `bun@1.3.12` through npm under `/Users/joegarbarino/.hermes/node`; use `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH` or the absolute Bun path in this shell. | Needed the repo-declared package manager version for exact roadmap test commands and isolated dev. |
| 2026-06-03 | Implemented V2 safe draft copy for current images while keeping queued follow-ups on the source thread. | User selected the "copy safe draft" policy for V2. |
| 2026-06-03 | Replaced attempted ChatView browser dialog coverage with focused `ChatView.logic.test.ts` coverage for the conditional dialog copy. | Focused runs of `ChatView.browser.tsx` could not mount the composer even for the pre-existing "opens the composer model picker" spec; the blocker is harness-level, not specific to V2 copy. Stable ProviderModelPicker browser coverage still passed. |
| 2026-06-03 | Implemented V3 context preview through a shared handoff context module instead of a new RPC. | User selected context-only preview and shared utility source of truth during V3 planning. |
| 2026-06-03 | Kept V3 out of sidebar/header handoff menus. | The V3 plan scoped preview to the existing provider picker confirmation dialog. |
| 2026-06-03 | Implemented V4 reverse-visible links as derived web state instead of adding a source-thread contract field. | User selected the derived-index policy to keep V4 durable without a migration. |
| 2026-06-03 | V4 shows the latest outgoing continuation first and keeps older continuations in the header menu. | User selected latest-plus-count behavior for source threads with multiple continuations. |
| 2026-06-03 | Added final hardening audit checklist before V5. | User asked to preserve simplified/deferred decisions so nothing is forgotten before the final phase. |
| 2026-06-03 | Completed final V1-V4 hardening audit. | Targeted tests passed and remaining simplifications are now explicit pre-V5 gates. |
| 2026-06-03 | Reframed V5 as final linked-handoff polish and moved same-thread provider segments to V6. | User wanted V5 to be the PR-quality final linked-thread pass, with same-thread architecture deferred. |
| 2026-06-03 | Implemented V5 in `/Users/joegarbarino/Desktop/synara-provider-handoff-v5` on `codex/provider-handoff-v5-polish` from `origin/main`. | Keeps the PR separate from `devin-acp-provider-v2` and excludes Devin ACP/untracked workspace artifacts. |
| 2026-06-03 | Did not retain full `ChatView.browser.tsx` handoff-flow coverage. | Focused runs of that browser file stayed at `Loading projects...` and could not mount the composer even for the neighboring pre-existing picker spec; dialog and picker browser coverage passed instead. |

## Verification Log

| Date | Command | Result |
| --- | --- | --- |
| 2026-06-03 | `bun run test ...` targeted web/server tests | Blocked: `bun` was not on PATH in this shell. |
| 2026-06-03 | Read-only repo inspection | Confirmed existing linked handoff primitives and server provider-binding guard. |
| 2026-06-03 | `bun --version` | Blocked: `/bin/bash: bun: command not found`. |
| 2026-06-03 | Checked `/Users/joegarbarino/.bun/bin/bun` and `/opt/homebrew/bin/bun` | Blocked: no Bun binary found in either common install location. |
| 2026-06-03 | `bun run test src/components/chat/ProviderModelPicker.browser.tsx src/lib/threadHandoff.test.ts src/composerDraftStore.test.ts` | Not run because Bun is missing from PATH. |
| 2026-06-03 | `bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` | Not run because Bun is missing from PATH. |
| 2026-06-03 | `../../node_modules/.bin/vitest run --passWithNoTests src/lib/threadHandoff.test.ts src/composerDraftStore.test.ts` from `apps/web` | Passed: 2 files, 74 tests. |
| 2026-06-03 | `../../node_modules/.bin/vitest run src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` from `apps/server` | Passed: 2 files, 58 tests. |
| 2026-06-03 | `/Users/joegarbarino/.hermes/node/bin/bun run test src/components/chat/ProviderModelPicker.browser.tsx src/lib/threadHandoff.test.ts src/composerDraftStore.test.ts` from `apps/web` | Passed: 2 files, 74 tests. Note: normal `test` script does not execute the `.browser.tsx` spec. |
| 2026-06-03 | `/Users/joegarbarino/.hermes/node/bin/bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` from `apps/server` | Passed: 2 files, 58 tests. |
| 2026-06-03 | `../../node_modules/.bin/vitest run --config vitest.browser.config.ts src/components/chat/ProviderModelPicker.browser.tsx` from `apps/web` | Initial sandbox run blocked by `listen EPERM` on loopback; escalated run then failed because Playwright Chromium was missing. |
| 2026-06-03 | `./node_modules/.bin/playwright install chromium` from `apps/web` | Passed: installed Chromium and Chromium headless shell into `/Users/joegarbarino/Library/Caches/ms-playwright`. |
| 2026-06-03 | `env PORT=58091 ../../node_modules/.bin/vitest run --config vitest.browser.config.ts src/components/chat/ProviderModelPicker.browser.tsx --api 58092 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Blocked: Vitest API started at `http://localhost:58092/`, then the browser-provider run hung before test results. Process was stopped. |
| 2026-06-03 | `env PORT=58093 ../../node_modules/.bin/vitest run --config vitest.browser.config.ts --browser=chromium src/components/chat/ProviderModelPicker.browser.tsx --api 58094 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Blocked: same browser-provider hang after API startup. Process was stopped. |
| 2026-06-03 | `PORT=58095 /Users/joegarbarino/.hermes/node/bin/bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58096 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Blocked: Chromium launched, but Vitest browser provider hung without test results. Process was stopped. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58103 bun run test:browser src/components/chat/TraitsPicker.browser.tsx --api 58104 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Passed: 1 file, 21 tests. Confirmed the Vitest browser harness worked after stale port cleanup. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58105 bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58106 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Passed: 1 file, 18 tests. Covered locked provider models, Continue rows, enabled handoff callback, disabled target behavior, and unchanged same-provider model selection. |
| 2026-06-03 | Isolated dev dry-run: `env -u T3CODE_AUTH_TOKEN T3CODE_PORT_OFFSET=3158 bun run dev -- --home-dir ./.synara-pr84 --port 58090 --dry-run` | Passed: planned server `58090`, web `8891`, base dir `.synara-pr84`. |
| 2026-06-03 | Isolated dev run with `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH`, `T3CODE_PORT_OFFSET=3158`, `T3CODE_NO_BROWSER=1`, `--home-dir ./.synara-pr84 --port 58090` | Passed: web served on `http://localhost:8891/`; server log reported Synara running on port `58090`. |
| 2026-06-03 | In-app Browser plugin smoke against `http://localhost:8891/` | Blocked: Browser tab navigation failed/timed out. |
| 2026-06-03 | Standalone Playwright smoke against `http://[::1]:8891/` | Partial pass: page returned status `200`, title `Synara`, Vite connected, no console errors; app rendered the Synara home UI after module graph load. Screenshot capture was skipped because Playwright hung waiting for web fonts. Locked-thread handoff picker interaction was not exercised because the isolated state had no provider-bound thread. |
| 2026-06-03 | `git diff --check` | Passed. |
| 2026-06-03 | `git diff --check -- apps/web/src/components/ChatView.tsx apps/web/src/components/chat/ComposerModelEffortPicker.tsx apps/web/src/components/chat/ProviderModelPicker.browser.tsx apps/web/src/components/chat/ProviderModelPicker.tsx` | Passed after the final roadmap update; full `git diff --check` and `git status --short --untracked-files=no` later hung and were stopped. |
| 2026-06-03 | `bun fmt`, `bun lint`, `bun typecheck` | Skipped per explicit V1 plan and repo instruction to avoid these heavyweight checks unless requested. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/composerDraftStore.test.ts src/lib/threadHandoff.test.ts` from `apps/web` | Passed: 2 files, 75 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/composerDraftStore.test.ts src/lib/threadHandoff.test.ts src/components/ChatView.logic.test.ts` from `apps/web` | Passed: 3 files, 118 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58105 bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58106 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Passed: 1 file, 18 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58107 bun run test:browser src/components/ChatView.browser.tsx -t "explains that handoff copies current images" --api 58108 --reporter=verbose --testTimeout 15000 --hookTimeout 15000 --teardownTimeout 15000` from `apps/web` | Failed: focused ChatView browser run could not find the composer editor. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58109 bun run test:browser src/components/ChatView.browser.tsx -t "opens the composer model picker" --api 58110 --reporter=verbose --testTimeout 15000 --hookTimeout 15000 --teardownTimeout 15000` from `apps/web` | Failed: the pre-existing focused ChatView browser spec also could not find the composer editor, confirming a harness/focused-run blocker. |
| 2026-06-03 | `git diff --check` | Passed. |
| 2026-06-03 | `bun fmt`, `bun lint`, `bun typecheck` | Skipped per explicit V2 plan and repo instruction to avoid these heavyweight checks unless requested. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test` from `packages/shared` | Passed: 14 files, 141 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/lib/threadHandoff.test.ts src/components/ChatView.logic.test.ts` from `apps/web` | Passed: 2 files, 50 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts` from `apps/server` | Passed: 1 file, 49 tests. Node emitted the existing experimental SQLite warning. |
| 2026-06-03 | `git diff --check` | Passed. |
| 2026-06-03 | `bun fmt`, `bun lint`, `bun typecheck` | Skipped per explicit V3 plan and repo instruction to avoid these heavyweight checks unless requested. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/lib/threadHandoff.test.ts src/components/chat/ChatHeader.test.ts src/components/Sidebar.logic.test.ts src/components/ChatView.logic.test.ts` from `apps/web` | Passed: 4 files, 125 tests. |
| 2026-06-03 | `git diff --check` | Passed. |
| 2026-06-03 | `bun fmt`, `bun lint`, `bun typecheck` | Skipped per explicit V4 plan and repo instruction to avoid these heavyweight checks unless requested. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/lib/threadHandoff.test.ts src/components/chat/ChatHeader.test.ts src/components/Sidebar.logic.test.ts src/components/ChatView.logic.test.ts src/composerDraftStore.test.ts` from `apps/web` | Passed: 5 files, 196 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test` from `packages/shared` | Passed: 14 files, 141 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` from `apps/server` | Passed: 2 files, 58 tests. Node emitted the existing experimental SQLite warning. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58111 bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58112 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Passed: 1 file, 18 tests. |
| 2026-06-03 | `git diff --check` | Passed. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun install --frozen-lockfile` from V5 worktree root | Passed: installed locked dependencies in the clean worktree; lockfile was unchanged. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/lib/threadHandoff.test.ts src/components/chat/ChatHeader.test.ts src/components/Sidebar.logic.test.ts src/components/ChatView.logic.test.ts src/composerDraftStore.test.ts` from `apps/web` | Passed: 5 files, 197 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58127 bun run test:browser src/components/chat/ProviderHandoffDialog.browser.tsx --api 58128 --reporter=verbose --testTimeout 30000 --hookTimeout 30000 --teardownTimeout 30000` from `apps/web` | Passed: 1 file, 3 tests. Earlier retries exposed then fixed modal-guard and disclosure assertions in the new spec. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58111 bun run test:browser src/components/chat/ProviderModelPicker.browser.tsx --api 58112 --reporter=verbose --testTimeout 10000 --hookTimeout 10000 --teardownTimeout 10000` from `apps/web` | Passed: 1 file, 18 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH PORT=58139 bun run test:browser src/components/ChatView.browser.tsx -t "opens provider handoff dialog" --api 58140 --reporter=verbose --testTimeout 45000 --hookTimeout 30000 --teardownTimeout 30000` from `apps/web` | Failed/blocked: app remained on `Loading projects...` and could not find `[data-testid="composer-editor"]` after 20s. A neighboring pre-existing `opens the composer model picker` focused run failed the same way, so this is a ChatView browser hydration blocker, not specific to the handoff dialog. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test` from `packages/shared` | Passed: 14 files, 141 tests. |
| 2026-06-03 | `PATH=/Users/joegarbarino/.hermes/node/bin:$PATH bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/decider.projectScripts.test.ts` from `apps/server` | Passed: 2 files, 58 tests. Node emitted the existing experimental SQLite warning. |
| 2026-06-03 | Broad `git status` / `git diff` commands in the clean worktree | Blocked/hung due local Git/fsmonitor scanning after dependency install; stopped the scans and used explicit path/untracked inspection instead. |
| 2026-06-03 | Final reruns of `ProviderHandoffDialog.browser.tsx` and `ProviderModelPicker.browser.tsx` from `apps/web` | Failed/blocked before importing tests: Vite/Babel resolver hit `Yallist is not a constructor`, then `_browserslist.findConfigFile is not a function`. Direct inspection showed installed `browserslist@4.28.1` does not expose `findConfigFile`. Earlier browser passes remain recorded above. |
| 2026-06-03 | `git -c core.fsmonitor=false diff --check -- ...` with explicit V1-V5 handoff paths | Passed. Used path-limited form because broad Git status/diff scans hung locally. |
| 2026-06-03 | `bun fmt`, `bun lint`, `bun typecheck` | Skipped per explicit V5 plan and repo instruction to avoid these heavyweight checks unless requested. |

## Stop / Go Notes

- GO: V1 picker-originated linked handoff flow is feasible as a small, professional PR.
- GO: V2 safe current-draft copy is implemented without server, contract, migration, provider adapter, or provider-binding changes.
- GO: V3 context preview uses shared generation and avoids preview drift without adding RPC/contracts.
- GO: V4 visible reverse linking is implemented as derived projection-backed web state without adding contracts or migrations.
- STOP: V5 same-thread provider switching is unsafe without a provider-session segment architecture.
