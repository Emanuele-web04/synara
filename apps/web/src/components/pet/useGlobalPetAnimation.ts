// FILE: useGlobalPetAnimation.ts
// Purpose: Reads all sidebar thread summaries needed to drive the global pet state.
// Layer: Global pet overlay route/store bridge
// Exports: useGlobalPetAnimation

import { useMemo } from "react";

import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";

import { resolveGlobalPetAnimation, type CodexPetAnimation } from "./petModel";

export function useGlobalPetAnimation(): CodexPetAnimation {
  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);

  return useStore(
    useMemo(
      () => (state) =>
        resolveGlobalPetAnimation(
          selectSidebarThreads(state).map((thread) => ({
            archivedAt: thread.archivedAt,
            sessionStatus: thread.session?.status ?? null,
            orchestrationStatus: thread.session?.orchestrationStatus ?? null,
            latestTurnState: thread.latestTurn?.state ?? null,
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            hasActionableProposedPlan: thread.hasActionableProposedPlan,
            hasLiveTailWork: thread.hasLiveTailWork,
            error: thread.session?.lastError ?? null,
          })),
        ),
      [selectSidebarThreads],
    ),
  );
}
