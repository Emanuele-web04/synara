# Plan 004: Add Automation Triage, Results, and Run Actions

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**: `git diff --stat c0fb7f1b9..HEAD -- packages/contracts/src/automation.ts apps/server/src/automation apps/server/src/persistence apps/web/src/routes apps/web/src/components/Sidebar.tsx`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-harden-automation-run-lifecycle.md`, `plans/002-add-true-timer-and-schedule-model.md`, `plans/003-build-codex-like-automation-creation-ux.md`
- **Category**: direction
- **Planned at**: commit `c0fb7f1b9`, 2026-06-19

## Why this matters

Codex automations are not just scheduled prompts; they produce findings that go to Triage, or archive/no-op when there is nothing to report. Synara currently shows definition lists and previous runs, but it lacks a result model, unread state, no-findings behavior, and run-level actions. Without this, automations become noisy background threads rather than a manageable inbox.

## Current state

- Contracts define `AutomationRunStatus`, `AutomationDefinition`, `AutomationRun`, and `result_json`, but the result is not product-shaped for findings/triage (`packages/contracts/src/automation.ts:71-129`, `apps/server/src/persistence/Migrations/044_Automations.ts:51-53`).
- `isTriageRun` exists on the web, but the triage concept is shallow and status-based (`apps/web/src/routes/-automations.shared.tsx:269`).
- Sidebar badge currently derives from automation query state and can reflect stale historical run states rather than unresolved latest work (`apps/web/src/components/Sidebar.tsx` around automation query/badge logic).
- Detail route shows previous runs and a cancel button only for `pending`, `claimed`, and `running`, not `waiting-for-approval` (`apps/web/src/routes/_chat.automations.$automationId.tsx` run row area).
- OpenAI Codex docs describe an Automations pane with a Triage inbox: runs with findings show up there; users can filter all/unread; no findings can auto-archive. Source: `https://developers.openai.com/codex/app/automations`.

## Commands you will need

| Purpose                    | Command                                                                                                                              | Expected on success                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Contracts tests            | `cd packages/contracts && bun run test src/automation.test.ts`                                                                       | exit 0                                     |
| Server automation tests    | `cd apps/server && bun run test src/automation/Layers/AutomationService.test.ts src/persistence/Layers/AutomationRepository.test.ts` | exit 0                                     |
| Web focused tests          | `cd apps/web && bun run test <new/changed automation tests>`                                                                         | exit 0                                     |
| Full required verification | `bun fmt && bun lint && bun typecheck`                                                                                               | exit 0; run only when explicitly requested |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless explicitly requested.

## Scope

**In scope**:

- `packages/contracts/src/automation.ts`
- `packages/contracts/src/automation.test.ts`
- `apps/server/src/automation/Layers/AutomationService.ts`
- `apps/server/src/automation/Layers/AutomationService.test.ts`
- `apps/server/src/persistence/Migrations/*_*.ts` if schema additions are needed
- `apps/server/src/persistence/Services/AutomationRepository.ts`
- `apps/server/src/persistence/Layers/AutomationRepository.ts`
- `apps/server/src/persistence/Layers/AutomationRepository.test.ts`
- `apps/web/src/routes/-automations.shared.tsx`
- `apps/web/src/routes/_chat.automations.index.tsx`
- `apps/web/src/routes/_chat.automations.$automationId.tsx`
- `apps/web/src/components/Sidebar.tsx`

**Out of scope**:

- Natural-language creation changes (Plan 003).
- Scheduler precision/timer semantics (Plan 002).
- Provider prompt engineering for finding extraction beyond minimal result summarization.

## Steps

### Step 1: Define a first-class run result shape

Extend contracts with a typed result model. Recommended shape:

```ts
const AutomationRunResult = Schema.Struct({
  outcome: Schema.Literals([
    "findings",
    "no-findings",
    "changed-files",
    "needs-attention",
    "unknown",
  ]),
  summary: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  severity: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  unread: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
});
```

Keep backward compatibility by decoding old `result_json = null` as `null`. Do not require all old rows to migrate immediately.

**Verify**: Add contract tests for result decode, null result, and invalid outcome.

### Step 2: Store and update triage metadata

If current `result_json` is enough, store the result object there. If querying unread/archived efficiently needs columns, add a migration with:

- `result_outcome TEXT`
- `result_unread INTEGER`
- `result_archived_at TEXT`

Prefer using `result_json` only for MVP if query volume is small; add indexes only when needed.

Repository methods to add/update:

- mark run result
- mark run read/unread
- archive/unarchive run
- list triage runs by unresolved/unread/all

**Verify**: Repository tests for result persistence, unread filtering, archive filtering.

### Step 3: Infer MVP result from run/thread state

At terminal run reconciliation:

- `failed`, `interrupted`, `waiting-for-approval` terminal/attention states → `needs-attention`, unread true.
- `succeeded` with file changes or notable assistant output → `findings` or `changed-files`, unread true.
- `succeeded` with no meaningful output/no changes → `no-findings`, unread false and optionally archived.

If reliable file-change detection is not already available from projection state, use a conservative MVP:

- succeeded → `unknown`, unread true
- failed/interrupted/waiting → `needs-attention`, unread true

Do not attempt complex LLM result classification in this plan unless there is already a cheap summarization path.

**Verify**: AutomationService tests for failed → attention, succeeded → result, no duplicate result update on repeated reconcile.

### Step 4: Build Triage section in automations UI

Update automations index:

- Add `Triage` section above Current/Paused.
- Filters: `Unread`, `All`.
- Row shows automation name, run status, summary/outcome, relative time, and CTA to open thread/run.
- `no-findings` archived runs should not show in default triage.

Update detail route:

- Previous runs show outcome, summary, read/archive actions.
- Waiting-for-approval runs must have an Open Thread CTA and Cancel action if cancellation is supported from Plan 001.

**Verify**: Add helper tests for triage filtering and badge counts if UI logic is extracted.

### Step 5: Fix sidebar badge semantics

Change sidebar badge from "any historical failed/cancelled/interrupted/waiting" to "current unresolved/unread triage items".

Rules:

- A stale failed run that user marked read/archived should not keep badge on.
- `waiting-for-approval` should keep badge on until resolved/cancelled/read according to chosen product rule.
- Badge count should be bounded/cheap; avoid scanning unlimited history in render.

**Verify**: Add Sidebar logic tests if existing; otherwise extract badge calculation into a pure helper and test it.

### Step 6: Add run actions

Actions to support:

- Mark read/unread
- Archive/unarchive run
- Retry run (optional; only if lifecycle from Plan 001 supports safe retry)
- Cancel waiting-for-approval/running/pending
- Open thread

If retry semantics are unclear, implement only mark read/archive/open/cancel and leave retry for a follow-up.

**Verify**: Focused web tests for action availability matrix by run status/outcome.

## Test plan

- Contract tests for result shape.
- Repository tests for result/read/archive persistence.
- AutomationService tests for result state transitions.
- Web pure-helper tests for triage filtering, sidebar badge, action availability.
- Manual smoke:
  - Create/run automation that fails → appears unread in Triage.
  - Mark read/archive → badge disappears.
  - Run needing approval → Open Thread + Cancel visible.

## Done criteria

- [ ] Run results have typed outcome/summary/unread/archive state.
- [ ] Triage section shows unresolved/unread automation runs.
- [ ] Sidebar badge reflects unresolved/unread triage, not stale history.
- [ ] Run detail exposes read/archive/open/cancel actions consistently.
- [ ] Focused tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Reliable result inference requires reading provider-specific event payloads not exposed in shared contracts.
- Efficient triage filtering requires a schema migration larger than expected; report with migration proposal.
- Retry is requested but safe idempotent retry is not available from Plan 001.

## Maintenance notes

Keep MVP classification conservative. It is better to show `unknown` as unread than to auto-archive a run that actually changed files or needs review.
