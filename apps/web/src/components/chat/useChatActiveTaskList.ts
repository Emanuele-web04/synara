import { useMemo } from "react";
import { type OrchestrationThreadActivity, type TurnId } from "@t3tools/contracts";
import {
  deriveActiveBackgroundTasksState,
  deriveActiveTaskListState,
  type ActiveTaskListState,
} from "../../session-logic";

interface UseChatActiveTaskListParams {
  showDebugTaskBanner: boolean;
  latestTurnSettled: boolean;
  latestTurnId: TurnId | null | undefined;
  threadActivities: OrchestrationThreadActivity[];
}

export function useChatActiveTaskList({
  showDebugTaskBanner,
  latestTurnSettled,
  latestTurnId,
  threadActivities,
}: UseChatActiveTaskListParams) {
  const activeTaskList = useMemo((): ActiveTaskListState | null => {
    if (showDebugTaskBanner) {
      return {
        createdAt: new Date().toISOString(),
        turnId: latestTurnId ?? null,
        tasks: [
          {
            task: "Inspect banner layout without overlapping transcript text",
            status: "inProgress",
          },
          {
            task: "Confirm compact task banner width",
            status: "pending",
          },
          {
            task: "Verify sidebar task controls",
            status: "completed",
          },
        ],
      };
    }

    return latestTurnSettled
      ? null
      : deriveActiveTaskListState(threadActivities, latestTurnId ?? undefined);
  }, [latestTurnId, latestTurnSettled, showDebugTaskBanner, threadActivities]);

  const activeBackgroundTasks = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActiveBackgroundTasksState(threadActivities, latestTurnId ?? undefined),
    [latestTurnId, latestTurnSettled, threadActivities],
  );

  return { activeTaskList, activeBackgroundTasks };
}
