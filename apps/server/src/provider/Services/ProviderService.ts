import type {
  ClaudeCacheObservation,
  ProviderBackgroundTaskInput,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderInterruptTurnInput,
  ProviderKind,
  ModelSelection,
  RuntimeMode,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStartOptions,
  ProviderSteerSubagentInput,
  ProviderStopSessionInput,
  ProviderStopTaskInput,
  ThreadId,
  TurnId,
  ProviderTurnStartResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";

export type ProviderRuntimeEventPumpStatus = "starting" | "healthy" | "recovering" | "degraded";

export interface ProviderRuntimeEventPumpHealth {
  readonly provider: ProviderKind;
  readonly status: ProviderRuntimeEventPumpStatus;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
  readonly lastEventAt?: string;
  readonly lastError?: string;
  readonly quarantinedEvents?: number;
  readonly lastQuarantinedEventId?: string;
  readonly lastQuarantinedAt?: string;
}

export interface ProviderSessionStartOutcome {
  readonly session: ProviderSession;
  readonly nativeResumeAttempted: boolean;
  readonly nativeResumeSucceeded: boolean;
  readonly priorTranscriptBootstrapPending: boolean;
}

export interface ProviderSessionStartOutcomeOptions {
  readonly registerPriorTranscriptBootstrapOnFreshStart?: boolean;
}

export interface ProviderServiceShape {
  readonly startClaudeCompaction?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
  readonly getClaudeCacheObservation?: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeCacheObservation | undefined, ProviderServiceError>;
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  readonly startSessionWithOutcome?: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    options?: ProviderSessionStartOutcomeOptions,
  ) => Effect.Effect<ProviderSessionStartOutcome, ProviderServiceError>;

  readonly completePriorTranscriptBootstrap?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly startReview: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly forkThread?: (
    input: ProviderForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult | null, ProviderServiceError>;

  readonly importExternalThread?: (input: {
    readonly threadId: ThreadId;
    readonly provider: "codex" | "claudeAgent";
    readonly externalThreadId: string;
    readonly sourceCwd: string;
    readonly cwd?: string;
    readonly modelSelection: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<ProviderForkThreadResult, ProviderServiceError>;

  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly stopTask: (input: ProviderStopTaskInput) => Effect.Effect<void, ProviderServiceError>;

  readonly backgroundTask: (
    input: ProviderBackgroundTaskInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly steerSubagent: (
    input: ProviderSteerSubagentInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  // stops only the live process/session — the persisted binding and resume cursor survive for a later restart
  readonly stopRuntimeSession?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  // restart-oriented recovery must check this before stopRuntimeSession — killing the shared subprocess silently terminates live native tasks
  readonly hasLiveRuntimeTasks?: (input: { readonly threadId: ThreadId }) => Effect.Effect<boolean>;

  readonly clearSessionResumeCursor?: (input: {
    readonly threadId: ThreadId;
    readonly preserveActiveRuntime?: boolean;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly compactThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly closeRuntimeEvents: Effect.Effect<void>;

  readonly getRuntimeEventPumpHealth?: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeEventPumpHealth>
  >;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  // events paired with their durable journal sequence — ingestion drains the accepted row without appending the event again
  readonly streamPersistedEvents?: Stream.Stream<PersistedProviderRuntimeEvent>;
}

export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "synara/provider/Services/ProviderService",
) {}
