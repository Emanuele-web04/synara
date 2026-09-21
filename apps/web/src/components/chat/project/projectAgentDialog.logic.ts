export function defaultProjectAgentName(projectName: string): string {
  const trimmed = projectName.trim();
  return trimmed.length > 0 ? `${trimmed} Coordinator` : "Project Coordinator";
}

export function resolveProjectAgentRowLabel(input: {
  readonly configured: boolean;
  readonly coordinatorName: string | null | undefined;
}): string {
  if (input.configured && input.coordinatorName && input.coordinatorName.trim().length > 0) {
    return input.coordinatorName;
  }
  return "Set up project agent";
}

export function isProjectAgentRowVisible(input: {
  readonly projectExpanded: boolean;
  readonly pinned: boolean;
}): boolean {
  return input.pinned || input.projectExpanded;
}
