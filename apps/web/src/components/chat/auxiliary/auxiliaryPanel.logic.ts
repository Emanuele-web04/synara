export type ChatAuxiliarySurface = "environment" | "project";

export function resolveAuxiliarySurface(input: {
  readonly current: ChatAuxiliarySurface | null;
  readonly next: ChatAuxiliarySurface;
}): ChatAuxiliarySurface | null {
  return input.current === input.next ? null : input.next;
}

export function resolveAuxiliaryOpen(input: {
  readonly surface: ChatAuxiliarySurface | null;
  readonly requested: ChatAuxiliarySurface;
}): boolean {
  return input.surface === input.requested;
}

export function resolveProjectPanelEnabled(input: {
  readonly environmentEnabled: boolean;
  readonly isGroupContainer: boolean;
}): boolean {
  return input.environmentEnabled && input.isGroupContainer;
}

export function resolveAuxiliaryContentProjectId(input: {
  readonly focusedProjectId: string | null;
  readonly cachedProjectId: string | null;
}): string | null {
  return input.focusedProjectId;
}

export const AUXILIARY_PANEL_DOCKED_INSET_PX = 312;
