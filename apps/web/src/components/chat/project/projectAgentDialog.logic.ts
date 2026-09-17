import type { ModelSelection, ProjectAgentConfigureInput, ProjectId } from "@synara/contracts";

export function defaultProjectAgentName(projectName: string): string {
  const trimmed = projectName.trim();
  return trimmed.length > 0 ? `${trimmed} Coordinator` : "Project Coordinator";
}

export function resolveProjectAgentName(input: {
  readonly value: string;
  readonly fallbackName: string;
}): string {
  const trimmed = input.value.trim();
  return trimmed.length > 0 ? trimmed : input.fallbackName;
}

export function buildProjectAgentConfigureInput(input: {
  readonly projectId: ProjectId;
  readonly coordinatorName: string;
  readonly modelSelection: ModelSelection;
  readonly expectedRevision?: number | undefined;
  readonly importedInstructions?: string | undefined;
}): ProjectAgentConfigureInput {
  return {
    requestId: crypto.randomUUID(),
    projectId: input.projectId,
    coordinatorModelSelection: input.modelSelection,
    coordinatorName: input.coordinatorName,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.importedInstructions?.trim()
      ? { importedInstructions: input.importedInstructions }
      : {}),
  };
}
