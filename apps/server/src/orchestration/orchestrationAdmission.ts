import type { OrchestrationCommand } from "@synara/contracts";
import { Effect, Option, Queue } from "effect";

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

/** control: settle/abort existing work — never blocked; user: direct actions creating new work — ahead of background, behind control so a stop never queues behind turn starts; normal: retention/projections/everything else */
export type OrchestrationCommandLane = "control" | "user" | "normal";

export interface OrchestrationCommandQueues<A> {
  readonly control: Queue.Queue<A>;
  readonly user: Queue.Queue<A>;
  readonly normal: Queue.Queue<A>;
  readonly wake: Queue.Queue<void>;
}

/** membership means "settles work already in flight" — admitting it only brings the engine closer to idle; a command starting new work must never be listed here (during quiesce it would spawn a turn the shutdown fences); user-action priority is expressed by orchestrationCommandLane */
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
    // user actions get their own lane rather than control — a burst of turn starts can't delay a stop
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

export function tryAdmitOrchestrationCommand<A>(input: {
  readonly queues: OrchestrationCommandQueues<A>;
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
  if (
    input.queues.control.state._tag !== "Open" ||
    input.queues.user.state._tag !== "Open" ||
    input.queues.normal.state._tag !== "Open" ||
    input.queues.wake.state._tag !== "Open"
  ) {
    return { accepted: false, reason: "stopped" };
  }

  const lane = orchestrationCommandLane(input.commandType);
  // the reserve is measured against everything already queued — only control commands consume the last slots
  const admissionLimit =
    lane === "control" ? policy.capacity : policy.capacity - policy.reservedCapacity;
  const queued =
    Queue.sizeUnsafe(input.queues.control) +
    Queue.sizeUnsafe(input.queues.user) +
    Queue.sizeUnsafe(input.queues.normal);
  if (queued >= admissionLimit) {
    return { accepted: false, reason: "overloaded" };
  }
  const target = input.queues[lane];
  if (!Queue.offerUnsafe(target, input.envelope)) {
    return {
      accepted: false,
      reason: target.state._tag === "Open" ? "overloaded" : "stopped",
    };
  }
  // one wake token per envelope lets the worker drain lanes in priority order without racing several Queue.take operations
  Queue.offerUnsafe(input.queues.wake, undefined);
  return { accepted: true };
}

export function takeNextOrchestrationCommand<A>(
  queues: OrchestrationCommandQueues<A>,
): Effect.Effect<A> {
  // the token is offered after the envelope — by the time it's taken the envelope is already queued, so polling higher lanes can only miss it if a lower lane holds it
  return Queue.take(queues.wake).pipe(
    Effect.flatMap(() => Queue.poll(queues.control)),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Queue.poll(queues.user).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Queue.take(queues.normal),
              }),
            ),
          ),
      }),
    ),
  );
}
