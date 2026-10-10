import type { OrchestrationEvent, OrchestrationThreadActivity, TurnId } from "@synara/contracts";

// Intent records who requested a stop; only the terminal outcome confirms it.
// Quitting the app interrupts sessions for recovery, without using Stop.
export function deriveTurnStopActivity(
  event: Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>,
  activeTurnId: TurnId | null,
): OrchestrationThreadActivity | null {
  if (event.commandId?.startsWith("quit-resume-interrupt:")) return null;
  const turnId = event.payload.turnId ?? activeTurnId;
  if (turnId === null) return null;
  return {
    id: event.eventId,
    turnId,
    createdAt: event.payload.createdAt,
    tone: "info",
    kind: "turn.stop-requested",
    summary: "Stop requested",
    payload: {},
    sequence: event.sequence,
    sequenceSource: "orchestration",
  };
}
