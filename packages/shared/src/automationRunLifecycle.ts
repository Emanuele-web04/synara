// FILE: automationRunLifecycle.ts
// Purpose: Single declaration of the automation run state machine.
// Layer: Shared runtime utility (server reconciliation/persistence guards + web run rows)
// Exports: the transition table, the active/terminal partitions, and their predicates.
// Depends on: automation contracts shared with the native API.
//
// A run answers one question at a time: can it still change?
//   active   -> pending | claimed | running | waiting-for-approval
//   terminal -> succeeded | failed | cancelled | interrupted | skipped
//
//   pending ─┬─> running <──> waiting-for-approval
//            │      │                  │
//            │      └──────┬───────────┘
//            │             v
//            ├─> succeeded | failed | cancelled | interrupted
//            └─> skipped            (only before the run has started)
//
// Terminal means terminal: nothing leaves those five statuses. The SQL guards in
// AutomationRepository are the authoritative enforcement (they make each transition an
// atomic compare-and-set), and the lifecycle matrix in `AutomationRepository.test.ts` fails when one of them
// stops matching this table. Branch on these predicates instead of comparing status
// literals, so adding a status cannot leave one guard, reconciler, or list row behind.
//
// `claimed` is declared by the contract and treated as active everywhere, but no code
// path writes it: claiming a run inserts it as `pending` with a lease. It keeps the same
// outgoing edges as `pending` so a row carrying it can always be settled.

import type { AutomationRunStatus } from "@synara/contracts";

export const ACTIVE_AUTOMATION_RUN_STATUSES = [
  "pending",
  "claimed",
  "running",
  "waiting-for-approval",
] as const satisfies ReadonlyArray<AutomationRunStatus>;

export type ActiveAutomationRunStatus = (typeof ACTIVE_AUTOMATION_RUN_STATUSES)[number];

export const TERMINAL_AUTOMATION_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
] as const satisfies ReadonlyArray<AutomationRunStatus>;

export type TerminalAutomationRunStatus = (typeof TERMINAL_AUTOMATION_RUN_STATUSES)[number];

/** Every status a run may move to from the keyed status. Terminal statuses map to none. */
export const AUTOMATION_RUN_TRANSITIONS = {
  pending: [
    "running",
    "waiting-for-approval",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "skipped",
  ],
  claimed: [
    "running",
    "waiting-for-approval",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "skipped",
  ],
  running: ["waiting-for-approval", "succeeded", "failed", "cancelled", "interrupted"],
  "waiting-for-approval": ["running", "succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  skipped: [],
} as const satisfies Record<AutomationRunStatus, ReadonlyArray<AutomationRunStatus>>;

const ACTIVE_STATUS_SET: ReadonlySet<AutomationRunStatus> = new Set(ACTIVE_AUTOMATION_RUN_STATUSES);

/** The run can still change: it holds its thread's run slot and can be cancelled. */
export function isActiveAutomationRunStatus(
  status: AutomationRunStatus,
): status is ActiveAutomationRunStatus {
  return ACTIVE_STATUS_SET.has(status);
}

/** The run is settled; reconciliation and late provider events must not overwrite it. */
export function isTerminalAutomationRunStatus(
  status: AutomationRunStatus,
): status is TerminalAutomationRunStatus {
  return !ACTIVE_STATUS_SET.has(status);
}

export function canTransitionAutomationRun(
  from: AutomationRunStatus,
  to: AutomationRunStatus,
): boolean {
  return (AUTOMATION_RUN_TRANSITIONS[from] as ReadonlyArray<AutomationRunStatus>).includes(to);
}

/** Statuses from which `to` is reachable, in declaration order. */
export function automationRunStatusesLeadingTo(
  to: AutomationRunStatus,
): ReadonlyArray<AutomationRunStatus> {
  return (Object.keys(AUTOMATION_RUN_TRANSITIONS) as AutomationRunStatus[]).filter((from) =>
    canTransitionAutomationRun(from, to),
  );
}
