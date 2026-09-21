// server-dispatched turns (automation, agent gateway) take precedence over the steer marker so the origin stays visible
export type UserTurnMarkerKind = "automation" | "agent" | "steer";

export function resolveUserTurnMarker(message: {
  readonly dispatchMode?: "queue" | "steer" | undefined;
  readonly dispatchOrigin?: "user" | "automation" | "agent" | undefined;
}): UserTurnMarkerKind | null {
  if (message.dispatchOrigin === "automation") {
    return "automation";
  }
  if (message.dispatchOrigin === "agent") {
    return "agent";
  }
  if (message.dispatchMode === "steer") {
    return "steer";
  }
  return null;
}

export interface UserTurnMediaCounts {
  readonly imageCount: number;
  readonly fileCount: number;
  readonly assistantSelectionCount: number;
  readonly browserAnnotationCount: number;
  readonly fileCommentCount: number;
  readonly pastedTextCount: number;
  readonly pullRequestContextCount: number;
}

// the chip sits directly above any leading media row; bottom margin is larger when media follows
export function hasLeadingUserMedia(counts: UserTurnMediaCounts): boolean {
  return (
    counts.imageCount > 0 ||
    counts.fileCount > 0 ||
    counts.assistantSelectionCount > 0 ||
    counts.browserAnnotationCount > 0 ||
    counts.fileCommentCount > 0 ||
    counts.pastedTextCount > 0 ||
    counts.pullRequestContextCount > 0
  );
}
