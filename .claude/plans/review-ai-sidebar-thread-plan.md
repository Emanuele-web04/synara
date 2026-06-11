# Plan: Review AI Sidebar Thread

**Generated**: 2026-06-08
**Estimated Complexity**: Medium

## Overview

Make the PR AI sidebar a real, usable Synara chat surface by automatically creating or reusing one review-owned thread per pull request. The thread must be assigned to the review, run in the main repository checkout only, avoid creating a worktree, and constrain the assistant to loaded PR context: diff, PR metadata, checks, conversation, and the base branch.

The current implementation depends on an existing host chat thread and `getSidechatCreator(hostThreadId)`. That makes the review sidebar feel unavailable from the review surface itself and routes through the generic `/side` flow. Replace that with a review chat bootstrap that creates a normal local thread for the PR and embeds `ChatView` in the sidebar once the thread exists.

## Architecture

```text
ReviewPrView
  -> builds ReviewSidechatContextPayload
  -> ReviewPrSidebar / ReviewSidechat
      -> useReviewChatThread(context)
          -> find existing thread assigned to PR
          -> create local thread if missing
          -> dispatch first turn with review-bounded prompt
      -> ChatView(threadId, surfaceMode="split")

Thread invariants:
  envMode: "local"
  worktreePath: null
  associatedWorktreePath: null
  runtimePlan: null
  lastKnownPr: PR metadata
  no git worktree creation APIs
```

## Non-Goals

- Do not use `git.preparePullRequestThread`.
- Do not call `git.createWorktree` or set `envMode: "worktree"`.
- Do not let this become a generic sidechat fork from an unrelated host thread.
- Do not grant the assistant implicit access to a PR checkout. It sees PR context in the prompt and can read the main repo checkout only.
- Do not add code-edit or auto-fix behavior in this pass.

## Sprint 1: Review-Owned Thread Bootstrap

**Goal**: Typing in the PR AI sidebar creates or reuses a PR-bound local thread and embeds the chat transcript in the sidebar.

**Demo/Validation**:

- Open a PR review with no existing chat.
- Type a question in the AI sidebar.
- A Synara thread is created automatically.
- The sidebar swaps from empty prompt to live `ChatView`.
- No worktree directory is created.
- Reopening the same PR reuses the same chat thread.

### Task 1.1: Add Review Thread Lookup Helper

- **Location**:
  - `apps/web/src/components/review/ReviewSidechat.tsx`
  - optionally `apps/web/src/components/review/reviewChatThread.ts`
- **Description**: Add a helper that finds an existing thread for the PR from orchestration state.
- **Matching Rule**:
  - Prefer thread where `thread.lastKnownPr.url === context.url` or `number/base/head/url` all match.
  - Fallback to a stable title prefix like `PR #7884: ...` only if `lastKnownPr` is missing.
- **Dependencies**: None.
- **Acceptance Criteria**:
  - Same PR does not create duplicate threads across sidebar remounts.
  - Different PRs create different threads.
- **Validation**:
  - Add a focused logic test for matching by `lastKnownPr`.

### Task 1.2: Create Local PR Review Thread

- **Location**:
  - `apps/web/src/components/review/ReviewSidechat.tsx`
  - `apps/web/src/lib/threadBootstrap.ts` if a reusable helper is needed
- **Description**: When no matching thread exists and the user sends a question, dispatch `thread.create`.
- **Command Shape**:
  - `projectId`: project for `context.cwd`
  - `title`: `Review PR #${number}: ${title}`
  - `modelSelection`: project default or current global default
  - `runtimeMode`: existing default
  - `interactionMode`: `default`
  - `envMode`: `local`
  - `branch`: `context.baseBranch` or `null`
  - `worktreePath`: `null`
  - `associatedWorktreePath`: `null`
  - `associatedWorktreeBranch`: `null`
  - `associatedWorktreeRef`: `context.baseBranch`
  - `lastKnownPr`: `{ number, title, url, baseBranch, headBranch, state }`
  - `runtimePlan`: `null`
- **Dependencies**: Task 1.1.
- **Acceptance Criteria**:
  - New review chat is local-mode.
  - `worktreePath` remains null.
  - Thread appears assigned to the review through `lastKnownPr`.
- **Validation**:
  - Browser/component test stubs `orchestration.dispatchCommand` and asserts `thread.create` payload.

### Task 1.3: Send First Review Question Into The Thread

- **Location**:
  - `apps/web/src/components/review/ReviewSidechat.tsx`
  - `apps/web/src/components/review/reviewSidechatContext.ts`
- **Description**: After creating or finding the review thread, dispatch `thread.turn.start` with `buildReviewSidechatInitialPrompt(context, question)`.
- **Prompt Requirements**:
  - State that this is a review-only assistant.
  - State it must not create worktrees, branches, commits, or edits.
  - State it only has main checkout access plus supplied PR diff/context.
  - Include changed files, checks, PR body, recent conversation, selected file, and summary stats.
- **Dependencies**: Task 1.2.
- **Acceptance Criteria**:
  - First user question starts a real assistant turn.
  - The visible transcript shows the user question and assistant response.
  - Suggestions use the same path as typed questions.
- **Validation**:
  - Browser test asserts first submit sends `thread.create` then `thread.turn.start`.

### Task 1.4: Embed Persistent ChatView

- **Location**:
  - `apps/web/src/components/review/ReviewSidechat.tsx`
- **Description**: Replace the host-thread sidechat branch with `ChatView` for the review-owned thread.
- **Acceptance Criteria**:
  - Sidebar renders empty prompt before first send.
  - After first send, sidebar renders `ChatView(threadId)`.
  - Composer remains usable for follow-up questions.
  - It does not open the global right dock.
- **Validation**:
  - Existing `ReviewPrSidebar.browser.tsx` tests updated from "Opens a Synara sidechat" to "Creates PR chat" / "PR chat active".

## Sprint 2: Context Discipline And Guardrails

**Goal**: Make the assistant useful for review while preventing accidental worktree/code-edit workflows.

**Demo/Validation**:

- Ask "what should I review first?"
- Ask "look at this selected file."
- Ask "make the fix."
- Assistant should analyze and suggest, not create a worktree or edit files.

### Task 2.1: Strengthen Review Prompt Contract

- **Location**:
  - `apps/web/src/components/review/reviewSidechatContext.ts`
- **Description**: Expand `buildReviewSidechatInitialPrompt` into a stable review contract.
- **Acceptance Criteria**:
  - Prompt clearly says: "Do not modify files, create branches, create commits, or create worktrees."
  - Prompt says: "Use the supplied diff and PR metadata; repository reads are from the base checkout."
  - Prompt asks for concise review answers with file/line references when possible.
- **Validation**:
  - Unit test snapshots key prompt clauses.

### Task 2.2: Include Diff Content, Not Only File List

- **Location**:
  - `apps/web/src/components/review/reviewSidechatContext.ts`
  - `apps/web/src/components/review/ReviewPrView.tsx`
- **Description**: Add bounded diff hunks to the context payload.
- **Rules**:
  - Include full diff for small PRs.
  - For large PRs, include selected file first, then changed-file summaries and truncated hunks.
  - Mark truncation explicitly.
- **Dependencies**: Task 2.1.
- **Acceptance Criteria**:
  - Assistant can answer about actual changes, not just filenames.
  - Prompt stays below a defined max character budget.
- **Validation**:
  - Unit tests for small, large, and selected-file diff context.

### Task 2.3: Block Worktree-Affording UI In Review Chat

- **Location**:
  - `apps/web/src/components/ChatView.tsx`
  - `apps/web/src/components/review/ReviewSidechat.tsx`
- **Description**: Add a review-chat surface flag or derive from `lastKnownPr` + sidebar scope to hide worktree/fork/handoff affordances inside the embedded sidebar.
- **Acceptance Criteria**:
  - No "New worktree" picker in embedded PR chat composer.
  - No handoff-to-worktree prompt in the embedded sidebar.
  - Normal chat pages are unchanged.
- **Validation**:
  - Browser test verifies review sidebar chat does not expose worktree controls.

## Sprint 3: Assignment, Reuse, And Lifecycle

**Goal**: Make review chats durable, discoverable, and clearly tied to their PR.

**Demo/Validation**:

- Open PR #A, ask a question.
- Switch to PR #B, ask a question.
- Switch back to PR #A and see prior chat.
- Archive/close behavior does not delete review chat unexpectedly.

### Task 3.1: Add Durable Review Chat Association If Needed

- **Location**:
  - `packages/contracts/src/orchestration.ts`
  - `apps/server/src/persistence/Migrations/*`
  - `apps/server/src/orchestration/projector.ts`
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- **Description**: If `lastKnownPr` matching is not stable enough, add `reviewSource` or `reviewChatFor` metadata to threads.
- **Preferred Shape**:
  - `reviewChat: { repositoryId: string | null, url: string, number: number }`
- **Dependencies**: Sprint 1 results.
- **Acceptance Criteria**:
  - Review chat association survives title changes.
  - Multiple PRs in the same repo do not collide.
- **Validation**:
  - Migration/projector/query tests.

### Task 3.2: Sidebar State Labels

- **Location**:
  - `apps/web/src/components/review/ReviewSidechat.tsx`
  - `apps/web/src/components/review/ReviewPrSidebar.tsx`
- **Description**: Replace current "Requires a Synara thread" copy with review-owned states.
- **States**:
  - Empty: "Ask about this PR"
  - Creating: "Creating PR chat..."
  - Active: "PR chat active"
  - Error: "Could not create PR chat"
- **Acceptance Criteria**:
  - No copy implies a host thread is required.
  - Disabled/send states are clear.
- **Validation**:
  - Browser tests for empty, creating, active, error states.

### Task 3.3: Thread List Presentation

- **Location**:
  - `apps/web/src/components/Sidebar.tsx`
  - `apps/web/src/components/chat/ChatHeader.tsx`
- **Description**: Mark review chats as PR-related threads without overpromoting them.
- **Acceptance Criteria**:
  - Thread title and/or chip shows PR number.
  - User can still open the full thread if needed.
  - Review sidebar remains the primary home for the chat.
- **Validation**:
  - Snapshot or browser check for sidebar row title/chip.

## Testing Strategy

- Unit:
  - review thread lookup by `lastKnownPr`
  - prompt builder budget/truncation
  - no-worktree command payload
- Browser:
  - first question creates local review thread
  - suggestions create/reuse the same thread
  - PR tab switch reuses correct chat
  - embedded chat hides worktree affordances
- Manual:
  - Open review home and PR detail.
  - Ask a sidebar question from overview and files views.
  - Confirm no worktree is created under `.synara-pr84/worktrees`.
  - Confirm thread remains associated with the PR after app restart.

## Risks & Gotchas

- **Project resolution**: Review pages may have `cwd` but not a direct `projectId`. The implementation must resolve the project from the orchestration snapshot instead of creating a new project silently.
- **Model selection**: The review surface does not currently own model selection. Use project default for Sprint 1, then consider a compact model picker later.
- **Duplicate threads**: Creating on rapid double-submit can race. Gate with local `creatingThreadForReference` state and re-check existing threads after creation.
- **Context size**: Full diffs can be large. Add truncation before including diff content.
- **Permissions**: Prompt guardrails are not enforcement. UI must also hide worktree-affording controls in the embedded review-chat surface.
- **Main branch wording**: The thread runs from the repository checkout. If the checkout is not actually on `main`, the prompt should say "base checkout/base branch context" rather than lying.

## Rollback Plan

- Keep existing `ReviewSidechat` empty prompt UI until a thread is created.
- If auto-create regresses, disable the create path and fall back to the old prompt-only sidebar.
- Since Sprint 1 uses normal local threads and no new schema, rollback is mostly web-only unless Sprint 3 metadata is added.
