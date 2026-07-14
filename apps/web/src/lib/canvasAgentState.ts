// FILE: canvasAgentState.ts
// Purpose: Derives the Canvas single-writer lock from the current agent turn's tool activity.
// Layer: Web domain utility

import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  TurnId,
} from "@synara/contracts";

const CANVAS_MUTATION_TOOL_NAMES = ["create_view", "canvas_create_view"];

function activityMentionsCanvasMutation(activity: OrchestrationThreadActivity): boolean {
  const payload = activity.payload as Record<string, unknown>;
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : null;
  const structuredNames = [
    activity.summary,
    payload.toolName,
    payload.title,
    payload.name,
    data?.toolName,
    data?.title,
    data?.name,
  ].filter((value): value is string => typeof value === "string");
  return structuredNames.some((name) => {
    const normalized = name.toLowerCase();
    return CANVAS_MUTATION_TOOL_NAMES.some((toolName) => normalized.includes(toolName));
  });
}

export function canvasAgentMutationTurnId(input: {
  latestTurn: OrchestrationLatestTurn | null;
  activities: readonly OrchestrationThreadActivity[];
}): TurnId | null {
  const turnId = input.latestTurn?.turnId ?? null;
  if (!turnId) return null;
  return input.activities.some(
    (activity) => activity.turnId === turnId && activityMentionsCanvasMutation(activity),
  )
    ? turnId
    : null;
}

export function isCanvasAgentEditing(input: {
  latestTurn: OrchestrationLatestTurn | null;
  activities: readonly OrchestrationThreadActivity[];
}): boolean {
  return (
    input.latestTurn?.state === "running" && canvasAgentMutationTurnId(input) !== null
  );
}
