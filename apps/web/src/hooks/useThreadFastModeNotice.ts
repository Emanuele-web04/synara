import type { ThreadId } from "@synara/contracts";
import { useMemo } from "react";

import {
  FAST_MODE_STATE_ACTIVITY_KIND,
  fastModeNoticeFromActivity,
  type FastModeNotice,
} from "~/lib/fastModeState";
import { useStore } from "~/store";

// Fast-mode notice for a thread that is not the open one (sidebar hover card,
// project panel). Selects only the latest state activity, which is reference-stable,
// so ordinary activity streaming does not re-render the caller.
export function useThreadFastModeNotice(
  threadId: ThreadId | null | undefined,
): FastModeNotice | null {
  const activity = useStore((state) => {
    if (!threadId) return null;
    const activityIds = state.activityIdsByThreadId?.[threadId];
    const activityById = state.activityByThreadId?.[threadId];
    if (!activityIds || !activityById) return null;
    for (let index = activityIds.length - 1; index >= 0; index -= 1) {
      const candidate = activityById[activityIds[index]!];
      if (candidate?.kind === "provider.handoff") return null;
      if (candidate?.kind === FAST_MODE_STATE_ACTIVITY_KIND) return candidate;
    }
    return null;
  });
  return useMemo(() => fastModeNoticeFromActivity(activity), [activity]);
}
