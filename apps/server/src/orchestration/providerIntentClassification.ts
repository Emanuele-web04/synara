import type { OrchestrationEvent } from "@synara/contracts";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.created"
      | "thread.deleted"
      | "thread.archived"
      | "thread.unarchived"
      | "thread.meta-updated"
      | "thread.session-set"
      | "thread.runtime-mode-set"
      | "thread.interaction-mode-set"
      | "thread.turn-queued"
      | "thread.turn-start-requested"
      | "thread.claude-cache-response-requested"
      | "thread.goal-continuation-requested"
      | "thread.turn-interrupt-requested"
      | "thread.task-stop-requested"
      | "thread.task-background-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.conversation-rollback-requested"
      | "thread.message-edit-resend-requested"
      | "thread.session-stop-requested";
  }
>;

const PROVIDER_INTENT_EVENT_TYPES = new Set<ProviderIntentEvent["type"]>([
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.session-set",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.claude-cache-response-requested",
  "thread.goal-continuation-requested",
  "thread.turn-interrupt-requested",
  "thread.task-stop-requested",
  "thread.task-background-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.conversation-rollback-requested",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
]);

export const isProviderIntentEventType = (
  eventType: string,
): eventType is ProviderIntentEvent["type"] =>
  PROVIDER_INTENT_EVENT_TYPES.has(eventType as ProviderIntentEvent["type"]);

export const isProviderIntentEvent = (event: OrchestrationEvent): event is ProviderIntentEvent =>
  isProviderIntentEventType(event.type);

export const isReplaySafeClaimedProviderIntent = (event: ProviderIntentEvent): boolean =>
  event.type === "thread.created" ||
  event.type === "thread.archived" ||
  event.type === "thread.unarchived" ||
  // The claimed handler only performs the idempotent durable enqueue. Queue
  // draining runs after the delivery settles, so replay never repeats provider
  // dispatch as part of this claim.
  event.type === "thread.turn-queued";

export const isProviderSideEffectIntent = (event: ProviderIntentEvent): boolean =>
  event.type !== "thread.created" &&
  event.type !== "thread.deleted" &&
  // Restores only the computer manager's local admission state. It is safe to
  // replay and must not be skipped by an unrelated provider delivery failure.
  event.type !== "thread.unarchived" &&
  event.type !== "thread.session-set" &&
  event.type !== "thread.turn-queued";

export const isClaimedProviderIntent = (event: ProviderIntentEvent): boolean =>
  isReplaySafeClaimedProviderIntent(event) || isProviderSideEffectIntent(event);

/**
 * Intents that must still execute while a thread is quarantined by a blocking
 * delivery. Interrupt, stop and archive must still be able to tear down live
 * work; quarantining new work must never disable cancellation.
 */
export const isQuarantineExemptProviderIntent = (event: ProviderIntentEvent): boolean =>
  event.type === "thread.turn-interrupt-requested" ||
  event.type === "thread.session-stop-requested" ||
  event.type === "thread.archived";
