import type { OrchestrationEvent, OrchestrationThreadActivity, TurnId } from "@synara/contracts";

// Only explicit manual intent certifies the user Stop control. Automatic,
// agent, steering and historical requests remain neutral without that actor.
export function deriveTurnStopActivity(
  event: Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>,
  activeTurnId: TurnId | null,
): OrchestrationThreadActivity | null {
  if (event.payload.requestedBy !== "user") return null;
  const turnId = event.payload.turnId ?? activeTurnId;
  if (turnId === null) return null;
  return {
    id: event.eventId,
    turnId,
    createdAt: event.payload.createdAt,
    tone: "info",
    kind: "turn.stop-requested",
    summary: "Stop requested",
    payload: { requestedBy: "user" },
    sequence: event.sequence,
    sequenceSource: "orchestration",
  };
}
