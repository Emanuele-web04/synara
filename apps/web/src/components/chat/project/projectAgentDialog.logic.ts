import type { ModelSelection, ProjectAgentConfigureInput, ProjectId } from "@synara/contracts";

export const FALLBACK_PROJECT_AGENT_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};

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

export function resolveProjectAgentModelSelection(input: {
  readonly current: ModelSelection | null | undefined;
  readonly fallback: ModelSelection | null | undefined;
}): ModelSelection {
  return input.current ?? input.fallback ?? FALLBACK_PROJECT_AGENT_MODEL_SELECTION;
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
