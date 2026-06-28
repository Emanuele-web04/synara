/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderComposerCapabilities,
  ProviderApprovalDecision,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderInjectThreadItemsInput,
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
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

import type { JsonRpcLineTransport } from "../process/JsonRpcLineTransport.ts";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

/**
 * The agent-process spawn the provider adapter would have run locally, handed to
 * a {@link RemoteAgentTransportFactory} so the execution runtime can start it
 * inside a provisioned instance instead. Carries no environment: the target owns
 * the agent's environment (the sandbox's own shell, or — for the local-forward
 * fake — the host process env). Provider-specific env overrides are intentionally
 * out of scope until a provider actually needs them.
 */
export interface RemoteAgentSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/**
 * Starts the agent process inside a thread's provisioned remote runtime and
 * returns its line transport. The factory is bound to one thread+instance by the
 * orchestration layer, so the provider adapter stays runtime-agnostic: it only
 * describes the codex/agent spawn and receives a transport back, exactly as it
 * would from a local child process.
 *
 * Lifecycle contract: closing the returned transport MUST terminate the remote
 * agent process (not merely detach from it). Callers tear a session down by
 * closing its transport and rely on this to avoid orphaned sandbox processes.
 */
export type RemoteAgentTransportFactory = (
  spec: RemoteAgentSpawnSpec,
) => Promise<JsonRpcLineTransport>;

/**
 * Server-only session-start options that cannot ride the schema-validated
 * `ProviderSessionStartInput` (which is serializable contract data, so it drops
 * unknown fields and cannot carry a function). Passed as a separate argument
 * through `ProviderService.startSession` → adapter. Absent for local/worktree
 * threads, leaving the local spawn path unchanged.
 */
export interface ProviderSessionStartServerOptions {
  readonly remoteTransport?: RemoteAgentTransportFactory;
  readonly reviewProfile?: "review-chat";
}

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  readonly supportsSkillMentions?: boolean;
  readonly supportsSkillDiscovery?: boolean;
  readonly supportsNativeSlashCommandDiscovery?: boolean;
  readonly supportsPluginMentions?: boolean;
  readonly supportsPluginDiscovery?: boolean;
  readonly supportsRuntimeModelList?: boolean;
  readonly supportsTurnSteering?: boolean;
  /** True when `turn.diff.updated.payload.unifiedDiff` contains a parseable live patch. */
  readonly supportsLiveTurnDiffPatch?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
  readonly cwd?: string | null;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session. `serverOptions` carries server-only
   * capabilities (e.g. a remote transport factory for sandbox-backed threads)
   * that cannot travel on the serializable `input`. Adapters that do not support
   * remote runtimes ignore it and spawn locally.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
    serverOptions?: ProviderSessionStartServerOptions,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Redirect an active turn toward a new prompt when the provider supports it.
   */
  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Start a native provider review run when the adapter supports it.
   */
  readonly startReview?: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Append provider-native model-visible items to an already loaded thread
   * without starting a new user turn.
   */
  readonly injectThreadItems?: (
    input: ProviderInjectThreadItemsInput,
  ) => Effect.Effect<void, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadId?: string,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Read a persisted provider thread snapshot without requiring a local app thread binding.
   */
  readonly readExternalThread?: (input: {
    readonly externalThreadId: string;
    readonly cwd?: string;
  }) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Trigger provider-native context compaction for a thread when supported.
   */
  readonly compactThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Fork one provider thread into another persisted thread cursor when supported.
   *
   * Adapters may omit this to signal that the caller should fall back to
   * conversation-history-only forking.
   */
  readonly forkThread?: (
    input: ProviderForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * Read provider-specific composer capabilities.
   */
  readonly getComposerCapabilities?: () => Effect.Effect<ProviderComposerCapabilities, TError>;

  /**
   * List skills available for a given cwd.
   */
  readonly listSkills?: (
    input: ProviderListSkillsInput,
  ) => Effect.Effect<ProviderListSkillsResult, TError>;

  /**
   * List provider-native slash commands available for a given cwd.
   */
  readonly listCommands?: (
    input: ProviderListCommandsInput,
  ) => Effect.Effect<ProviderListCommandsResult, TError>;

  /**
   * List plugins available for the current provider/runtime.
   */
  readonly listPlugins?: (
    input: ProviderListPluginsInput,
  ) => Effect.Effect<ProviderListPluginsResult, TError>;

  /**
   * Read one plugin in detail from a marketplace entry.
   */
  readonly readPlugin?: (
    input: ProviderReadPluginInput,
  ) => Effect.Effect<ProviderReadPluginResult, TError>;

  /**
   * List models directly from the provider runtime when supported.
   */
  readonly listModels?: (
    input: ProviderListModelsInput,
  ) => Effect.Effect<ProviderListModelsResult, TError>;

  /**
   * List agents/subagents directly from the provider runtime when supported.
   */
  readonly listAgents?: (
    input: ProviderListAgentsInput,
  ) => Effect.Effect<ProviderListAgentsResult, TError>;

  /**
   * Transcribe one captured voice clip into plain text when supported.
   */
  readonly transcribeVoice?: (
    input: ServerVoiceTranscriptionInput,
  ) => Effect.Effect<ServerVoiceTranscriptionResult, TError>;
}
