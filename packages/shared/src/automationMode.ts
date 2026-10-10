// mode answers only where a run executes; heartbeat/dedicated share every continuation rule — branch on these predicates, not the literal

import type { AutomationMode, ThreadCreationSource, ThreadId } from "@synara/contracts";

/** runs append to an existing thread instead of creating one */
export function automationContinuesThread(mode: AutomationMode): boolean {
  return mode === "heartbeat" || mode === "dedicated";
}

/** the automation created its continuation thread and is its only writer */
export function automationOwnsItsThread(mode: AutomationMode): boolean {
  return mode === "dedicated";
}

/** the continuation thread must be supplied by the caller before the first run */
export function automationRequiresTargetThread(mode: AutomationMode): boolean {
  return mode === "heartbeat";
}

/** dedicated automations return null exactly once — before their first run has created and claimed the thread */
export function automationContinuationThreadId(definition: {
  readonly mode: AutomationMode;
  readonly targetThreadId: ThreadId | null;
}): ThreadId | null {
  return automationContinuesThread(definition.mode) ? definition.targetThreadId : null;
}

/** marks only standalone's per-run throwaway threads — dedicated/heartbeat continuation threads are never marked */
export function isAutomationRunThread(thread: {
  readonly creationSource?: ThreadCreationSource | null;
}): boolean {
  return thread.creationSource === "automation_run";
}
