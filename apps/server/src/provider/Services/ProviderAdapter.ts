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
  ProviderInstanceId,
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
import type { Deferred, Effect } from "effect";
import type { Stream } from "effect";

export function resolveProviderSessionInstanceId(
  input: Pick<ProviderSessionStartInput, "providerInstanceId" | "modelSelection">,
): ProviderInstanceId | undefined {
  return input.providerInstanceId ?? input.modelSelection?.instanceId;
}
import type { CodexGeneratedImageHomeCandidate } from "../../codexGeneratedImages.ts";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

// bounded per-adapter ingress: a slow durable consumer applies backpressure to the provider instead of growing the heap during a persistence outage
export const PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY = 2_048;

export interface ProviderSteerSubagentPayload {
  readonly input: string;
  readonly attachments?: ProviderSendTurnInput["attachments"];
  readonly skills?: ProviderSendTurnInput["skills"];
  readonly mentions?: ProviderSendTurnInput["mentions"];
}
/** Local preparation controls; never serialized into provider input or persisted history. */
export interface ProviderTurnDispatchOptions {
  readonly claudeCompactionCancellation?: Deferred.Deferred<void>;
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
  /**
   * The model and thinking level the provider session last ran with, when the
   * persisted session store records them (OMP JSONL `model_change` /
   * `thinking_level_change` rows). Lets an imported thread keep running the
   * model the source session actually used.
   */
  readonly lastUsedModel?: { readonly model: string; readonly thinkingLevel?: string };
}

export interface ProviderThreadHistoryPage extends ProviderThreadSnapshot {
  readonly nextCursor: string | null;
}

export interface ProviderGeneratedImageHomePathsInput {
  /** When present, live sessions outside this current settings scope are ignored. */
  readonly enabledProviderInstanceIds?: ReadonlySet<ProviderInstanceId>;
}

/** Server-internal launch guard; deliberately not part of the public contracts schema. */
export interface ProviderContinuationLaunchRequirements {
  readonly expectedCodexContinuationGeneration?: string;
}

export type ProviderAdapterSessionStartInput = ProviderSessionStartInput &
  ProviderContinuationLaunchRequirements;
export type ProviderAdapterForkThreadInput = ProviderForkThreadInput &
  ProviderContinuationLaunchRequirements;

export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  readonly startSession: (
    input: ProviderAdapterSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  readonly didResumeSession?: (
    input: ProviderSessionStartInput,
    session: ProviderSession,
  ) => boolean;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
    options?: ProviderTurnDispatchOptions,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
    options?: ProviderTurnDispatchOptions,
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

  /**
   * Renew retired tool authority after all native background work has settled.
   * True keeps the current session/generation; false requires full replacement.
   * The adapter must keep admission fenced until renewal is proven complete.
   */
  readonly renewAgentGatewayCredential?: (threadId: ThreadId) => Effect.Effect<boolean, TError>;

  /** Validate and retire before generation rotation; the returned start retains per-attempt preflight. */
  readonly prepareSessionReplacement?: (input: ProviderSessionStartInput) => Effect.Effect<
    | {
        readonly previousSession: ProviderSession;
        readonly startSession: ProviderAdapterShape<TError>["startSession"];
      }
    | undefined,
    TError
  >;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * List provider home roots that can contain generated image artifacts for live sessions.
   */
  readonly listGeneratedImageHomePaths?: (
    input?: ProviderGeneratedImageHomePathsInput,
  ) => Effect.Effect<ReadonlyArray<CodexGeneratedImageHomeCandidate>, TError>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly readExternalThread?: (input: {
    readonly externalThreadId: string;
    readonly cwd?: string;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly providerOptions?: ProviderStartOptions;
  }) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /** Display history only; never used to reconstruct native model context. */
  readonly readExternalThreadPage?: (input: {
    readonly externalThreadId: string;
    readonly cursor?: string;
    readonly cwd?: string;
    readonly providerOptions?: ProviderStartOptions;
    readonly providerInstanceId?: ProviderInstanceId;
  }) => Effect.Effect<ProviderThreadHistoryPage, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly compactThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly startClaudeCompaction?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    /** Request-owned cancellation remains valid before adapter discovery is registered. */
    readonly cancellation?: Deferred.Deferred<void>;
  }) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Cancel active local compaction preparation before prompt dispatch. */
  readonly cancelClaudeCompactionDiscovery?: (threadId: ThreadId) => Effect.Effect<void>;

  /** Read bounded native/local cache evidence without delivering a model prompt. */
  readonly getClaudeCacheObservation?: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeCacheObservation | undefined, TError>;

  readonly forkThread?: (
    input: ProviderAdapterForkThreadInput,
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
