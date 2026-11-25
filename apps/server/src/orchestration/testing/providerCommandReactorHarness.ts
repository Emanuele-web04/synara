// FILE: providerCommandReactorHarness.ts
// Purpose: Shared harness for the ProviderCommandReactor test files: the in-memory
//          reactor runtime (`createHarness`), its per-test cleanup, and the helpers
//          more than one of those files uses.
// Layer: Server test utility (imported by ProviderCommandReactor*.test.ts only; never by production code)
// Note: moved verbatim from ProviderCommandReactor.test.ts when that file was split
//       for parallel CI; call `useProviderCommandReactorHarness()` at the top of each
//       file's `describe("ProviderCommandReactor")` so cleanup is registered per file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClaudeCacheObservation,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  ProviderKind,
  ProviderForkThreadResult,
  ProviderRuntimeEvent,
  ProviderSession,
  ServerSettings,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import type { DeepPartial } from "@synara/shared/Struct";
import {
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  PubSub,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, vi } from "vitest";
import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "../../agentGateway/Services/AgentGatewayOperationRepository.ts";
import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionRegistryShape,
} from "../../agentGateway/Services/AgentGatewaySessionRegistry.ts";
import {
  ComputerService,
  type ComputerServiceShape,
} from "../../computer/Services/ComputerService.ts";
import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import {
  ProviderAdapterRequestError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import { AntigravityAdapter } from "../../provider/Services/AntigravityAdapter.ts";
import { ClaudeAdapter } from "../../provider/Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../../provider/Services/CodexAdapter.ts";
import { CursorAdapter } from "../../provider/Services/CursorAdapter.ts";
import { DevinAdapter } from "../../provider/Services/DevinAdapter.ts";
import { DroidAdapter } from "../../provider/Services/DroidAdapter.ts";
import { GrokAdapter } from "../../provider/Services/GrokAdapter.ts";
import { OmpAdapter } from "../../provider/Services/OmpAdapter.ts";
import { OpenCodeAdapter } from "../../provider/Services/OpenCodeAdapter.ts";
import { PiAdapter } from "../../provider/Services/PiAdapter.ts";
import { ProviderAdapterRegistryLive } from "../../provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderDiscoveryServiceLive } from "../../provider/Layers/ProviderDiscoveryService.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderHealth,
  type ProviderHealthShape,
} from "../../provider/Services/ProviderHealth.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { TurnCheckpointCoordinatorLive } from "../Layers/TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../Layers/ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { makeProviderCommandReactorLive } from "../Layers/ProviderCommandReactor.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { type OrchestrationDispatchError } from "../Errors.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
export const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
export const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

export function expiredCacheObservation(): ClaudeCacheObservation {
  return {
    nativeSessionId: "native-claude-session-1",
    lifecycleGeneration: "generation-1",
    model: "claude-opus-4-6",
    observedAt: new Date().toISOString(),
    contextTokens: 120_000,
    lastResponseAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    ttlSeconds: 3_600,
    state: "likely-expired",
    source: "request-usage",
  };
}

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return poll();
  };

  return poll();
}

// The real ProviderService over the real adapter registry, each driver a small
// fake. Like PiAdapter and AntigravityAdapter, a restart or a stop marks the
// context stopped before its teardown. The first teardown fails and keeps the
// context with the mode it was started in, a later one completes.
export function createRetainingRestartProviderServiceLayer(options?: {
  readonly failFirstTeardown?: boolean;
  readonly keepLiveOnFailedTeardown?: boolean;
  readonly liveTurns?: boolean;
  readonly failStart?: (
    input: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0],
  ) => boolean;
  readonly startResumeCursor?: (
    input: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0],
  ) => unknown;
  readonly serverSettings?: DeepPartial<ServerSettings>;
  readonly interruptFailure?: boolean;
  readonly onSendTurn?: (input: Parameters<ProviderServiceShape["sendTurn"]>[0]) => void;
}) {
  const unsupported = () => Effect.die(new Error("Unsupported adapter call in test"));
  const adapterFor = <P extends ProviderKind>(
    provider: P,
  ): ProviderAdapterShape<ProviderAdapterError> & { readonly provider: P } => {
    const sessions = new Map<ThreadId, ProviderSession>();
    const stopped = new Set<ThreadId>();
    const failedTeardowns = new Set<ThreadId>();
    const teardown = (threadId: ThreadId, method: string) =>
      Effect.suspend(() => {
        const session = sessions.get(threadId);
        if (session && !failedTeardowns.has(threadId) && options?.failFirstTeardown !== false) {
          failedTeardowns.add(threadId);
          if (!options?.keepLiveOnFailedTeardown) {
            stopped.add(threadId);
            sessions.set(threadId, { ...session, status: "closed" });
          }
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider,
              method,
              detail: "Failed to dispose previous session.",
            }),
          );
        }
        sessions.delete(threadId);
        stopped.delete(threadId);
        failedTeardowns.delete(threadId);
        return Effect.void;
      });
    return {
      provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input) =>
        Effect.suspend(() =>
          options?.failStart?.(input)
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider,
                  method: "session/start",
                  detail: "Synthetic startup rejected before query creation",
                }),
              )
            : teardown(input.threadId, "session/restart").pipe(
                Effect.map(() => {
                  const now = new Date().toISOString();
                  const resumeCursor = options?.startResumeCursor?.(input);
                  const session: ProviderSession = {
                    provider,
                    status: "ready",
                    runtimeMode: input.runtimeMode,
                    threadId: input.threadId,
                    ...(input.providerInstanceId
                      ? { providerInstanceId: input.providerInstanceId }
                      : {}),
                    ...(input.cwd ? { cwd: input.cwd } : {}),
                    ...(resumeCursor !== undefined ? { resumeCursor } : {}),
                    createdAt: now,
                    updatedAt: now,
                  };
                  sessions.set(input.threadId, session);
                  return session;
                }),
              ),
        ),
      sendTurn: (input) =>
        Effect.sync(() => {
          options?.onSendTurn?.(input);
          const turnId = asTurnId(`${provider}-turn`);
          const session = sessions.get(input.threadId);
          if (session && options?.liveTurns)
            sessions.set(input.threadId, { ...session, status: "running", activeTurnId: turnId });
          return { threadId: input.threadId, turnId };
        }),
      interruptTurn: () =>
        options?.interruptFailure
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider,
                method: "turn/interrupt",
                detail: "The Claude CLI did not acknowledge the interrupt within 10000ms.",
              }),
            )
          : Effect.void,
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: (threadId) => teardown(threadId, "session/stop"),
      listSessions: () => Effect.sync(() => Array.from(sessions.values())),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId) && !stopped.has(threadId)),
      ...(provider === "pi" || provider === "antigravity"
        ? { hasRetainedSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)) }
        : {}),
      readThread: () => unsupported(),
      rollbackThread: () => unsupported(),
      stopAll: () => Effect.void,
      streamEvents: Stream.never,
    };
  };
  const settingsLayer = Layer.unwrap(
    Effect.gen(function* () {
      const fixtureRoot = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-provider-"))),
        (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
      );
      const codexHomePath = path.join(fixtureRoot, "codex");
      fs.mkdirSync(codexHomePath);
      return ServerSettingsService.layerTest({
        ...options?.serverSettings,
        providerInstances: {
          ...options?.serverSettings?.providerInstances,
          codex: {
            driver: "codex",
            config: { homePath: codexHomePath },
            environment: [
              { name: "SYNARA_HOME", value: path.join(fixtureRoot, "runtime"), sensitive: false },
            ],
          },
        },
      });
    }),
  );
  const registryLayer = ProviderAdapterRegistryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CodexAdapter, adapterFor("codex")),
        Layer.succeed(ClaudeAdapter, {
          ...adapterFor("claudeAgent"),
          steerTurn: () => unsupported(),
          stopTask: () => unsupported(),
          backgroundTask: () => unsupported(),
          steerSubagent: () => unsupported(),
        }),
        Layer.succeed(CursorAdapter, adapterFor("cursor")),
        Layer.succeed(DevinAdapter, {
          ...adapterFor("devin"),
          stopTask: () => unsupported(),
          backgroundTask: () => unsupported(),
        }),
        Layer.succeed(AntigravityAdapter, adapterFor("antigravity")),
        Layer.succeed(GrokAdapter, adapterFor("grok")),
        Layer.succeed(DroidAdapter, adapterFor("droid")),
        Layer.succeed(OpenCodeAdapter, adapterFor("opencode")),
        Layer.succeed(OmpAdapter, adapterFor("omp")),
        Layer.succeed(PiAdapter, adapterFor("pi")),
        settingsLayer,
      ),
    ),
  );
  return makeProviderServiceLive().pipe(
    Layer.provide(registryLayer),
    Layer.provideMerge(
      ProviderSessionDirectoryLive.pipe(
        Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    ),
    Layer.provide(settingsLayer),
    Layer.provide(
      Layer.succeed(ServerSecretStore, {
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        remove: () => Effect.void,
      }),
    ),
  );
}

/**
 * Registers the per-file cleanup that used to sit at the top of
 * `describe("ProviderCommandReactor")` and returns the shared harness.
 * `setScope` mirrors the reactor scope that tests read and reset directly.
 */
export function useProviderCommandReactorHarness(options?: {
  readonly setScope?: (scope: Scope.Closeable | null) => void;
}) {
  const runtimes = new Set<{ dispose: () => Promise<void> }>();
  const scopes = new Set<Scope.Closeable>();
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const activeScope of scopes) {
      await Effect.runPromise(Scope.close(activeScope, Exit.void));
    }
    scopes.clear();
    options?.setScope?.(null);
    for (const runtime of runtimes) {
      await runtime.dispose();
    }
    runtimes.clear();
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly skillCatalogHomeDir?: string;
    readonly listNativeSkills?: ProviderAdapterShape<ProviderAdapterError>["listSkills"];
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly conversationRollback?: "native" | "restart-session";
    readonly checkpointStore?: Partial<CheckpointStoreShape>;
    readonly hubOutputReactor?: Partial<HubOutputReactorShape>;
    readonly forkThreadResult?: ProviderForkThreadResult | null;
    readonly startReactor?: boolean;
    readonly interruptTurn?: ProviderServiceShape["interruptTurn"];
    readonly commandEventTimeout?: Duration.Duration;
    readonly preTurnBaselineTimeout?: Duration.Duration;
    readonly cacheResponseTimeout?: Duration.Duration;
    readonly usageLimitBindingReadTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionWaitTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionNegativeCacheTtl?: Duration.Duration;
    readonly logMessages?: string[];
    readonly gatewayOperationId?: string;
    readonly gitWritingModelSelection?: ModelSelection;
    readonly omitStopRuntimeSession?: boolean;
    readonly serverSettings?: DeepPartial<ServerSettings>;
    readonly confirmNativeResume?: (resumeCursor: unknown) => boolean;
    readonly generateThreadTitle?: TextGenerationShape["generateThreadTitle"];
    readonly computerService?: ComputerServiceShape;
    readonly gatewaySessions?: AgentGatewaySessionRegistryShape;
    readonly getClaudeCacheObservation?: NonNullable<
      ProviderServiceShape["getClaudeCacheObservation"]
    >;
    readonly startClaudeCompaction?: NonNullable<ProviderServiceShape["startClaudeCompaction"]>;
    readonly coordinatorThreadIds?: readonly string[];
    readonly coordinatorConfigState?:
      | {
          readonly enabled?: boolean;
          readonly pausedAt?: string | null;
          readonly archivedAt?: string | null;
        }
      | undefined;
    readonly formatContextPacket?: string;
    readonly projectAdditionalFolders?: readonly string[];
    readonly getPersistedSessionProfile?: ProviderServiceShape["getPersistedSessionProfile"];
    readonly ingestRuntimeEvents?: boolean;
    readonly cancelClaudeCompactionDiscovery?: NonNullable<
      ProviderServiceShape["cancelClaudeCompactionDiscovery"]
    >;
    readonly providerServiceLayer?: Layer.Layer<ProviderService, unknown>;
    readonly listRetainedSessions?: NonNullable<ProviderServiceShape["listRetainedSessions"]>;
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const persistedResumeCursors = new Map<ThreadId, unknown>();
    // The provider that minted each persisted cursor: a cursor can only
    // natively resume a session on its own provider, so a cross-provider
    // restart that drops the input cursor must not pick it back up here.
    const persistedResumeCursorProviders = new Map<ThreadId, ProviderSession["provider"]>();
    const pendingPriorTranscriptBootstraps = new Set<ThreadId>();
    const runtimeLifecycleGenerations = new Map<ThreadId, string>();
    const listSessions = vi.fn<ProviderServiceShape["listSessions"]>(() =>
      Effect.succeed(runtimeSessions),
    );
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn<ProviderServiceShape["startSession"]>((_, input) => {
      const sessionIndex = nextSessionIndex++;
      const sessionModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? ((input as { modelSelection?: ModelSelection }).modelSelection ?? modelSelection)
          : modelSelection;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: sessionModelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(sessionModelSelection.model !== undefined
          ? { model: sessionModelSelection.model }
          : {}),
        threadId,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      runtimeLifecycleGenerations.set(threadId, `harness-session-${sessionIndex}`);
      return Effect.succeed(session);
    });
    const startSessionWithOutcome = vi.fn<
      NonNullable<ProviderServiceShape["startSessionWithOutcome"]>
    >((threadId, sessionInput, outcomeOptions) => {
      const persistedCursor =
        outcomeOptions?.startFreshForAccountHandoff !== true &&
        persistedResumeCursorProviders.get(threadId) === sessionInput.provider
          ? persistedResumeCursors.get(threadId)
          : undefined;
      const effectiveResumeCursor = sessionInput.resumeCursor ?? persistedCursor;
      const nativeResumeAttempted =
        effectiveResumeCursor !== undefined && effectiveResumeCursor !== null;
      const nativeResumeSucceeded =
        nativeResumeAttempted && (input?.confirmNativeResume?.(effectiveResumeCursor) ?? true);
      if (
        (outcomeOptions?.registerPriorTranscriptBootstrapOnFreshStart === true ||
          nativeResumeAttempted) &&
        !nativeResumeSucceeded
      ) {
        pendingPriorTranscriptBootstraps.add(threadId);
      }
      return startSession(threadId, sessionInput).pipe(
        Effect.map((session) => {
          const resolvedSession = nativeResumeSucceeded
            ? { ...session, resumeCursor: effectiveResumeCursor }
            : session;
          const runtimeIndex = runtimeSessions.findIndex(
            (candidate) => candidate.threadId === threadId,
          );
          if (runtimeIndex >= 0) {
            runtimeSessions[runtimeIndex] = resolvedSession;
          }
          persistedResumeCursors.set(threadId, resolvedSession.resumeCursor);
          persistedResumeCursorProviders.set(threadId, resolvedSession.provider);
          return {
            session: resolvedSession,
            nativeResumeAttempted,
            nativeResumeSucceeded,
            priorTranscriptBootstrapPending: pendingPriorTranscriptBootstraps.has(threadId),
          };
        }),
      );
    });
    const completePriorTranscriptBootstrap = vi.fn<
      NonNullable<ProviderServiceShape["completePriorTranscriptBootstrap"]>
    >(({ threadId, expectedLifecycleGeneration }) =>
      expectedLifecycleGeneration !== undefined &&
      runtimeLifecycleGenerations.get(threadId) !== expectedLifecycleGeneration
        ? Effect.fail(
            new ProviderValidationError({
              operation: "test.completePriorTranscriptBootstrap",
              issue: "The accepted turn belongs to a replaced provider generation.",
            }),
          )
        : Effect.sync(() => {
            pendingPriorTranscriptBootstraps.delete(threadId);
          }),
    );
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    // Mirrors adapter behavior: the reactor consults live provider sessions
    // (status + activeTurnId) to decide whether a turn is genuinely running.
    const setRuntimeSessionTurnState = (input: {
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly runtimeMode?: ProviderSession["runtimeMode"];
      readonly activeTurnId?: TurnId;
    }) => {
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      const base: ProviderSession = runtimeSessions[index] ?? {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        resumeCursor: { opaque: "resume-synthetic" },
        cwd: "/tmp/provider-project",
        createdAt: now,
        updatedAt: now,
      };
      const next: ProviderSession = {
        ...base,
        status: input.status,
        runtimeMode: input.runtimeMode ?? base.runtimeMode,
        ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
      };
      if (input.activeTurnId === undefined) {
        delete (next as { activeTurnId?: TurnId }).activeTurnId;
      }
      if (index >= 0) {
        runtimeSessions[index] = next;
      } else {
        runtimeSessions.push(next);
      }
    };
    const getRuntimeSessionStopTarget = vi.fn<
      NonNullable<ProviderServiceShape["getRuntimeSessionStopTarget"]>
    >(({ threadId }) =>
      listSessions().pipe(
        Effect.map((sessions) => ({
          session: sessions.find((session) => session.threadId === threadId) ?? null,
          lifecycleGeneration: runtimeLifecycleGenerations.get(threadId) ?? null,
        })),
      ),
    );
    const steerTurn = vi.fn<ProviderServiceShape["steerTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const startReview = vi.fn<ProviderServiceShape["startReview"]>((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId("turn-review-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>((forkInput) =>
      Effect.sync(() => {
        const result = input?.forkThreadResult ?? null;
        const forkModelSelection = forkInput.modelSelection ?? modelSelection;
        if (result && !runtimeSessions.some((session) => session.threadId === forkInput.threadId)) {
          runtimeSessions.push({
            provider: forkModelSelection.provider,
            status: "ready",
            runtimeMode: forkInput.runtimeMode,
            ...(forkModelSelection.model !== undefined ? { model: forkModelSelection.model } : {}),
            threadId: forkInput.threadId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        return result;
      }),
    );
    const interruptTurn = vi.fn(input?.interruptTurn ?? ((_: unknown) => Effect.void));
    const stopTask = vi.fn<ProviderServiceShape["stopTask"]>(() => Effect.void);
    const backgroundTask = vi.fn<ProviderServiceShape["backgroundTask"]>(() => Effect.void);
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(false),
    );
    const getSessionAdditionalDirectories = vi.fn<
      NonNullable<ProviderServiceShape["getSessionAdditionalDirectories"]>
    >(() => Effect.succeed(undefined));
    const steerSubagent = vi.fn<ProviderServiceShape["steerSubagent"]>(() => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
      () => Effect.void,
    );
    const restoreCheckpoint = vi.fn<CheckpointStoreShape["restoreCheckpoint"]>(() =>
      Effect.succeed(true),
    );
    const isGitRepository = vi.fn<CheckpointStoreShape["isGitRepository"]>(() =>
      Effect.succeed(false),
    );
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void);
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
      ...input?.checkpointStore,
    };
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
        persistedResumeCursors.delete(threadId);
        persistedResumeCursorProviders.delete(threadId);
        pendingPriorTranscriptBootstraps.delete(threadId);
      }),
    );
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      (input) =>
        Effect.sync(() => {
          const threadId =
            typeof input === "object" && input !== null && "threadId" in input
              ? (input as { threadId?: ThreadId }).threadId
              : undefined;
          if (!threadId) {
            return;
          }
          const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
          if (index >= 0) {
            runtimeSessions.splice(index, 1);
          }
        }),
    );
    const clearSessionResumeCursor = vi.fn<
      NonNullable<ProviderServiceShape["clearSessionResumeCursor"]>
    >((input) =>
      Effect.sync(() => {
        const preserveActiveRuntime =
          typeof input === "object" &&
          input !== null &&
          "preserveActiveRuntime" in input &&
          (input as { preserveActiveRuntime?: boolean }).preserveActiveRuntime === true;
        if (preserveActiveRuntime) {
          return;
        }
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        persistedResumeCursors.set(threadId, null);
        persistedResumeCursorProviders.delete(threadId);
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const publishBranch = vi.fn<GitCoreShape["publishBranch"]>(() => Effect.void);
    const mutationLock = await Effect.runPromise(Semaphore.make(1));
    const withMutation: GitCoreShape["withMutation"] = (_cwd, effect) =>
      mutationLock.withPermit(effect);
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(
      input?.generateThreadTitle ??
        (() =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "disabled in test harness",
            }),
          )),
    );
    const captureStudioOutputBaseline = vi.fn<HubOutputReactorShape["captureBaselineBeforeTurn"]>(
      input?.hubOutputReactor?.captureBaselineBeforeTurn ??
        (() => Effect.succeed({ status: "completed" as const })),
    );
    const cancelPendingStudioOutputBaseline = vi.fn<
      HubOutputReactorShape["cancelPendingTurnBaseline"]
    >(input?.hubOutputReactor?.cancelPendingTurnBaseline ?? (() => Effect.void));
    const hubOutputReactor: HubOutputReactorShape = {
      captureBaselineBeforeTurn: captureStudioOutputBaseline,
      cancelPendingTurnBaseline: cancelPendingStudioOutputBaseline,
      start: input?.hubOutputReactor?.start ?? Effect.void,
      drain: input?.hubOutputReactor?.drain ?? Effect.void,
    };

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview,
      forkThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      getSessionAdditionalDirectories,
      steerSubagent,
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      ...(input?.omitStopRuntimeSession
        ? {}
        : {
            stopRuntimeSession: stopRuntimeSession as NonNullable<
              ProviderServiceShape["stopRuntimeSession"]
            >,
          }),
      clearSessionResumeCursor,
      listSessions,
      getRuntimeSessionStopTarget,
      withRuntimeSessionStopTarget: (input, use) =>
        getRuntimeSessionStopTarget(input).pipe(Effect.flatMap(use)),
      ...(input?.listRetainedSessions ? { listRetainedSessions: input.listRetainedSessions } : {}),
      getPersistedSessionProfile:
        input?.getPersistedSessionProfile ?? (() => Effect.succeed(undefined)),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          ...(input?.conversationRollback
            ? { conversationRollback: input.conversationRollback }
            : {}),
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      ...(input?.getClaudeCacheObservation
        ? { getClaudeCacheObservation: input.getClaudeCacheObservation }
        : {}),
      ...(input?.startClaudeCompaction
        ? { startClaudeCompaction: input.startClaudeCompaction }
        : {}),
      ...(input?.cancelClaudeCompactionDiscovery
        ? { cancelClaudeCompactionDiscovery: input.cancelClaudeCompactionDiscovery }
        : {}),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const projectAgentLayer = Layer.succeed(ProjectAgentService, {
      formatContextPacketForTurn: () => Effect.succeed(input?.formatContextPacket ?? ""),
    } as unknown as (typeof ProjectAgentService)["Service"]);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      // Turn dispatch runs on the engine's fibers: the packet lookup reads
      // this environment, mirroring projectAgentServiceLayer provideMerge'd
      // into the reactor in serverLayers.ts.
      Layer.provideMerge(projectAgentLayer),
    );
    const projectAgentRepositoryLayer = Layer.succeed(ProjectAgentRepository, {
      getConfigByCoordinatorThread: (threadId: ThreadId) =>
        Effect.succeed(
          (input?.coordinatorThreadIds ?? []).includes(threadId)
            ? Option.some({
                projectId: asProjectId("project-1"),
                enabled: input?.coordinatorConfigState?.enabled ?? true,
                pausedAt: input?.coordinatorConfigState?.pausedAt ?? null,
                archivedAt: input?.coordinatorConfigState?.archivedAt ?? null,
              })
            : Option.none(),
        ),
    } as unknown as (typeof ProjectAgentRepository)["Service"]);
    const providerDiscoveryLayer = ProviderDiscoveryServiceLive.pipe(
      Layer.provide(
        Layer.succeed(ProviderAdapterRegistry, {
          getByProvider: () =>
            Effect.succeed({
              listSkills: input?.listNativeSkills,
            } as ProviderAdapterShape<ProviderAdapterError>),
          listProviders: () => Effect.succeed([]),
        }),
      ),
    );
    const reactorLayer = makeProviderCommandReactorLive(input).pipe(
      Layer.provide(providerDiscoveryLayer),
    );
    const layer = Layer.mergeAll(reactorLayer, ProviderRuntimeIngestionLive).pipe(
      Layer.provideMerge(projectAgentLayer),
      Layer.provideMerge(projectAgentRepositoryLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(input?.providerServiceLayer ?? Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        input?.computerService
          ? Layer.succeed(ComputerService, input.computerService)
          : Layer.empty,
      ),
      Layer.provideMerge(
        input?.gatewaySessions
          ? Layer.succeed(AgentGatewaySessionRegistry, input.gatewaySessions)
          : Layer.empty,
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderHealth, {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([]),
          updateProvider: () => Effect.die("updateProvider unsupported in test"),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape),
      ),
      Layer.provideMerge(Layer.succeed(HubOutputReactor, hubOutputReactor)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          renameBranch,
          publishBranch,
          withMutation,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          ...input?.serverSettings,
          ...(input?.gitWritingModelSelection
            ? { textGenerationModelSelection: input.gitWritingModelSelection }
            : {}),
        }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(
          process.cwd(),
          baseDir,
          input?.skillCatalogHomeDir ? { homeDir: input.skillCatalogHomeDir } : undefined,
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(AgentGatewayOperationRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.add(runtime);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(
        PubSub.publish(
          runtimeEventPubSub,
          // Adapters retain the lifecycle generation supplied at their start
          // and attach it to terminal events; the service publishes it intact.
          (event.type === "turn.completed" || event.type === "turn.aborted") &&
            event.lifecycleGeneration === undefined
            ? { ...event, lifecycleGeneration: runtimeLifecycleGenerations.get(event.threadId) }
            : event,
        ).pipe(Effect.asVoid),
      );

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    // Fault injection for command admission. The reactor resolves
    // `dispatch` off the shared engine service on every call, so swapping the
    // property here is observed by the reactor without rebuilding the layer.
    const engineDispatchTarget = engine as {
      dispatch: OrchestrationEngineShape["dispatch"];
    };
    const passthroughDispatch = engineDispatchTarget.dispatch;
    const interceptEngineDispatch = (
      interceptor: (
        command: OrchestrationCommand,
      ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError> | undefined,
    ) => {
      engineDispatchTarget.dispatch = (command, context) =>
        interceptor(command) ?? passthroughDispatch(command, context);
    };
    const projectionSnapshotQuery = await runtime.runPromise(
      Effect.service(ProjectionSnapshotQuery),
    );
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const checkpointCoordinator = await runtime.runPromise(
      Effect.service(TurnCheckpointCoordinator),
    );
    const serverSettings = await runtime.runPromise(Effect.service(ServerSettingsService));
    const deliveryRepository = await runtime.runPromise(
      Effect.service(OrchestrationEventDeliveryRepository),
    );
    const queuedTurnPromotionRepository = await runtime.runPromise(
      Effect.service(QueuedTurnPromotionRepository),
    );
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const managedAttachments = await runtime.runPromise(
      Effect.service(ManagedAttachmentRepository),
    );
    const pendingInteractionRepository = await runtime.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );
    const runtimeEventRepository = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository),
    );
    const gatewayOperations = await runtime.runPromise(
      Effect.service(AgentGatewayOperationRepository),
    );
    const harnessScope = await Effect.runPromise(Scope.make("sequential"));
    scopes.add(harnessScope);
    options?.setScope?.(harnessScope);
    if (input?.ingestRuntimeEvents) {
      const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(harnessScope)));
    }
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      const start = reactor.start.pipe(Scope.provide(harnessScope));
      await Effect.runPromise(
        input?.logMessages
          ? start.pipe(
              Effect.provide(
                Logger.layer(
                  [Logger.make(({ message }) => input.logMessages!.push(String(message)))],
                  { mergeWithExisting: false },
                ),
              ),
            )
          : start,
      );
      reactorStarted = true;
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);
    const restartReactor = async () => {
      await Effect.runPromise(Scope.close(harnessScope, Exit.void));
      const freshScope = await Effect.runPromise(Scope.make("sequential"));
      scopes.add(freshScope);
      const services = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.fresh(reactorLayer).pipe(
            Layer.provide(Layer.succeedServices(await runtime.services())),
          ),
          freshScope,
        ),
      );
      const fresh = ServiceMap.get(services, ProviderCommandReactor);
      return {
        reactor: fresh,
        start: () => Effect.runPromise(fresh.start.pipe(Scope.provide(freshScope))),
      };
    };

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        ...(input?.projectAdditionalFolders
          ? { additionalFolders: input.projectAdditionalFolders }
          : {}),
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        ...(input?.gatewayOperationId
          ? {
              creationSource: "synara_mcp" as const,
              gatewayOperationId: input.gatewayOperationId,
              gatewayOperationIndex: 0,
            }
          : {}),
        createdAt: now,
      }),
    );

    return {
      engine,
      runtime,
      realProviderService: await runtime.runPromise(Effect.service(ProviderService)),
      providerRuntimeRepository: Option.getOrUndefined(
        await runtime.runPromise(Effect.serviceOption(ProviderSessionRuntimeRepository)),
      ),
      projectionSnapshotQuery,
      seedCompletion: () =>
        runtime!.runPromise(sql`
        INSERT INTO agent_gateway_completions
          (child_thread_id, creator_thread_id, initial_message_id, result_json, delivery_state, created_at)
        VALUES ('delegated-child', 'thread-1', 'delegated-initial', '{"summary":"delegated result","childThreadId":"delegated-child"}', 'delivered', ${new Date().toISOString()})
      `),
      completionState: () =>
        runtime!.runPromise(sql<{
          context_consumed: number;
          context_event_sequence: number | null;
        }>`
        SELECT context_consumed, context_event_sequence FROM agent_gateway_completions WHERE child_thread_id = 'delegated-child'
      `),
      reactor,
      checkpointCoordinator,
      serverSettings,
      startSession,
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      pendingPriorTranscriptBootstraps,
      listSessions,
      sendTurn,
      steerTurn,
      startReview,
      forkThread,
      interruptTurn,
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      getSessionAdditionalDirectories,
      steerSubagent,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      getRuntimeSessionStopTarget,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      withMutation,
      generateBranchName,
      generateThreadTitle,
      captureStudioOutputBaseline,
      cancelPendingStudioOutputBaseline,
      stateDir,
      stageAttachment: async (
        attachment: {
          readonly type: "image" | "file";
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        },
        ownerThreadId = "thread-1",
      ) => {
        const flatRelativePath = attachmentRelativePath(attachment);
        const relativePath = attachment.id.startsWith("att_v2_")
          ? `objects/${attachment.id.slice(7, 9)}/${flatRelativePath}`
          : flatRelativePath;
        const attachmentPath = path.join(stateDir, "attachments", relativePath);
        fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
        if (!fs.existsSync(attachmentPath)) {
          fs.writeFileSync(attachmentPath, Buffer.alloc(attachment.sizeBytes));
        }
        const stagedAt = new Date().toISOString();
        await runtime.runPromise(
          managedAttachments
            .reserve({
              attachmentId: attachment.id,
              ownerThreadId,
              ownerKind: "local-loopback",
              ownerId: "local-loopback",
              kind: attachment.type,
              originalName: attachment.name,
              mimeType: attachment.mimeType,
              reservedBytes: attachment.sizeBytes,
              relativePath,
              now: stagedAt,
            })
            .pipe(
              Effect.andThen(
                managedAttachments.finalizeStaged({
                  attachmentId: attachment.id,
                  ownerThreadId,
                  ownerKind: "local-loopback",
                  ownerId: "local-loopback",
                  sizeBytes: attachment.sizeBytes,
                  sha256: "0".repeat(64),
                  stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                  now: stagedAt,
                }),
              ),
            ),
        );
        return attachmentPath;
      },
      drain,
      emitRuntimeEvent,
      setRuntimeSessionTurnState,
      startReactor,
      restartReactor,
      deliveryRepository,
      sql,
      pendingInteractionRepository,
      runtimeEventRepository,
      reserveGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.reserve({
            operationId,
            callerThreadId: "caller-thread",
            callerTurnId: "caller-turn",
            operationKind: "create_threads",
            requestId: `request-${operationId}`,
            fingerprint: `fingerprint-${operationId}`,
            requestedCount: 1,
            planJson: "[]",
            now,
          }),
        ),
      markGatewayOperationDispatching: (operationId: string) =>
        runtime.runPromise(gatewayOperations.markDispatching({ operationId, now })),
      completeGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.complete({
            operationId,
            resultJson: "{}",
            now: new Date().toISOString(),
          }),
        ),
      persistWithoutLivePublication: async (
        events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
      ) => {
        const persisted: OrchestrationEvent[] = [];
        for (const event of events) {
          const versions = await runtime.runPromise(sql<{ readonly version: number }>`
            SELECT COALESCE(MAX(stream_version), -1) + 1 AS version
            FROM orchestration_events
            WHERE aggregate_kind = ${event.aggregateKind}
              AND stream_id = ${event.aggregateId}
          `);
          const inserted = await runtime.runPromise(sql<{ readonly sequence: number }>`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${event.eventId}, ${event.aggregateKind}, ${event.aggregateId},
              ${versions[0]!.version}, ${event.type},
              ${event.occurredAt}, ${event.commandId}, ${event.causationEventId},
              ${event.correlationId}, 'user', ${JSON.stringify(event.payload)},
              ${JSON.stringify(event.metadata)}
            )
            RETURNING sequence
          `);
          const saved = { ...event, sequence: inserted[0]!.sequence } as OrchestrationEvent;
          persisted.push(saved);
          if (saved.type === "thread.message-sent") {
            await runtime.runPromise(sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, is_streaming,
                created_at, updated_at, source, sequence, dispatch_mode
              ) VALUES (
                ${saved.payload.messageId}, ${saved.payload.threadId}, ${saved.payload.turnId},
                ${saved.payload.role}, ${saved.payload.text},
                ${saved.payload.streaming ? 1 : 0}, ${saved.payload.createdAt},
                ${saved.payload.updatedAt}, ${saved.payload.source}, ${saved.sequence},
                ${saved.payload.dispatchMode ?? null}
              )
            `);
          }
        }
        return persisted;
      },
      persistSessionWithoutLivePublication: async (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly updatedAt: string;
      }) =>
        runtime.runPromise(sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, runtime_mode,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${input.threadId}, 'running', 'codex', 'approval-required',
            ${input.turnId}, NULL, ${input.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            status = excluded.status,
            provider_name = excluded.provider_name,
            runtime_mode = excluded.runtime_mode,
            active_turn_id = excluded.active_turn_id,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `),
      queuedTurnPromotionRepository,
      interceptEngineDispatch,
    };
  }

  async function seedRollbackTarget(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`cmd-import-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: input.messageId,
            role: "user",
            text: "rollback target",
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        createdAt: input.createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe(`cmd-assistant-complete-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe(`assistant-${input.messageId}`),
        turnId: input.turnId,
        createdAt: input.createdAt,
      }),
    );
  }

  async function readHarnessThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId = ThreadId.makeUnsafe("thread-1"),
  ) {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    return readModel.threads.find((thread) => thread.id === threadId);
  }

  async function startNativeChildTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    providerThreadId: string,
    provider: ProviderKind = "codex",
  ) {
    const threadId = ThreadId.makeUnsafe(`subagent:thread-1:${providerThreadId}`);
    const turnId = asTurnId(`turn-${providerThreadId}`);
    await harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: asEventId(`evt-start-${providerThreadId}`),
      provider,
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
      parentTurnId: asTurnId("turn-parent"),
      providerRefs: {
        providerThreadId,
        providerParentThreadId: "parent-provider-thread",
        providerTurnId: turnId,
        parentProviderTurnId: "turn-parent",
      },
      payload: {},
    });
    await waitFor(async () => {
      const thread = await readHarnessThread(harness, threadId);
      return (
        thread?.latestTurn?.state === "running" &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId
      );
    });
    return { threadId, turnId };
  }

  async function dispatchHarnessUserTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: string;
      readonly text: string;
      readonly createdAt: string;
      readonly commandId?: string;
      readonly threadId?: ThreadId;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly dispatchOrigin?: "user" | "automation" | "agent";
    },
  ) {
    return Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(input.commandId ?? `cmd-${input.messageId}`),
        threadId: input.threadId ?? ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId(input.messageId),
          role: "user",
          text: input.text,
          attachments: input.attachments ?? [],
        },
        ...(input.dispatchOrigin !== undefined ? { dispatchOrigin: input.dispatchOrigin } : {}),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: input.createdAt,
      }),
    );
  }

  async function setHarnessSession(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly commandId: string;
      readonly status:
        | "ready"
        | "running"
        | "error"
        | "stopped"
        | "starting"
        | "idle"
        | "interrupted";
      readonly at: string;
      readonly threadId?: ThreadId;
      readonly providerName?: string | null;
      readonly activeTurnId?: TurnId | null;
      readonly lastError?: string | null;
    },
  ) {
    const threadId = input.threadId ?? ThreadId.makeUnsafe("thread-1");
    return Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId,
        session: {
          threadId,
          status: input.status,
          providerName: input.providerName === undefined ? "codex" : input.providerName,
          runtimeMode: "approval-required",
          activeTurnId: input.activeTurnId ?? null,
          lastError: input.lastError ?? null,
          updatedAt: input.at,
        },
        createdAt: input.at,
      }),
    );
  }

  async function emitHarnessTurnTerminal(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly eventId: string;
      readonly provider: ProviderKind;
      readonly type: "completed" | "aborted" | "failed" | "cancelled";
      readonly threadId?: ThreadId;
      readonly turnId?: TurnId;
    },
  ) {
    const eventBase = {
      eventId: asEventId(input.eventId),
      provider: input.provider,
      threadId: input.threadId ?? ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: input.turnId ?? asTurnId("turn-1"),
      providerRefs: {},
    } as const;
    await harness.emitRuntimeEvent(
      input.type !== "aborted"
        ? ({
            ...eventBase,
            type: "turn.completed",
            payload: { state: input.type },
          } as ProviderRuntimeEvent)
        : ({
            ...eventBase,
            type: "turn.aborted",
            payload: { reason: "prompt rejected after asynchronous submission" },
          } as ProviderRuntimeEvent),
    );
  }

  // Sets up a thread with one live turn and one durably queued follow-up, then
  // returns the sequence of its `thread.turn-queued` event so the promotion row
  // can be inspected directly.
  async function seedQueuedTurnBehindLiveTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly liveTurnId: TurnId;
      readonly messageId: MessageId;
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    },
  ) {
    const now = new Date().toISOString();
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: input.liveTurnId,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`cmd-session-running-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: input.liveTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.sendTurn.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`cmd-turn-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: input.messageId,
          role: "user",
          text: input.text,
          attachments: [...(input.attachments ?? [])],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((collected) => Array.from(collected)),
      ),
    );
    const queuedEvent = events.find(
      (event) => event.type === "thread.turn-queued" && event.payload.messageId === input.messageId,
    );
    expect(queuedEvent).toBeDefined();
    return queuedEvent!.sequence;
  }

  const settleLiveTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: { readonly turnId: TurnId; readonly eventId: string },
  ) => {
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId(input.eventId),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: input.turnId,
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
  };

  return {
    runtimes,
    scopes,
    createdBaseDirs,
    createHarness,
    seedRollbackTarget,
    readHarnessThread,
    startNativeChildTurn,
    dispatchHarnessUserTurn,
    setHarnessSession,
    emitHarnessTurnTerminal,
    seedQueuedTurnBehindLiveTurn,
    settleLiveTurn,
  };
}
