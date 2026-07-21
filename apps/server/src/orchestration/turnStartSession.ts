import type {
  ModelSelection,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";

export function deriveTurnStartModelSelection(input: {
  readonly currentModelSelection: ModelSelection;
  readonly requestedModelSelection: ModelSelection | undefined;
  readonly canAdoptRequestedProvider: boolean;
}): ModelSelection {
  const requestedModelSelection = input.requestedModelSelection;
  return requestedModelSelection !== undefined &&
    (requestedModelSelection.provider === input.currentModelSelection.provider ||
      input.canAdoptRequestedProvider)
    ? requestedModelSelection
    : input.currentModelSelection;
}

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession: OrchestrationSession | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
}): OrchestrationSession | null {
  if (
    input.currentSession?.status === "starting" ||
    input.currentSession?.status === "running"
  ) {
    return null;
  }

  return {
    threadId: input.threadId,
    status: "starting",
    providerName: input.currentSession?.providerName ?? input.providerName,
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
