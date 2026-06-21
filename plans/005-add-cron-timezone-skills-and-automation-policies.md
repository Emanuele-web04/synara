# Plan 005: Add Cron, Timezone, Skills, and Automation Policies

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**: `git diff --stat c0fb7f1b9..HEAD -- packages/contracts/src/automation.ts apps/server/src/automation apps/web/src/routes/-automations.shared.tsx apps/web/src/lib/automationIntent.ts apps/server/src/git/textGenerationShared.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-harden-automation-run-lifecycle.md`, `plans/002-add-true-timer-and-schedule-model.md`, `plans/003-build-codex-like-automation-creation-ux.md`, `plans/004-add-automation-triage-results-and-run-actions.md`
- **Category**: direction
- **Planned at**: commit `c0fb7f1b9`, 2026-06-19

## Why this matters

OpenAI Codex automations support custom schedules with cron syntax and can combine automations with skills. Synara should not jump straight to cron before one-shot timers and lifecycle reliability, but a complete automation system needs timezone-aware recurring schedules, admin/user policies, skill-driven prompts, and cleanup behavior for background worktrees.

## Current state

- `AutomationSchedule` has no cron/RRULE or timezone field (`packages/contracts/src/automation.ts:31-51`).
- `formatDateTime` displays UTC explicitly (`apps/web/src/routes/-automations.shared.tsx:174-185`).
- Parser supports limited English/Italian cadence phrases and no timezone/monthly/cron (`apps/web/src/lib/automationIntent.ts:59-254`).
- Automation prompt generation instructs every N minutes/hours/days and daily/weekdays/weekly only (`apps/server/src/git/textGenerationShared.ts:404-415`).
- OpenAI Codex docs: standalone automations can use custom schedule with cron syntax, automations use plugins/skills, and full access/background automations carry elevated risk. Source: `https://developers.openai.com/codex/app/automations`.

## Commands you will need

| Purpose                    | Command                                                          | Expected on success                        |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Contracts tests            | `cd packages/contracts && bun run test src/automation.test.ts`   | exit 0                                     |
| Server schedule tests      | `cd apps/server && bun run test src/automation/schedule.test.ts` | exit 0                                     |
| Web parser tests           | `cd apps/web && bun run test src/lib/automationIntent.test.ts`   | exit 0                                     |
| Full required verification | `bun fmt && bun lint && bun typecheck`                           | exit 0; run only when explicitly requested |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested.

## Scope

**In scope**:

- `packages/contracts/src/automation.ts`
- `packages/contracts/src/automation.test.ts`
- `apps/server/src/automation/schedule.ts`
- `apps/server/src/automation/schedule.test.ts`
- `apps/server/src/git/textGenerationShared.ts`
- `apps/web/src/lib/automationIntent.ts`
- `apps/web/src/lib/automationIntent.test.ts`
- `apps/web/src/routes/-automations.shared.tsx`
- `apps/web/src/routes/_chat.automations.*.tsx`

**Out of scope**:

- Replacing the scheduler engine entirely.
- Building a full calendar UI.
- Enterprise/admin settings unless existing settings infrastructure makes it small.

## Steps

### Step 1: Add timezone-aware schedule types

Extend wall-clock schedules to carry `timezone` while preserving decode compatibility for old rows:

```ts
{ type: "daily", timeOfDay: "09:00", timezone?: string }
{ type: "weekdays", timeOfDay: "09:00", timezone?: string }
{ type: "weekly", dayOfWeek: 1, timeOfDay: "09:00", timezone?: string }
```

Use a safe default when missing: existing behavior should remain UTC or explicitly migrate to the user's local timezone only with clear product approval. Recommended: preserve old rows as UTC; new UI defaults to local timezone.

**Verify**: Contract decode tests for old/new schedule JSON pass.

### Step 2: Choose and implement cron parser library or constrained cron

Do not hand-roll cron math unless intentionally constrained. Pick one:

- Add a small cron parser dependency if repo policy allows dependencies.
- Implement a constrained 5-field cron validator + next-occurrence helper if dependency addition is not acceptable.

Contract shape:

```ts
{ type: "cron", expression: string, timezone: string }
```

Validation requirements:

- Reject expressions that can fire more often than the configured minimum interval.
- Reject invalid timezone IDs.
- Provide next-run preview.

**Verify**: Schedule tests for hourly, daily, weekday, invalid expression, DST transition if timezone library supports it.

### Step 3: Add automation policies

Introduce explicit policy fields if not already covered by existing definition fields:

- `minimumIntervalSeconds`
- `maxRuntimeSeconds` or run timeout
- `retryPolicy`: none/fixed/exponential, max attempts
- `misfirePolicy`: skip/coalesce/run-latest
- `maxIterations` default for heartbeat fast loops
- full-access/local-checkout acknowledgement flags from Plan 003

Keep MVP policies simple and explicit in contracts. Avoid hidden magic defaults in UI only.

**Verify**: Contract tests and AutomationService tests for timeout/retry/misfire if implemented.

### Step 4: Add skills/plugin-friendly creation

Codex docs recommend combining automations with skills using `$skill-name`. Make Synara's draft UI and parser preserve skill references in prompt text and optionally surface selected skills if existing composer skill selection can be persisted.

Rules:

- Do not claim a skill is installed/available unless current provider/runtime can resolve it.
- If skills are text-only references today, keep them as prompt text and show a hint.
- Future explicit skill metadata should be a separate contract extension.

**Verify**: Parser/draft tests ensure `$skill-name` stays in `prompt` and does not get stripped as schedule scaffolding.

### Step 5: Add worktree cleanup guidance/state

Frequent standalone automation runs can create many worktrees. Add UI copy and optional data fields/actions:

- show whether a run has a worktree
- archive run CTA explains whether worktree is kept or cleaned
- optional cleanup action if existing git/worktree service supports safe removal

Do not delete worktrees automatically without explicit user confirmation.

**Verify**: UI helper tests for cleanup action visibility if extracted.

## Test plan

- Contract tests for timezone and cron schedule decode.
- Schedule tests for next occurrence and DST/invalid timezone.
- Parser tests for cron phrases and skill references.
- UI helper tests for schedule labels/next run preview.

## Done criteria

- [ ] New schedules can represent timezone-aware daily/weekly/weekdays.
- [ ] Cron/custom schedules validate and compute next run safely.
- [ ] Minimum interval and misfire/retry policy are explicit.
- [ ] Skill references are preserved and documented in creation UI.
- [ ] Worktree cleanup risk is visible to users.
- [ ] Focused tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Adding a cron/timezone dependency conflicts with repo policy or bundle/runtime constraints.
- DST behavior cannot be made deterministic in tests.
- Policy fields require a migration that would break existing automation rows.

## Maintenance notes

Cron/timezone is where regressions hide. Keep recurrence math isolated in one module with exhaustive tests; do not spread cron parsing across UI and server.
