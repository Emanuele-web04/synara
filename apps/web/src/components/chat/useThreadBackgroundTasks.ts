// FILE: useThreadBackgroundTasks.ts
// Purpose: The thread's background tasks for the Environment panel summary and the
//          right-dock Background tasks list, plus the Stop control both share. The
//          transcript keeps no live rows for them, so these are their only controls.
// Layer: Chat hooks
// Exports: useThreadBackgroundTasks, useStopBackgroundTask

import type { ThreadId } from "@synara/contracts";
import { useCallback, useMemo } from "react";

import { useTranslation } from "~/i18n";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { deriveThreadBackgroundTasks, type WorkLogBackgroundTask } from "../../workLog";
import { toastManager } from "../ui/toast";

const EMPTY_BACKGROUND_TASKS: ReadonlyArray<WorkLogBackgroundTask> = [];

export function useThreadBackgroundTasks(
  threadId: ThreadId | null,
): ReadonlyArray<WorkLogBackgroundTask> {
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const activities = thread?.activities;
  return useMemo(
    () => (activities ? deriveThreadBackgroundTasks(activities) : EMPTY_BACKGROUND_TASKS),
    [activities],
  );
}

// A rejected stop leaves the task running, so the failure is reported instead of swallowed.
export function useStopBackgroundTask(threadId: ThreadId | null): (taskId: string) => void {
  const { t } = useTranslation();
  return useCallback(
    (taskId: string) => {
      const api = readNativeApi();
      if (!api || !threadId) return;
      void api.orchestration
        .dispatchCommand({
          type: "thread.task.stop",
          commandId: newCommandId(),
          threadId,
          taskId,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("chat:couldNotStopTheBackgroundTask"),
            description: error instanceof Error ? error.message : t("chat:tryAgainInAMoment"),
          });
        });
    },
    [threadId, t],
  );
}
