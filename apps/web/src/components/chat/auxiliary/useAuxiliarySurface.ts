// FILE: useAuxiliarySurface.ts
// Purpose: Resolves which auxiliary dock surface (Environment / Groups /
//          Library) shows for the active chat. An explicit toggle wins while the
//          project it was made in stays active; otherwise the default kicks in —
//          the Groups panel for a group the user has not dismissed, otherwise
//          the Environment panel preference. Closing the Groups panel is
//          persisted per group (groupPanelClosedStore), deliberately separate
//          from the Environment panel preference.
// Layer: Chat UI hook

import type { ProjectId } from "@synara/contracts";
import { useCallback, useState } from "react";

import { useGroupPanelClosedStore } from "~/groupPanelClosedStore";

import {
  resolveAuxiliarySurface,
  type AuxiliarySurfaceChoice,
  type ChatAuxiliarySurface,
} from "./auxiliaryPanel.logic";

export function useAuxiliarySurface(input: {
  readonly projectId: ProjectId | null;
  readonly projectPanelEnabled: boolean;
  readonly environmentPanelVisible: boolean;
}): {
  readonly auxiliarySurface: ChatAuxiliarySurface | null;
  readonly chooseAuxiliarySurface: (surface: ChatAuxiliarySurface | null) => void;
  readonly setGroupPanelClosed: (closed: boolean) => void;
} {
  const closedProjectIds = useGroupPanelClosedStore((state) => state.closedProjectIds);
  const persistGroupPanelClosed = useGroupPanelClosedStore((state) => state.setGroupPanelClosed);
  const [choice, setChoice] = useState<AuxiliarySurfaceChoice | null>(null);
  const auxiliarySurface = resolveAuxiliarySurface({
    choice,
    projectId: input.projectId,
    projectPanelEnabled: input.projectPanelEnabled,
    environmentPanelVisible: input.environmentPanelVisible,
    groupPanelClosed: input.projectId !== null && closedProjectIds.includes(input.projectId),
  });
  const chooseAuxiliarySurface = useCallback(
    (surface: ChatAuxiliarySurface | null) => {
      setChoice({ projectId: input.projectId, surface });
    },
    [input.projectId],
  );
  const setGroupPanelClosed = useCallback(
    (closed: boolean) => {
      if (input.projectId !== null) {
        persistGroupPanelClosed(input.projectId, closed);
      }
    },
    [input.projectId, persistGroupPanelClosed],
  );
  return { auxiliarySurface, chooseAuxiliarySurface, setGroupPanelClosed };
}
