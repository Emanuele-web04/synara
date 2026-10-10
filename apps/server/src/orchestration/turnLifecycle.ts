import type { OrchestrationSession } from "@synara/contracts";

type TurnState = "pending" | "running" | "completed" | "interrupted" | "error";

/** terminal turn state implied by a session update, or null while the provider can still deliver the authoritative event */
export function settleTurnStateFromSession(
  session: Pick<OrchestrationSession, "status" | "activeTurnId">,
  existingState: TurnState,
): Exclude<TurnState, "pending" | "running"> | null {
  if (session.activeTurnId !== null && session.status !== "error") {
    return null;
  }

  switch (session.status) {
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "ready":
      return existingState === "error"
        ? "error"
        : existingState === "interrupted"
          ? "interrupted"
          : "completed";
    case "idle":
    case "starting":
    case "running":
      return null;
  }
}

/** later events can carry earlier timestamps (retries, imports, reconciliation) — thread timestamp advancement must be monotonic or a regressed updatedAt re-marks read chats unread after restart */
export function maxIso(left: string | null, right: string): string {
  return left === null || right > left ? right : left;
}
