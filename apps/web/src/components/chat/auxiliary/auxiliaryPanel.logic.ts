export type ChatAuxiliarySurface = "environment" | "project" | "library";

export function resolveProjectPanelEnabled(input: {
  readonly environmentEnabled: boolean;
  readonly isGroupContainer: boolean;
}): boolean {
  return input.environmentEnabled && input.isGroupContainer;
}

/**
 * An explicit dock-surface choice made in this ChatView mount. It is scoped to
 * the project that was active when the user toggled — once the chat switches to
 * another project, the choice no longer applies and the surface falls back to
 * the default below.
 */
export interface AuxiliarySurfaceChoice {
  readonly projectId: string | null;
  readonly surface: ChatAuxiliarySurface | null;
}

/**
 * Which auxiliary dock surface shows for the active chat. An in-scope explicit
 * choice always wins (including `surface: null`, an explicit "closed").
 * Otherwise a group container defaults to the Groups panel — so a newly created
 * group's coordinator chat opens with the panel visible — unless the user
 * previously closed it for that group (persisted in the group-panel closed
 * store). Every other chat falls back to the Environment panel preference.
 */
export function resolveAuxiliarySurface(input: {
  readonly choice: AuxiliarySurfaceChoice | null;
  readonly projectId: string | null;
  readonly projectPanelEnabled: boolean;
  readonly environmentPanelVisible: boolean;
  readonly groupPanelClosed: boolean;
}): ChatAuxiliarySurface | null {
  const choice = input.choice;
  if (choice !== null && choice.projectId === input.projectId) {
    if (choice.surface === "project" || choice.surface === "library") {
      return input.projectPanelEnabled ? choice.surface : null;
    }
    return choice.surface === "environment" && input.environmentPanelVisible ? "environment" : null;
  }
  if (input.projectPanelEnabled && !input.groupPanelClosed) {
    return "project";
  }
  return input.environmentPanelVisible ? "environment" : null;
}
