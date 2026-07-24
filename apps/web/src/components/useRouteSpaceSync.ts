// FILE: useRouteSpaceSync.ts
// Purpose: Synchronize the selected Space only when route identity actually changes.

import type { ProjectId, SpaceId, ThreadId } from "@synara/contracts";
import { useEffect } from "react";

import { useSpacesUiStore } from "../spacesUiStore";

export function useRouteSpaceSync(input: {
  routeProjectId: ProjectId | null;
  routeSpaceId: SpaceId | null | undefined;
  routeThreadId: ThreadId | null;
  isOnKanban: boolean;
}): void {
  const { isOnKanban, routeProjectId, routeSpaceId, routeThreadId } = input;
  const setActiveSpaceId = useSpacesUiStore((store) => store.setActiveSpaceId);
  const rememberSpaceThread = useSpacesUiStore((store) => store.rememberThread);
  const rememberSpaceProject = useSpacesUiStore((store) => store.rememberProject);

  // Deliberately exclude activeSpaceId: a tab click updates selection before navigation lands,
  // and the still-current route must not immediately overwrite that user intent. Primitive route
  // inputs rerun this effect once navigation really changes identity.
  useEffect(() => {
    if (routeProjectId === null || routeSpaceId === undefined) return;
    if (useSpacesUiStore.getState().activeSpaceId !== routeSpaceId) {
      setActiveSpaceId(routeSpaceId);
    }
    if (routeThreadId) {
      rememberSpaceThread(routeSpaceId, routeThreadId);
    } else if (isOnKanban) {
      rememberSpaceProject(routeSpaceId, routeProjectId);
    }
  }, [
    isOnKanban,
    rememberSpaceProject,
    rememberSpaceThread,
    routeProjectId,
    routeSpaceId,
    routeThreadId,
    setActiveSpaceId,
  ]);
}
