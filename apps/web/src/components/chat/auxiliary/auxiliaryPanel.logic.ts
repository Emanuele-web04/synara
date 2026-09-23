export type ChatAuxiliarySurface = "environment" | "project" | "library";

export function resolveProjectPanelEnabled(input: {
  readonly environmentEnabled: boolean;
  readonly isGroupContainer: boolean;
}): boolean {
  return input.environmentEnabled && input.isGroupContainer;
}
