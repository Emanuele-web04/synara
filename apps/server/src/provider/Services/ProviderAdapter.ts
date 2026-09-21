import type {
  ApprovalRequestId,
  ClaudeCacheObservation,
  ProviderComposerCapabilities,
  ProviderApprovalDecision,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderKind,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderListSkillsResult,
  ProviderListSkillsInput,
  ProviderStartReviewInput,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStartOptions,
  ServerVoicePrewarmInput,
  ServerVoicePrewarmResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@synara/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

// bounded per-adapter ingress: a slow durable consumer applies backpressure to the provider instead of growing the heap during a persistence outage
export const PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY = 2_048;

export interface ProviderSteerSubagentPayload {
  readonly input: string;
  readonly attachments?: ProviderSendTurnInput["attachments"];
  readonly skills?: ProviderSendTurnInput["skills"];
  readonly mentions?: ProviderSendTurnInput["mentions"];
}
export type ProviderConversationRollbackMode = "native" | "restart-session";

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Restart-session adapters cannot rewind provider history and must rebuild context locally. */
  readonly conversationRollback?: ProviderConversationRollbackMode;
  readonly supportsSkillMentions?: boolean;
  readonly supportsSkillDiscovery?: boolean;
  readonly supportsNativeSlashCommandDiscovery?: boolean;
  readonly supportsPluginMentions?: boolean;
  readonly supportsPluginDiscovery?: boolean;
  readonly supportsRuntimeModelList?: boolean;
  readonly supportsTurnSteering?: boolean;
  readonly supportsLiveTurnDiffPatch?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  readonly startedAt?: number | string;
  readonly completedAt?: number | string;
  readonly status?: string;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
  readonly cwd?: string | null;
}

export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  readonly didResumeSession?: (
    input: ProviderSessionStartInput,
    session: ProviderSession,
  ) => boolean;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly startReview?: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadId?: string,
  ) => Effect.Effect<void, TError>;

  readonly stopTask?: (threadId: ThreadId, taskId: string) => Effect.Effect<void, TError>;

  readonly backgroundTask?: (threadId: ThreadId, toolUseId: string) => Effect.Effect<void, TError>;

  readonly steerSubagent?: (
    threadId: ThreadId,
    providerThreadId: string,
    input: ProviderSteerSubagentPayload,
  ) => Effect.Effect<void, TError>;

  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  // idempotent cleanup barrier: an already-stopped/unknown thread is a successful no-op — used when the persisted binding can outlive the in-memory session
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly prepareSessionReplacement?: (input: ProviderSessionStartInput) => Effect.Effect<
    | {
        readonly previousSession: ProviderSession;
        readonly startSession: ProviderAdapterShape<TError>["startSession"];
      }
    | undefined,
    TError
  >;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly readExternalThread?: (input: {
    readonly externalThreadId: string;
    readonly cwd?: string;
    readonly providerOptions?: ProviderStartOptions;
  }) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly compactThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly startClaudeCompaction?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly getClaudeCacheObservation?: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeCacheObservation | undefined, TError>;

  readonly forkThread?: (
    input: ProviderForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult, TError>;

  readonly stopAll: () => Effect.Effect<void, TError>;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  readonly getComposerCapabilities?: () => Effect.Effect<ProviderComposerCapabilities, TError>;

  readonly listSkills?: (
    input: ProviderListSkillsInput,
  ) => Effect.Effect<ProviderListSkillsResult, TError>;

  readonly listCommands?: (
    input: ProviderListCommandsInput,
  ) => Effect.Effect<ProviderListCommandsResult, TError>;

  readonly listPlugins?: (
    input: ProviderListPluginsInput,
  ) => Effect.Effect<ProviderListPluginsResult, TError>;

  readonly readPlugin?: (
    input: ProviderReadPluginInput,
  ) => Effect.Effect<ProviderReadPluginResult, TError>;

  readonly listModels?: (
    input: ProviderListModelsInput,
  ) => Effect.Effect<ProviderListModelsResult, TError>;

  readonly listAgents?: (
    input: ProviderListAgentsInput,
  ) => Effect.Effect<ProviderListAgentsResult, TError>;

  readonly prewarmVoice?: (
    input: ServerVoicePrewarmInput,
  ) => Effect.Effect<ServerVoicePrewarmResult, TError>;

  readonly transcribeVoice?: (
    input: ServerVoiceTranscriptionInput,
  ) => Effect.Effect<ServerVoiceTranscriptionResult, TError>;
}
