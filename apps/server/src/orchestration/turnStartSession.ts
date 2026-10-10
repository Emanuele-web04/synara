import type {
  ModelSelection,
  OrchestrationSession,
  ProviderInstanceId,
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

// Sidechats and handoffs import source transcript rows for provider context.
// Those imports must not freeze the first-turn provider the way native history does.
export function countNativeTurnStartMessages(
  messages: ReadonlyArray<{ readonly source?: string | null }>,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.source !== "fork-import" && message.source !== "handoff-import") {
      count += 1;
    }
  }
  return count;
}

export function canAdoptFirstTurnProvider(input: {
  readonly hasLatestTurn: boolean;
  readonly hasSession: boolean;
  readonly messages: ReadonlyArray<{ readonly source?: string | null }>;
}): boolean {
  return (
    !input.hasLatestTurn && !input.hasSession && countNativeTurnStartMessages(input.messages) <= 1
  );
}

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession:
    | OrchestrationSession
    | (Omit<OrchestrationSession, "providerInstanceId"> & {
        readonly providerInstanceId: ProviderInstanceId | null;
      })
    | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly providerInstanceId?: ProviderInstanceId;
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
  /**
   * Whether the projected session's provider binding is established (running,
   * ready, or has already produced a turn). A pre-turn optimistic placeholder
   * row can carry a stale provider; when this is false the session's own
   * providerName is ignored in favor of input.providerName.
   */
  readonly sessionProviderEstablished?: boolean;
}): OrchestrationSession | null {
  // Starting is only a provisional pre-bind projection. Never regress a live,
  // established session on a follow-up or a queued steer: the provider's real
  // start/bind result will publish authoritative state if a restart is needed.
  if (
    input.currentSession?.status === "starting" ||
    input.currentSession?.status === "running" ||
    input.currentSession?.status === "ready"
  ) {
    return null;
  }

  // A queued intent can be delivered after a newer state change (or replayed
  // during recovery). Its timestamp is not permission to roll the session back.
  if (input.currentSession !== null) {
    const previousAt = Date.parse(input.currentSession.updatedAt);
    const requestedAt = Date.parse(input.requestedAt);
    if (Number.isFinite(previousAt) && Number.isFinite(requestedAt) && previousAt > requestedAt) {
      return null;
    }
  }

  const sessionProviderName =
    input.currentSession?.providerName != null && input.sessionProviderEstablished !== false
      ? input.currentSession.providerName
      : undefined;
  const sessionProviderInstanceId =
    input.currentSession?.providerInstanceId != null && input.sessionProviderEstablished !== false
      ? input.currentSession.providerInstanceId
      : input.providerInstanceId;

  return {
    threadId: input.threadId,
    status: "starting",
    providerName: sessionProviderName ?? input.providerName,
    ...(sessionProviderInstanceId !== undefined
      ? { providerInstanceId: sessionProviderInstanceId }
      : {}),
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
