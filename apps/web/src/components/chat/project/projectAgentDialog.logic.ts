import type {
  ModelSelection,
  ProjectAgentConfigureInput,
  ProjectAgentOverview,
  ProjectId,
} from "@synara/contracts";

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

export function isProjectAgentRowVisible(input: {
  readonly projectExpanded: boolean;
  readonly pinned: boolean;
}): boolean {
  return input.pinned || input.projectExpanded;
}

export function buildProjectAgentConfigureInput(input: {
  readonly projectId: ProjectId;
  readonly coordinatorName: string;
  readonly modelSelection: ModelSelection;
  readonly expectedRevision?: number | undefined;
  readonly importedInstructions?: string | undefined;
  readonly goal?: string | undefined;
  readonly icon?: string | undefined;
  readonly autoMemoryEnabled?: boolean | undefined;
  readonly userDisplayName?: string | undefined;
  readonly requestId?: string | undefined;
}): ProjectAgentConfigureInput {
  return {
    requestId: input.requestId ?? crypto.randomUUID(),
    projectId: input.projectId,
    coordinatorModelSelection: input.modelSelection,
    coordinatorName: input.coordinatorName,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.importedInstructions?.trim()
      ? { importedInstructions: input.importedInstructions }
      : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
    ...(input.autoMemoryEnabled !== undefined
      ? { autoMemoryEnabled: input.autoMemoryEnabled }
      : {}),
    ...(input.userDisplayName?.trim() ? { userDisplayName: input.userDisplayName.trim() } : {}),
  };
}

export type SaveProjectAgentDialogResult =
  | { readonly ok: true; readonly overview: ProjectAgentOverview }
  | { readonly ok: false; readonly error: string };

export async function saveProjectAgentDialog(input: {
  readonly projectId: ProjectId | null;
  readonly coordinatorName: string;
  readonly modelSelection: ModelSelection;
  readonly expectedRevision?: number | undefined;
  readonly goal?: string | undefined;
  readonly icon?: string | undefined;
  readonly autoMemoryEnabled?: boolean | undefined;
  readonly userDisplayName?: string | undefined;
  readonly requestId?: string | undefined;
  readonly configure:
    | ((payload: ProjectAgentConfigureInput) => Promise<ProjectAgentOverview>)
    | null
    | undefined;
}): Promise<SaveProjectAgentDialogResult> {
  if (!input.projectId) {
    return { ok: false, error: "Select a project before setting up the agent." };
  }
  if (!input.configure) {
    return { ok: false, error: "Project agent is unavailable." };
  }
  try {
    const overview = await input.configure(
      buildProjectAgentConfigureInput({
        projectId: input.projectId,
        coordinatorName: input.coordinatorName,
        modelSelection: input.modelSelection,
        expectedRevision: input.expectedRevision,
        goal: input.goal,
        icon: input.icon,
        autoMemoryEnabled: input.autoMemoryEnabled,
        userDisplayName: input.userDisplayName,
        requestId: input.requestId,
      }),
    );
    return { ok: true, overview };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the project agent.",
    };
  }
}
