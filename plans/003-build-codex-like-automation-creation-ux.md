# Plan 003: Build Codex-Like Automation Creation UX

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**: `git diff --stat c0fb7f1b9..HEAD -- apps/web/src/components/ChatView.tsx apps/web/src/hooks/useComposerSlashCommands.ts apps/web/src/composerSlashCommands.ts apps/web/src/lib/automationIntent.ts apps/web/src/routes/-automations.shared.tsx apps/web/src/routes/_chat.automations.index.tsx apps/web/src/routes/_chat.automations.$automationId.tsx`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-harden-automation-run-lifecycle.md`, `plans/002-add-true-timer-and-schedule-model.md`
- **Category**: direction
- **Planned at**: commit `c0fb7f1b9`, 2026-06-19

## Why this matters

Codex docs say users can create/update automations from a regular thread by describing the task, schedule, and whether it stays attached to the current thread or starts fresh runs. Synara has direct `/automation` creation, but it saves immediately when parsing succeeds and lacks a confirmation draft. A Codex-like UX should show what Synara understood before saving, especially for unattended background work, full-access runs, local checkout edits, or fast timers.

## Current state

- `/automation` is defined as an app-level command (`apps/web/src/composerSlashCommands.ts:164`) and offered in command lists, but slash selection has no automation branch in `handleSlashCommandSelection` (`apps/web/src/hooks/useComposerSlashCommands.ts:713-792`).
- Chat creation happens inline in `ChatView` for prompt-only sends (`apps/web/src/components/ChatView.tsx:5912-5963`). It creates immediately after resolving intent.
- Prompt-only gating means `/automation` with files, pasted text, terminal context, or images bypasses automation handling and may go to the provider (`ChatView.tsx:5881-5912`).
- Generated intents with `needsConfirmation` are rejected, not shown as editable drafts (`apps/web/src/lib/automationIntent.ts:377-385`).
- Automation dialog already centralizes form submission and model/worktree/mode/schedule controls (`apps/web/src/routes/-automations.shared.tsx:611-978`).
- OpenAI Codex docs state users can ask Codex to create/update automations and Codex can draft the automation prompt, choose type, and update scope/cadence. Source: `https://developers.openai.com/codex/app/automations`.

## Commands you will need

| Purpose                    | Command                                                                                          | Expected on success                        |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Web parser/slash tests     | `cd apps/web && bun run test src/lib/automationIntent.test.ts src/composerSlashCommands.test.ts` | exit 0                                     |
| Focused UI tests if added  | `cd apps/web && bun run test <new test file>`                                                    | exit 0                                     |
| Full required verification | `bun fmt && bun lint && bun typecheck`                                                           | exit 0; run only when explicitly requested |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested.

## Scope

**In scope**:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/hooks/useComposerSlashCommands.ts`
- `apps/web/src/composerSlashCommands.ts`
- `apps/web/src/composerSlashCommands.test.ts`
- `apps/web/src/lib/automationIntent.ts`
- `apps/web/src/lib/automationIntent.test.ts`
- `apps/web/src/routes/-automations.shared.tsx`
- `apps/web/src/routes/_chat.automations.index.tsx`
- `apps/web/src/routes/_chat.automations.$automationId.tsx`
- New focused component/hook files under `apps/web/src/components/automation/` or `apps/web/src/lib/` if needed

**Out of scope**:

- Server scheduler changes (Plan 002).
- Triage inbox/result model (Plan 004).
- Large unrelated chat composer refactors.

## Steps

### Step 1: Introduce an automation draft model on the web

Create a small client-side type/module, for example `apps/web/src/lib/automationDraft.ts`, that represents an editable draft:

```ts
interface AutomationCreationDraft {
  source: "slash" | "mention" | "dialog" | "generated";
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  mode: AutomationMode;
  targetThreadId: ThreadId | null;
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  worktreeMode: AutomationWorktreeMode;
  maxIterations: number | null;
  stopOnError: boolean;
  warnings: readonly AutomationDraftWarning[];
}
```

Warnings should include fast recurring interval, full access, local checkout mode, missing/ambiguous schedule, and generated low-confidence fields.

**Verify**: Add pure unit tests if helpers are non-trivial.

### Step 2: Make `/automation` slash selection useful

Update `handleSlashCommandSelection`:

- Selecting `/automation` inserts `/automation ` into the composer and focuses it, or opens the draft dialog if the current prompt already contains enough text.
- Do not send a provider turn when the user merely selects the command.

Add test coverage in `composerSlashCommands.test.ts` or hook-level tests if available.

**Verify**: `cd apps/web && bun run test src/composerSlashCommands.test.ts` → pass.

### Step 3: Route chat-triggered creation through a draft dialog

Refactor the automation block in `ChatView` so it no longer calls `api.automation.create` directly after high-confidence parsing.

New flow:

1. Extract `/automation` or `@automation`.
2. Resolve deterministic/generated intent.
3. Build `AutomationCreationDraft`.
4. Open a confirmation dialog prefilled with parsed values.
5. User clicks Create.
6. Then call `api.automation.create`.

If generated intent has `needsConfirmation`, still open the draft dialog with missing fields highlighted instead of only showing a warning. If schedule is missing entirely, open dialog with schedule control focused or show a specific warning and keep composer text.

**Verify**: Add focused tests for draft builder pure logic; if ChatView integration tests are too heavy, document manual test steps in test file comments and verify parser/slash tests.

### Step 4: Reuse and harden `AutomationDialog`

Avoid duplicating form logic. Extend `AutomationDialog` or create a wrapper that accepts an initial draft and a `variant="create-from-chat"`.

Requirements:

- Shows name, durable prompt, schedule, next-run preview, mode (`thread`/heartbeat vs standalone), target thread, model, permissions, worktree, max iterations, stop-on-error.
- Explains mode clearly: thread automation reuses context; standalone creates independent runs.
- Preserves manual schedules and one-shot schedules from Plan 002.
- Warnings are visible and must be acknowledged for risky settings.

**Verify**: Existing automation route interactions still compile/typecheck in full verification; add helper tests where possible.

### Step 5: Support attachments/context intentionally

Current prompt-only gating avoids ambiguity. Do not silently send `/automation` with attachments to provider.

Implement one of these explicit behaviors:

- Recommended: when `/automation` is used with attachments/pasted text/file comments, open draft and include a warning: "Attachments are not persisted into scheduled runs yet." Let user either drop context or convert it into prompt text.
- Alternative: block creation with a clear toast and keep composer unchanged.

Do not claim scheduled runs will include attachments unless server/provider contracts are extended to persist them.

**Verify**: Add tests for `extractChatAutomationInvocation` and draft builder with non-prompt content if helpers exist.

### Step 6: Add safety guardrails

In the draft dialog:

- Fast recurring interval under 60s requires explicit confirmation and should default to one-shot if phrase was "in N seconds".
- `runtimeMode === "full-access"` requires explicit acknowledgement.
- `worktreeMode === "local"` in a Git repo requires acknowledgement that files may be modified in the active checkout.
- Heartbeat with unlimited `maxIterations` should show "runs until paused/stopped".

**Verify**: Add pure warning helper tests covering each guardrail.

## Test plan

- `apps/web/src/composerSlashCommands.test.ts`: `/automation` available and selection behavior if testable.
- `apps/web/src/lib/automationIntent.test.ts`: deterministic parser still works after draft integration.
- New helper tests for `automationDraft` builder/warnings.
- Manual smoke after implementation:
  - `/automation every 1 min check repo status` opens draft, then Create saves automation.
  - `/automation in 15 seconds remind me here` opens one-shot thread timer draft.
  - `/automation` with an image does not send to provider silently.
  - full-access/local warnings appear.

## Done criteria

- [ ] `/automation` command selection inserts/opens automation flow instead of no-op.
- [ ] Chat-triggered automations use a confirmation draft before saving.
- [ ] `needsConfirmation` generated intents become editable drafts, not dead-end warnings.
- [ ] Prompt-only and attachment cases are handled intentionally.
- [ ] Risky unattended settings require acknowledgement.
- [ ] Focused web tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Reusing `AutomationDialog` requires a large rewrite of unrelated route layout.
- ChatView integration cannot be tested or manually smoked without broad composer refactor.
- Persisting attachments becomes necessary; defer and report rather than half-persisting them.

## Maintenance notes

Keep parsing, draft building, and API creation as separate units. Future "update automation from chat" should reuse the same draft machinery rather than adding a second path.
