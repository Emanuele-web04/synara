// Purpose: Event-shape types selected from the orchestration/provider event unions
//   that the ProviderCommandReactor reacts to.
// Layer: orchestration layer support (type-only; no runtime).
// Exports: ProviderIntentEvent, ProviderQueueDrainEvent.

import type { OrchestrationEvent, ProviderRuntimeEvent } from "@t3tools/contracts";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.created"
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-queued"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.conversation-rollback-requested"
      | "thread.message-edit-resend-requested"
      | "thread.session-stop-requested"
      | "thread.session-ensure-requested"
      | "thread.runtime-action-requested";
  }
>;

export type ProviderQueueDrainEvent = Extract<
  ProviderRuntimeEvent,
  {
    type: "turn.completed" | "turn.aborted";
  }
>;
