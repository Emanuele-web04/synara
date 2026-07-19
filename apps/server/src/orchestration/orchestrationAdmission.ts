import type { OrchestrationCommand } from "@synara/contracts";
import { Queue } from "effect";

export const ORCHESTRATION_COMMAND_QUEUE_CAPACITY = 256;
export const ORCHESTRATION_COMMAND_CONTROL_RESERVE = 32;
export const ORCHESTRATION_EVENT_PUBSUB_CAPACITY = 1_024;

export interface OrchestrationCommandAdmissionPolicy {
  readonly capacity: number;
  readonly reservedCapacity: number;
}

export type OrchestrationCommandAdmissionDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "overloaded" | "stopped" };

export function usesReservedCommandAdmission(type: OrchestrationCommand["type"]): boolean {
  switch (type) {
    case "thread.turn.interrupt":
    // Task stop/background are user control-plane actions like interrupt:
    // they must stay admissible when the queue is saturated with data traffic.
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

export function tryAdmitOrchestrationCommand<A>(input: {
  readonly queue: Queue.Queue<A>;
  readonly envelope: A;
  readonly commandType: OrchestrationCommand["type"];
  readonly policy?: OrchestrationCommandAdmissionPolicy;
}): OrchestrationCommandAdmissionDecision {
  const policy = input.policy ?? {
    capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
    reservedCapacity: ORCHESTRATION_COMMAND_CONTROL_RESERVE,
  };
  if (
    !Number.isSafeInteger(policy.capacity) ||
    policy.capacity <= 0 ||
    !Number.isSafeInteger(policy.reservedCapacity) ||
    policy.reservedCapacity <= 0 ||
    policy.reservedCapacity >= policy.capacity
  ) {
    throw new RangeError(
      "Orchestration command admission requires a positive capacity and a smaller positive reserve.",
    );
  }
  if (input.queue.state._tag !== "Open") {
    return { accepted: false, reason: "stopped" };
  }

  const admissionLimit = usesReservedCommandAdmission(input.commandType)
    ? policy.capacity
    : policy.capacity - policy.reservedCapacity;
  if (Queue.sizeUnsafe(input.queue) >= admissionLimit) {
    return { accepted: false, reason: "overloaded" };
  }
  return Queue.offerUnsafe(input.queue, input.envelope)
    ? { accepted: true }
    : {
        accepted: false,
        reason: input.queue.state._tag === "Open" ? "overloaded" : "stopped",
      };
}
