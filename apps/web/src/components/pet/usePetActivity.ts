// FILE: usePetActivity.ts
// Purpose: Derives the pet-attached activity pill from global thread summaries.
// Layer: Pet overlay UI hook
// Exports: usePetActivity for in-app and desktop pet overlay state

import type { DesktopPetOverlayState, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  collectBackgroundThreadActivityItems,
  type BackgroundThreadActivityItem,
} from "~/backgroundThreadActivity";
import {
  activityLabel,
  useVisibleThreadIdsFromRoute,
} from "~/backgroundThreadActivityPresentation";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";

const MAX_PET_ACTIVITY_ITEMS = 12;
const NO_VISIBLE_THREAD_IDS = new Set<ThreadId>();

export type PetActivitySummary = NonNullable<DesktopPetOverlayState["activity"]>;

export function usePetActivity(desktopOverlayActive: boolean): {
  readonly activityItems: readonly BackgroundThreadActivityItem[];
  readonly activitySummary: PetActivitySummary | null;
  readonly openPrimaryActivity: () => void;
  readonly primaryActivity: BackgroundThreadActivityItem | null;
} {
  const navigate = useNavigate();
  const routeVisibleThreadIds = useVisibleThreadIdsFromRoute();
  const threads = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const visibleThreadIds = desktopOverlayActive ? NO_VISIBLE_THREAD_IDS : routeVisibleThreadIds;

  const activityItems = useMemo(
    () =>
      collectBackgroundThreadActivityItems({
        threads,
        visibleThreadIds,
        limit: MAX_PET_ACTIVITY_ITEMS,
      }),
    [threads, visibleThreadIds],
  );
  const primaryActivity = activityItems[0] ?? null;

  const activitySummary = useMemo(() => {
    if (!primaryActivity) {
      return null;
    }

    const hiddenActivityCount = Math.max(0, activityItems.length - 1);
    return {
      kind: primaryActivity.kind,
      label:
        activityItems.length === 1
          ? `${activityLabel(primaryActivity.kind)} in another chat`
          : `${activityItems.length} chats active`,
      title:
        hiddenActivityCount > 0
          ? `${primaryActivity.title} +${hiddenActivityCount}`
          : primaryActivity.title,
    };
  }, [activityItems.length, primaryActivity]);

  const openPrimaryActivity = useCallback(() => {
    if (!primaryActivity) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: primaryActivity.threadId },
      search: (previous) => ({ ...previous, splitViewId: undefined }),
    });
  }, [navigate, primaryActivity]);

  return {
    activityItems,
    activitySummary,
    openPrimaryActivity,
    primaryActivity,
  };
}
