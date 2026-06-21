# Plan 002: Add True One-Shot Timers and a Safer Schedule Model

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**: `git diff --stat c0fb7f1b9..HEAD -- packages/contracts/src/automation.ts packages/contracts/src/server.ts apps/server/src/automation apps/server/src/git/textGenerationShared.ts apps/web/src/lib/automationIntent.ts apps/web/src/routes/-automations.shared.tsx`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-harden-automation-run-lifecycle.md`
- **Category**: direction
- **Planned at**: commit `c0fb7f1b9`, 2026-06-19

## Why this matters

The requested Codex-like behavior includes timers such as "wake this thread in 15 seconds" and recurring checks. Synara currently supports recurring/manual schedules but not one-shot timers, local timezone semantics, or reliable sub-minute execution. This plan adds the smallest complete timer model first: one-shot `once` schedules plus seconds parsing and efficient imminent wake-ups.

## Current state

- `AutomationSchedule` has no one-shot shape (`packages/contracts/src/automation.ts:31-51`).
- Scheduler interval is hardcoded to 60 seconds by default (`apps/server/src/automation/Layers/AutomationScheduler.ts:9-23`). A 15-second timer may wait until the next minute pass.
- Schedule math handles interval by adding seconds and wall-clock schedules by UTC `timeOfDay` (`apps/server/src/automation/schedule.ts:27-60`).
- The parser does not recognize seconds or one-shot phrases; `INTERVAL_PATTERN` covers minutes/hours/days only (`apps/web/src/lib/automationIntent.ts:59-61`).
- UI schedule kinds are `hourly`, `daily`, `weekdays`, `weekly`, and `custom`; no `once` and no manual preservation (`apps/web/src/routes/-automations.shared.tsx:96-120`).
- OpenAI Codex docs describe automations as recurring background tasks and thread wake-ups, and thread automations can use minute-based intervals. Source: `https://developers.openai.com/codex/app/automations`.

## Commands you will need

| Purpose                    | Command                                                                                                          | Expected on success                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Contracts tests            | `cd packages/contracts && bun run test src/automation.test.ts`                                                   | exit 0                                     |
| Server schedule tests      | `cd apps/server && bun run test src/automation/schedule.test.ts src/automation/Layers/AutomationService.test.ts` | exit 0                                     |
| Web parser tests           | `cd apps/web && bun run test src/lib/automationIntent.test.ts`                                                   | exit 0                                     |
| Full required verification | `bun fmt && bun lint && bun typecheck`                                                                           | exit 0; run only when explicitly requested |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested.

## Scope

**In scope**:

- `packages/contracts/src/automation.ts`
- `packages/contracts/src/automation.test.ts`
- `packages/contracts/src/server.ts` if generated intent schema or input needs `nowIso`
- `apps/server/src/automation/schedule.ts`
- `apps/server/src/automation/schedule.test.ts`
- `apps/server/src/automation/Layers/AutomationScheduler.ts`
- `apps/server/src/automation/Layers/AutomationService.ts`
- `apps/server/src/automation/Layers/AutomationService.test.ts`
- `apps/server/src/git/textGenerationShared.ts`
- `apps/web/src/lib/automationIntent.ts`
- `apps/web/src/lib/automationIntent.test.ts`
- `apps/web/src/routes/-automations.shared.tsx`
- `apps/web/src/routes/_chat.automations.$automationId.tsx`
- `apps/web/src/routes/_chat.automations.index.tsx`

**Out of scope**:

- Full cron/RRULE implementation.
- Triage inbox/result model.
- Multi-project automations.
- Major visual redesign; only add fields needed for timer schedules.

## Steps

### Step 1: Add `once` schedule to contracts

Extend `AutomationSchedule` with:

```ts
Schema.Struct({
  type: Schema.Literal("once"),
  runAt: IsoDateTime,
});
```

Rules:

- `once` means exactly one scheduled run.
- `manual` remains run-now-only.
- Existing schedule JSON remains compatible; do not migrate existing rows.

**Verify**: Add decode tests for `once` and invalid `runAt` in `packages/contracts/src/automation.test.ts`. Run `cd packages/contracts && bun run test src/automation.test.ts` → pass.

### Step 2: Implement one-shot schedule math

Update `computeNextAutomationRunAt` and `computeNextAutomationRunAtAfter`.

Recommended semantics:

- `computeNextAutomationRunAt({ type: "once", runAt }, from)` returns `runAt` if `runAt > from`, otherwise `null`.
- `computeNextAutomationRunAtAfter` returns `null` after the one-shot occurrence is consumed.
- `runDueDefinition` creates at most one run for one-shot schedules and then clears `nextRunAt` and disables or completes the definition. Recommended product semantics: set `enabled = false` after creating the durable run, keeping history visible.

**Verify**: Add tests for future one-shot, past one-shot, due one-shot after downtime, and no duplicate run on repeated `runDueOnce`.

### Step 3: Make scheduler efficient for short timers

Do not globally poll every second. Add an adaptive wake-up strategy:

- Keep 60s as the normal upper bound.
- After each pass, find the earliest enabled `nextRunAt`.
- Sleep until `min(60s, max(1s, earliestDue - now))`.
- Preserve the scheduler lease so multiple server instances do not dispatch the same due row.
- Avoid starting a second pass while one is still running.

If adding an earliest-due repository method is too broad, implement a smaller safe fallback: use a 5s pass interval only while any `once` schedule has `nextRunAt` within the next minute.

**Verify**: Add repository/service tests for earliest due selection if implemented. Run focused server tests. Do not add real-time sleeps to tests.

### Step 4: Extend deterministic parser

Update `apps/web/src/lib/automationIntent.ts`:

- Add seconds units: `seconds`, `second`, `secs`, `sec`, `s`, `secondi`, `secondo`.
- Support recurring seconds: `every 15 seconds`, `ogni 15 secondi`.
- Support one-shot phrases:
  - `in 15 seconds`, `in 5 minutes`, `in 2 hours`
  - `tra 15 secondi`, `fra 5 minuti`, `tra 2 ore`
- Return `{ type: "once", runAt }` for one-shot phrases.

Safety guards:

- Minimum one-shot delay: 5 seconds.
- Minimum recurring interval: 60 seconds unless Plan 003 introduces explicit fast-loop confirmation.
- If user says "between/around" ambiguous time, return null and let confirmation/fallback handle it.

**Verify**: Add tests in `apps/web/src/lib/automationIntent.test.ts` for English/Italian one-shot, recurring seconds, and sub-minimum behavior. Run `cd apps/web && bun run test src/lib/automationIntent.test.ts` → pass.

### Step 5: Update AI-generated intent prompt

Update `buildAutomationIntentPrompt` in `apps/server/src/git/textGenerationShared.ts`:

- Add one-shot rules: relative time maps to `{ "type": "once", "runAt": "<ISO>" }`.
- Add seconds support for interval schedules.
- Add explicit instruction: do not invent a schedule; missing/ambiguous relative time requires confirmation.
- Provide a deterministic `nowIso` to the model. If threading `nowIso` through `ServerGenerateAutomationIntentInput` and all providers becomes too invasive, STOP and report rather than relying on model-local current time.

**Verify**: Existing provider text-generation tests pass; add/update prompt builder tests if present.

### Step 6: Add minimal UI representation

Update shared automation UI helpers:

- Add schedule kind `once`.
- Preserve `manual` schedules in `scheduleKindFromSchedule`; do not map manual to daily.
- `formatCadence({ type: "once" })` returns `Once at <local date/time>` or `In <relative>`.
- Dialog/detail schedule picker can display/edit `once` with date/time.
- Add next-run preview in dialog using `definition.nextRunAt` or computed client-side preview.

Do not implement full cron UI in this plan.

**Verify**: Add helper tests if route helper tests exist; otherwise rely on typecheck/full verification later.

## Test plan

- `packages/contracts/src/automation.test.ts`: `once` decode and invalid `runAt`.
- `apps/server/src/automation/schedule.test.ts`: one-shot schedule math.
- `apps/server/src/automation/Layers/AutomationService.test.ts`: one-shot due exactly once and definition stops scheduling.
- `apps/web/src/lib/automationIntent.test.ts`: seconds and one-shot English/Italian parsing.

## Done criteria

- [ ] `AutomationSchedule` supports `once`.
- [ ] One-shot due runs are not duplicated across repeated scheduler passes/restarts.
- [ ] Short timers are picked up without a constant 1s global scheduler loop.
- [ ] Parser handles seconds and `in/tra/fra` one-shot phrases.
- [ ] Manual schedules are preserved in UI helpers.
- [ ] Focused tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- There is no clean way to pass `nowIso` into generated intent without broad provider API churn.
- Adaptive scheduler requires a risky rewrite of scheduler lease semantics.
- Timezone behavior becomes ambiguous; defer local timezone to a separate plan instead of guessing.

## Maintenance notes

One-shot timers are the foundation for natural language reminders and short follow-up loops. Cron/RRULE should come later after one-shot semantics and scheduler precision are proven.
