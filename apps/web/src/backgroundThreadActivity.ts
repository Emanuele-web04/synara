// FILE: backgroundThreadActivity.ts
// Purpose: Derives cross-chat activity state for threads that keep working outside the visible chat.
// Layer: Global orchestration UI helpers
// Exports: background activity selectors used by subscriptions and the bottom activity dock

import type { ThreadId } from "@t3tools/contracts";
import { hasLiveLatestTurn } from "./session-logic";
import type { SidebarThreadSummary } from "./types";

export type BackgroundThreadActivityKind = "input-needed" | "working" | "connecting";

export interface BackgroundThreadActivityItem {
  readonly threadId: ThreadId;
  readonly projectId: SidebarThreadSummary["projectId"];
  readonly title: string;
  readonly kind: BackgroundThreadActivityKind;
  readonly updatedAt: string;
}

type BackgroundThreadSummaryInput = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "hasLiveTailWork"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "id"
  | "latestTurn"
  | "projectId"
  | "session"
  | "title"
  | "updatedAt"
>;

function isLiveOrchestrationStatus(
  status: NonNullable<SidebarThreadSummary["session"]>["orchestrationStatus"] | null | undefined,
): boolean {
  return status === "starting" || status === "running";
}

export function resolveBackgroundThreadActivityKind(
  thread: BackgroundThreadSummaryInput,
): BackgroundThreadActivityKind | null {
  if (thread.archivedAt != null) {
    return null;
  }

  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "input-needed";
  }

  if (
    thread.session?.status === "connecting" ||
    thread.session?.orchestrationStatus === "starting"
  ) {
    return "connecting";
  }

  if (
    thread.hasLiveTailWork ||
    thread.session?.status === "running" ||
    isLiveOrchestrationStatus(thread.session?.orchestrationStatus) ||
    thread.latestTurn?.state === "running" ||
    hasLiveLatestTurn(thread.latestTurn, thread.session)
  ) {
    return "working";
  }

  return null;
}

export function getThreadIdsNeedingBackgroundDetail(
  threads: readonly BackgroundThreadSummaryInput[],
): ThreadId[] {
  return threads
    .filter((thread) => resolveBackgroundThreadActivityKind(thread) !== null)
    .map((thread) => thread.id);
}

export function collectBackgroundThreadActivityItems(input: {
  readonly threads: readonly BackgroundThreadSummaryInput[];
  readonly visibleThreadIds: ReadonlySet<ThreadId>;
  readonly limit?: number;
}): BackgroundThreadActivityItem[] {
  const limit = input.limit ?? 4;

  return input.threads
    .flatMap((thread): BackgroundThreadActivityItem[] => {
      if (input.visibleThreadIds.has(thread.id)) {
        return [];
      }

      const kind = resolveBackgroundThreadActivityKind(thread);
      if (!kind) {
        return [];
      }

      return [
        {
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title.trim() || "Untitled thread",
          kind,
          updatedAt:
            thread.updatedAt ?? thread.latestTurn?.startedAt ?? thread.session?.updatedAt ?? "",
        },
      ];
    })
    .toSorted((left, right) => {
      const byPriority = activityPriority(right.kind) - activityPriority(left.kind);
      if (byPriority !== 0) {
        return byPriority;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

function activityPriority(kind: BackgroundThreadActivityKind): number {
  switch (kind) {
    case "input-needed":
      return 3;
    case "working":
      return 2;
    case "connecting":
      return 1;
  }
}
