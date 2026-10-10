import type { OrchestrationCommand } from "@synara/contracts";

export const ORCHESTRATION_COMMAND_QUEUE_CAPACITY = 256;
export const ORCHESTRATION_COMMAND_CONTROL_RESERVE = 32;
export const ORCHESTRATION_EVENT_PUBSUB_CAPACITY = 1_024;

export type OrchestrationCommandAdmissionDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "overloaded" | "stopped" };

/**
 * Priority for ready aggregate heads and commit waiters. Commands retain FIFO
 * within an aggregate key; priority does not preempt an active command/commit.
 *
 * - `control`: settle or abort work that already exists (stop, interrupt,
 *   completion commands). Ahead of other ready keys, with reserved admission.
 * - `user`: direct user actions that create new work. Ahead of background
 *   traffic, but behind ready controls. Existing same-key work and occupied
 *   preparation workers can still delay a control.
 * - `normal`: retention, projections and every other background command.
 */
export type OrchestrationCommandLane = "control" | "user" | "normal";

/**
 * Commands that may use the reserved capacity and stay admissible while the
 * engine is quiescing.
 *
 * Membership means "this command settles work that is already in flight", so
 * admitting it can only bring the engine closer to idle. A command that starts
 * new work must never be listed here: during quiesce it would spawn a provider
 * turn the shutdown is about to fence, orphaning it. Lane priority for user
 * actions is expressed by {@link orchestrationCommandLane} instead.
 */
export function usesReservedCommandAdmission(type: OrchestrationCommand["type"]): boolean {
  switch (type) {
    case "thread.turn.interrupt":
    // task stop/background are user control-plane actions like interrupt — must stay admissible when the queue is saturated with data traffic
    case "thread.task.stop":
    case "thread.task.background":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.session.stop":
    case "thread.turn.dispatch-queued":
    case "thread.session.set":
    case "thread.message.assistant.complete":
    case "thread.turn.diff.complete":
    case "thread.revert.complete":
    case "thread.conversation.rollback.complete":
      return true;
    default:
      return false;
  }
}

export function isQuiescingCommandAdmissible(type: OrchestrationCommand["type"]): boolean {
  // settlement diagnostics must survive quiesce but stay in the normal lane — activity traffic can't consume capacity reserved for stopping work
  return usesReservedCommandAdmission(type) || type === "thread.activity.append";
}

export function orchestrationCommandLane(
  type: OrchestrationCommand["type"],
): OrchestrationCommandLane {
  if (usesReservedCommandAdmission(type)) {
    return "control";
  }
  switch (type) {
    // Direct user actions must not sit behind retention and other background
    // projection traffic. They get their own lane rather than the control lane,
    // so ready turn starts on other keys do not outrank a ready stop.
    case "thread.create":
    case "thread.turn.start":
    case "thread.checkpoint.revert":
    case "thread.conversation.rollback":
    case "thread.message.edit-and-resend":
      return "user";
    default:
      return "normal";
  }
}
