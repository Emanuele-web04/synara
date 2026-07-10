import type { OrchestrationEvent } from "@synara/contracts";

const THREAD_SHELL_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

const THREAD_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.created",
  "thread.meta-updated",
  "thread.pinned-message-added",
  "thread.pinned-message-removed",
  "thread.pinned-message-done-set",
  "thread.pinned-message-label-set",
  "thread.marker-added",
  "thread.marker-removed",
  "thread.marker-done-set",
  "thread.marker-label-set",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.turn-start-requested",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
]);

const OTHER_THREAD_SHELL_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.proposed-plan-upserted",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.reverted",
  "thread.conversation-rolled-back",
  "thread.session-set",
  "thread.turn-diff-completed",
]);

export function shouldApplyThreadsProjection(event: OrchestrationEvent): boolean {
  return THREAD_PROJECTION_EVENT_TYPES.has(event.type);
}

export function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload.role === "user";
    case "thread.proposed-plan-upserted":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.reverted":
    case "thread.conversation-rolled-back":
    case "thread.session-set":
    case "thread.turn-diff-completed":
      return true;
    case "thread.activity-appended":
      return THREAD_SHELL_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
    default:
      return false;
  }
}

/** True only when an event can change the persisted thread shell sent to sidebar clients. */
export function shouldPublishThreadShellForEvent(event: OrchestrationEvent): boolean {
  if (shouldApplyThreadsProjection(event) || OTHER_THREAD_SHELL_EVENT_TYPES.has(event.type)) {
    return true;
  }
  if (event.type === "thread.message-sent") {
    return event.payload.role === "user" || event.payload.streaming === false;
  }
  if (event.type === "thread.activity-appended") {
    return THREAD_SHELL_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
  }
  return false;
}
