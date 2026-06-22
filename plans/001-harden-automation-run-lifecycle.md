# Plan 001: Harden Automation Run Lifecycle Before Adding Timers

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**: `git diff --stat c0fb7f1b9..HEAD -- packages/contracts/src/automation.ts apps/server/src/automation apps/server/src/persistence apps/server/src/orchestration apps/server/src/wsRpc.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `c0fb7f1b9`, 2026-06-19

## Why this matters

Synara already has scheduled automations, but the run lifecycle is not strong enough for short timers, retry/backoff, or unattended Codex-like workflows. Before adding one-shot timers and richer schedules, make run dispatch, cancellation, recovery, and heartbeat locking durable. This prevents duplicate turns, orphaned work, stale waiting states, and provider work continuing after the user cancels or deletes an automation.

## Current state

- `packages/contracts/src/automation.ts` defines schedules as `manual`, `interval`, `daily`, `weekdays`, and `weekly` only (`packages/contracts/src/automation.ts:31-51`).
- `apps/server/src/automation/Layers/AutomationService.ts` dispatches heartbeat runs by starting a turn on the target thread (`AutomationService.ts:394-438`).
- Standalone dispatch creates a thread, then starts a turn, then marks the run started (`AutomationService.ts:443-491`). This leaves a crash window because planned `threadId`, command IDs, and `messageId` are not persisted until after dispatch.
- `createPendingRun` persists `threadId` only for heartbeat and no command IDs (`AutomationService.ts:528-551`).
- `automation_runs` already has `claimed_by`, `claimed_at`, `lease_expires_at`, `thread_create_command_id`, `turn_start_command_id`, and `message_id` columns (`apps/server/src/persistence/Migrations/044_Automations.ts:34-53`), but `AutomationRepository.createRun` initializes them to `null` (`AutomationRepository.ts:797-819`).
- `cancelRun` only marks DB state and publishes an event; it does not interrupt provider work (`AutomationService.ts:783-788`).
- `AutomationRunReactor` only listens to selected orchestration events and can miss activity-state changes (`AutomationRunReactor.ts:15-23`).

## Commands you will need

| Purpose                    | Command                                                                                                                                                              | Expected on success                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Focused server tests       | `cd apps/server && bun run test src/automation/schedule.test.ts src/automation/Layers/AutomationService.test.ts src/persistence/Layers/AutomationRepository.test.ts` | exit 0, all selected Vitest tests pass     |
| Focused contracts tests    | `cd packages/contracts && bun run test src/automation.test.ts`                                                                                                       | exit 0                                     |
| Full required verification | `bun fmt && bun lint && bun typecheck`                                                                                                                               | exit 0; run only when explicitly requested |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested by the operator in the current conversation.

## Scope

**In scope**:

- `packages/contracts/src/automation.ts`
- `packages/contracts/src/automation.test.ts`
- `apps/server/src/automation/Layers/AutomationService.ts`
- `apps/server/src/automation/Layers/AutomationService.test.ts`
- `apps/server/src/automation/Layers/AutomationRunReactor.ts`
- `apps/server/src/persistence/Services/AutomationRepository.ts`
- `apps/server/src/persistence/Layers/AutomationRepository.ts`
- `apps/server/src/persistence/Layers/AutomationRepository.test.ts`
- `apps/server/src/orchestration/decider.ts` only to verify interruption command shape

**Out of scope**:

- One-shot timers, cron, timezone UI, or chat draft UI.
- Provider/session architecture outside automation run dispatch.
- WebSocket public method names.

## Steps

### Step 1: Persist planned run refs before dispatch

Change `createPendingRun` so every new run has planned `threadId`, `messageId`, `threadCreateCommandId`, and `turnStartCommandId` before dispatch starts.

- Use existing `deriveAutomationRunIds(run.id)` but generate from `runId` before persistence.
- For `heartbeat`: `threadId = definition.targetThreadId`, `threadCreateCommandId = null`.
- For `standalone`: `threadId = ids.threadId`, `threadCreateCommandId = ids.threadCreateCommandId`.
- Persist `messageId = ids.messageId` and `turnStartCommandId = ids.turnStartCommandId` for both modes.
- Extend repository input types if needed.
- Preserve scheduled run dedupe on `(automationId, scheduledFor)`.

**Verify**: `cd apps/server && bun run test src/automation/Layers/AutomationService.test.ts src/persistence/Layers/AutomationRepository.test.ts` → all selected tests pass.

### Step 2: Make dispatch use persisted run refs

Refactor `dispatchRun` to read `threadId`, `messageId`, `threadCreateCommandId`, and `turnStartCommandId` from `run`. If a required persisted field is missing, mark the run failed with a clear `AutomationServiceError`; do not derive fresh IDs inside dispatch.

**Verify**: Add/update an `AutomationService.test.ts` case asserting standalone scheduled runs contain non-null planned refs before/after dispatch. Run `cd apps/server && bun run test src/automation/Layers/AutomationService.test.ts` → pass.

### Step 3: Close standalone crash recovery window

Update `recoverPendingRuns` so a run with planned `threadId` is reconciled if the thread shell exists and interrupted only if no shell exists. Do not replay dispatch automatically in this plan; that belongs to retry/backoff.

**Verify**: Add tests for pending standalone run with planned thread and no shell → interrupted, and planned thread with shell → reconcile path.

### Step 4: Lock heartbeat by target thread

Current active-run checks are per automation. Add repository support to count active heartbeat runs by `threadId`/target thread. A heartbeat automation must not start if any active automation run already owns the same target thread. Standalone remains independently concurrent.

Prefer recording a `skipped` run with reason when a scheduled occurrence is skipped. If this requires broad schema/API churn, STOP and report.

**Verify**: Add tests for two heartbeat automations targeting the same thread, concurrent standalone automations, and manual heartbeat `runNow` while the target thread is busy.

### Step 5: Propagate cancel/delete to orchestration interruption

When `cancelRun` is called on a non-terminal run with `threadId`, dispatch the existing orchestration interruption command after marking the run cancelled. Search `apps/server/src/orchestration/decider.ts` for the exact command shape.

Rules:

- Provider interruption is best-effort but must be attempted.
- If provider later emits completion for a cancelled run, cancelled remains terminal.
- Archiving/deleting an automation should cancel/interrupt active runs for that automation, or STOP if repository support is too broad.

**Verify**: Add tests for cancel on pending/running/waiting run, provider completion after cancel, and delete with active run.

### Step 6: Fix wait-state reconciliation and `stopOnError`

Update `AutomationRunReactor` to listen to all orchestration events that can change pending approval/user input status. Update `reconcileThread` so `waiting-for-approval` can return to `running` when pending state is gone and the turn is still running. Apply `maybeStopLoop` when dispatch itself fails, not only when later reconciliation marks the run failed.

**Verify**: Add tests for waiting → running, dispatch failure + `stopOnError: true` disabling the automation, and existing success/error paths.

## Test plan

- Extend `apps/server/src/automation/Layers/AutomationService.test.ts`; follow existing heartbeat target tests.
- Extend `apps/server/src/persistence/Layers/AutomationRepository.test.ts` for new repository methods/persisted refs.
- Extend `packages/contracts/src/automation.test.ts` only if contract shape changes.
- Avoid wall-clock sleeps; use deterministic timestamps.

## Done criteria

- [ ] Durable run rows contain planned `threadId`, `messageId`, and command ids before dispatch.
- [ ] Crash recovery no longer treats planned standalone runs as orphaned solely because refs were missing.
- [ ] Heartbeat concurrency is enforced per target thread.
- [ ] Cancel/delete attempts to interrupt provider work and cancelled status is stable.
- [ ] Waiting runs can transition back to running.
- [ ] `stopOnError` applies to dispatch failures.
- [ ] Focused server tests pass.
- [ ] No timer/cron/UI behavior is introduced in this plan.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Orchestration has no safe interruption command.
- Skipped-run recording requires a broad schema migration that would delay lifecycle hardening.
- Target-thread locking requires transaction semantics unavailable through current repository helpers.
- The code at cited locations differs materially from live code after drift check.

## Maintenance notes

Review idempotency and crash windows carefully. Future timer/retry plans depend on durable planned refs and stable terminal statuses introduced here.
