/**
 * Shared ACP adapter core - the provider-contract implementation speaking the
 * Agent Client Protocol over stdio. `OmpAdapter` and `AcpAdapter` are thin
 * wrappers over {@link makeSharedAcpAdapter} that supply their provider's
 * spawn/auth runtime, model discovery, session import and user-facing strings.
 *
 * @module AcpAdapterCore
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderModelDescriptor,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PubSub,
  Random,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderAdapterShape,
  type ProviderThreadSnapshot,
  resolveProviderSessionInstanceId,
} from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "../acp/AcpSessionRuntime.ts";
import { findSelectConfig, flattenConfigOptions } from "../acp/AcpConfigOptions.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpDebugLoggers, makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyAcpAgentInteractionMode,
  acpInstanceCacheScope,
  parseConfiguredModelList,
  type AcpAgentBoundary,
  type AcpAgentRuntimeSettings,
} from "../acp/GenericAcpSupport.ts";
import { makeSessionTeardownGate } from "../acp/SessionTeardownGate.ts";
import { cancelTurnAndWait } from "../acp/TurnCancellation.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import type * as AcpErrors from "../acp/AcpErrors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { createLogger } from "../../logger.ts";

export const takeAcpSynaraHarnessPolicyTextPart = (
  provider: ProviderKind,
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider,
    scopedGatewayConnectionAvailable,
  });
const ACP_RESUME_VERSION = 1 as const;
const ACP_LOG_PAYLOAD_LIMIT = 4_000;
const ACP_RESUME_REPLAY_QUIET_MS = 350;
// Bounds how long startSession blocks on the replay settling; the background
// settle loop keeps suppression alive past this until the hard timeout.
const ACP_RESUME_REPLAY_MAX_WAIT_MS = 3_000;
const ACP_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
const ACP_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const ACP_TURN_SETTLE_DRAIN_POLL_MS = 25;
const ACP_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const ACP_NESTED_TASK_IDLE_TIMEOUT_MS = 60 * 60_000;
const ACP_CANCEL_GRACE_MS = 5_000;
const ACP_REQUEST_TIMEOUT_MS = 30_000;
const ACP_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const ACP_DISCOVERY_CACHE_MAX_ENTRIES = 16;

function acpRequestTimeoutError(
  provider: ProviderKind,
  method: string,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: `ACP agent did not respond to ${method} within ${ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

function isAcpDebugEnabled(debugEnvVar: string): boolean {
  return process.env[debugEnvVar] === "1";
}

export interface SharedAcpAdapterOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface SharedAcpSessionContext<S extends AcpAgentRuntimeSettings = AcpAgentRuntimeSettings> {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during the most recent turn, mapped to that
  // turn. A backlogged consumer can process a queued ToolCallUpdated after the
  // prompt response cleared activeTurnId; this keeps the event attributed to
  // its originating turn instead of dropping it as an orphan. Cleared when the
  // next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  // Most recently settled turn (prompt success or failure; never an interrupt
  // cancel). A notification can still be in flight in the runtime dispatcher
  // when the prompt response resolves and the settlement drain snapshots a
  // stale enqueued count; the arriving ContentDelta/AssistantItemCompleted
  // then finds activeTurnId cleared. Attributing it to the just-settled turn
  // mirrors the turnToolCallIds backdating above. Cleared on next dispatch.
  lastSettledTurnId: TurnId | undefined;
  // Assistant items with renderable content for the just-settled turn, so a
  // late AssistantItemCompleted keeps the normal with-content gate. Snapshotted
  // at settlement; late deltas add to it. Cleared on next dispatch.
  readonly lastSettledAssistantItemsWithContent: Set<string>;
  // The agent executes `Task` subagents outside the parent ACP event stream. Track
  // their parent tool rows so the watchdog can use a longer, still-finite cap.
  readonly activeNestedTaskToolCallIds: Set<string>;
  readonly nestedTaskLifecycleByToolCallId: Map<string, "active" | "completed">;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // Resolved spawn/config settings for this session's agent instance.
  readonly agentSettings: S;
  // Prompt content kinds the agent advertised in initialize
  // (image/audio/embeddedContext). Baseline ACP guarantees only text and
  // resource_link; richer blocks MUST be gated on these flags.
  readonly promptCapabilities: Acp.PromptCapabilities | undefined;
  // Pending until startSession has applied the requested model/effort config.
  // The session is registered in `sessions` before the config RPCs run (so
  // replay keeps draining), which means sendTurn can route to it mid-startup;
  // turns await this gate so the first prompt never runs with provider
  // defaults. Resolved by stopSessionInternal too, like resumeReplayReady, so
  // a failed startup never strands waiters.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  // Resolves only after the ACP scope and its child process have fully closed.
  // Recovery awaits this gate before starting a replacement session.
  readonly teardownComplete: Deferred.Deferred<void>;
  latestSessionCostUsd: number | undefined;
  // Count of ACP session/update events fully handled by the notification
  // consumer. Compared against acp.sessionUpdatesEnqueuedCount to detect when
  // events received before a prompt response have all been processed —
  // in-flight handlers and stream chunk buffering included.
  sessionUpdatesProcessed: number;
  // True while sendTurn is between its entry check and prompt dispatch; lets
  // interruptTurn flag a turn that has no prompt fiber to interrupt yet.
  turnStarting: boolean;
  // Set by interruptTurn when the turn is still starting; the prompt dispatch
  // guard honors it so a cancelled turn is never prompted.
  pendingTurnInterrupted: boolean;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The agent can close a stale assistant segment before any visible text arrives.
export function isRenderableAcpAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

// ACP gates image/audio/embedded-context blocks on `promptCapabilities`; a
// missing flag means the agent accepts only text + resource_link. Unsupported
// images degrade to their on-disk path inside the file-attachments block.
export function resolveAcpPromptImageMode(
  promptCapabilities: Acp.PromptCapabilities | undefined,
): "blocks" | "path-references" {
  return promptCapabilities?.image === true ? "blocks" : "path-references";
}

// Identifies the agent's parent `Task` tool row; child-session progress is not
// forwarded over ACP, so this marker is the only reliable liveness signal.
export function isAcpNestedTaskToolCall(toolCall: AcpToolCallState): boolean {
  if (toolCall.title?.trim().toLowerCase() === "task") {
    return true;
  }
  const rawInput = toolCall.data.rawInput;
  return (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "subagent_type" in rawInput &&
    typeof rawInput.subagent_type === "string"
  );
}

// A turn-specific stop is valid only while that exact turn is active. During
// startup no caller can know the new provider turn id yet, so a supplied id is stale.
export function shouldIgnoreAcpInterrupt(
  requestedTurnId: TurnId | undefined,
  activeTurnId: TurnId | undefined,
): boolean {
  return requestedTurnId !== undefined && requestedTurnId !== activeTurnId;
}

// The agent may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
function parseAcpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function resolveAcpAgentSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
  sessionCwd?: string,
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    sessionCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

function setAcpDiscoveryCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > ACP_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

type SharedAcpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

/**
 * Runtime creation input handed to {@link SharedAcpAdapterHooks.makeRuntime}.
 * Extends the shared ACP session runtime options minus the fields the hooks
 * themselves resolve (spawn, auth resolution).
 */
export interface SharedAcpRuntimeInput<S extends AcpAgentRuntimeSettings> extends Omit<
  AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resolveAuthMethodId"
> {
  readonly settings: S;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

/**
 * The provider-specific pieces the shared ACP adapter core needs. The generic
 * `acp` adapter and `OmpAdapter` differ only in these hooks; everything else
 * (session lifecycle, turn pump, cancellation, resume replay, watch
dog) is shared.
 */
export interface SharedAcpAdapterHooks<S extends AcpAgentRuntimeSettings> {
  /** Provider kind reported on sessions, errors and runtime events. */
  readonly provider: ProviderKind;
  /** Display name interpolated into user-facing details ("Omp", "ACP agent"). */
  readonly agentDisplayName: string;
  /** Instance id that keeps the ambient account (others run isolated). */
  readonly defaultInstanceId: string;
  /** Env var enabling the raw ACP transport debug log. */
  readonly debugEnvVar: string;
  /** Marker written into transport debug log records. */
  readonly transportDebugMarker: string;
  /** Prefix for structured log events ("omp.acp", "acp.agent"). */
  readonly logPrefix: string;
  /** Env var overriding the turn idle timeout. */
  readonly idleTimeoutEnvVar: string;
  /** Prompt prefix prepended while plan mode is active. */
  readonly planModePromptPrefix: string;
  /**
   * When true, prompt image blocks are sent only if the agent advertised
   * `promptCapabilities.image` (generic ACP agents). When false, image blocks
   * are always sent (OMP advertises image support).
   */
  readonly gateImagesOnPromptCapabilities: boolean;
  /** Whether external thread import is advertised in composer capabilities. */
  readonly supportsThreadImport: boolean;
  /** Reads the reasoning effort out of a model selection's options record. */
  readonly effortFromModelOptions: (options: unknown) => string | undefined;
  /** Maps the provider's start/discovery providerOptions to settings fields. */
  readonly settingsFromProviderOptions: (
    providerOptions: ProviderStartOptions | undefined,
  ) => Partial<S>;
  /** Maps a listModels/listCommands discovery input to settings fields. */
  readonly settingsFromDiscoveryInput: (input: unknown) => Partial<S>;
  /** Last pass over merged settings before spawn/discovery. */
  readonly finalizeSettings: (merged: S) => S;
  /** Extra log-safe fields folded into the discovery cache key. */
  readonly discoveryCacheFields: (settings: S) => ReadonlyArray<unknown>;
  /** Builds the ACP runtime; where spawn, auth and env semantics live. */
  readonly makeRuntime: (
    input: SharedAcpRuntimeInput<S>,
  ) => Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope>;
  /** Applies a model + reasoning effort selection over ACP session config. */
  readonly applyModelSelection: <E>(input: {
    readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
    readonly model: string;
    readonly thinkingLevel?: string | null | undefined;
    readonly modelConfigId?: string;
    readonly effortConfigId?: string;
    readonly mapError: (context: {
      cause: AcpErrors.AcpError;
      method: "session/set_config_option" | "session/get_config_options";
    }) => E;
  }) => Effect.Effect<void, E>;
  /**
   * Optional provider-specific model catalog discovery (OMP's `models --json`
   * CLI). When absent the core falls back to in-band ACP config options merged
   * with the instance's configured model catalog.
   */
  readonly discoverModels?: (input: {
    readonly settings: S;
    readonly boundary: AcpAgentBoundary;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly homeDir: string;
  }) => Effect.Effect<ProviderListModelsResult, ProviderAdapterRequestError>;
  /** Optional native session-store reader (OMP's agentDir JSONL store). */
  readonly readExternalThread?: (
    input: Parameters<NonNullable<SharedAcpAdapterShape["readExternalThread"]>>[0],
    resolveMergedSettings: (
      providerOptions: ProviderStartOptions | undefined,
      providerInstanceId: string | undefined,
    ) => S,
  ) => Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError>;
}

export function makeSharedAcpAdapter<S extends AcpAgentRuntimeSettings>(
  agentSettings: S,
  hooks: SharedAcpAdapterHooks<S>,
  options?: SharedAcpAdapterOptions,
) {
  return Effect.gen(function* () {
    const PROVIDER = hooks.provider;
    const log = createLogger(PROVIDER);
    const logPrefix = hooks.logPrefix;
    const debugEnvVar = hooks.debugEnvVar;
    const agentDisplayName = hooks.agentDisplayName;
    // Backstop for an alive-but-silent agent child: if a turn produces no ACP
    // activity for this long, force-fail it instead of showing "Working"
    // forever. Generous by design so legitimate long, quiet tool runs are not
    // killed; override with hooks.idleTimeoutEnvVar when a workload needs longer.
    const TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
      envVar: hooks.idleTimeoutEnvVar,
      defaultMs: 600_000,
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, SharedAcpSessionContext<S>>();
    const sessionTeardownGate = makeSessionTeardownGate();
    const modelDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListModelsResult }
    >();
    const commandDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListCommandsResult }
    >();
    const withThreadLock = yield* makeAcpThreadLock();
    const discoveryLock = yield* Semaphore.make(1);
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

    // One ACP agent account per provider instance: a selected environment or a
    // non-default instance runs under its own synthetic HOME.
    const acpBoundary = (input: {
      readonly instanceId?: string | undefined;
      readonly environment?: Readonly<Record<string, string>> | undefined;
    }): AcpAgentBoundary => ({
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
      homeDir: serverConfig.homeDir,
      isolationRootDir: serverConfig.stateDir,
    });
    const mergeSettings = (input: Partial<S>): S =>
      hooks.finalizeSettings({ ...agentSettings, ...input });
    // Merged spawn/config settings for a live session: base settings, the
    // provider's start options, then the account boundary.
    const resolveSessionSettings = (
      providerOptions: ProviderStartOptions | undefined,
      providerInstanceId: string | undefined,
    ): S => {
      const fromOptions = hooks.settingsFromProviderOptions(providerOptions);
      return hooks.finalizeSettings({
        ...agentSettings,
        ...fromOptions,
        ...acpBoundary({
          environment: fromOptions.environment,
          instanceId: providerInstanceId,
        }),
      });
    };
    // Discovery sessions are disposable and never enter the live session directory.
    const makeDiscoveryRuntime = (input: {
      readonly settings: S;
      readonly cwd: string;
      readonly clientName: string;
    }) =>
      hooks.makeRuntime({
        settings: input.settings,
        childProcessSpawner,
        cwd: input.cwd,
        clientInfo: { name: input.clientName, version: "0.0.0" },
      });
    // Generic ACP agents have no shared CLI catalog convention. The model
    // list merges the instance's configured catalog with the in-band ACP
    // `model` config option, which multiplexing agents (omp, opencode, ...)
    // advertise with one entry per upstream model.
    const runInBandModelDiscovery = (
      settings: S,
    ): Effect.Effect<ProviderListModelsResult, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const effective = settings;
        const configured = parseConfiguredModelList(effective.models);
        const discovered: ProviderModelDescriptor[] = [];
        const runtime = yield* makeDiscoveryRuntime({
          settings: effective,
          cwd: serverConfig.homeDir,
          clientName: `${PROVIDER}-model-discovery`,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "ACP agent model discovery failed unexpectedly.",
              }),
          ),
        );
        // Config options (including the model selector) only exist after the
        // initialize/session-new handshake populates the runtime state.
        yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/new",
                detail:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "ACP agent model discovery failed unexpectedly.",
              }),
          ),
        );
        const configOptions = yield* runtime.getConfigOptions.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/get_config_options",
                detail:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "ACP agent model discovery failed unexpectedly.",
              }),
          ),
        );
        const modelConfig = findSelectConfig(configOptions, {
          id: effective.modelConfigId?.trim() || "model",
          category: "model",
        });
        for (const option of modelConfig ? flattenConfigOptions(modelConfig.options) : []) {
          if (!discovered.some((entry) => entry.slug === option.value)) {
            discovered.push({
              slug: option.value,
              name: option.name?.trim() || option.value,
            });
          }
        }
        const seen = new Set(discovered.map((entry) => entry.slug));
        const models = [...discovered, ...configured.filter((entry) => !seen.has(entry.slug))];
        if (models.length === 0) {
          log.warn("model/list empty", { command: effective.command });
        }
        return {
          models,
          source: discovered.length > 0 ? "acp-agent" : "acp-config",
          cached: false,
        } satisfies ProviderListModelsResult;
      }).pipe(Effect.scoped);

    const discoverModels = (
      settings: S,
      boundary: AcpAgentBoundary,
    ): Effect.Effect<ProviderListModelsResult, ProviderAdapterRequestError> =>
      hooks.discoverModels !== undefined
        ? hooks.discoverModels({
            settings,
            boundary,
            childProcessSpawner,
            homeDir: serverConfig.homeDir,
          })
        : runInBandModelDiscovery(settings);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: SharedAcpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        if (!acceptAcpPlanUpdate(ctx, payload)) return;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const emitNestedTaskLifecycle = (
      ctx: SharedAcpSessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        if (!isAcpNestedTaskToolCall(toolCall)) {
          return;
        }
        const previous = ctx.nestedTaskLifecycleByToolCallId.get(toolCall.toolCallId);
        const terminal = toolCall.status === "completed" || toolCall.status === "failed";
        if (terminal) {
          ctx.activeNestedTaskToolCallIds.delete(toolCall.toolCallId);
          if (previous === "completed") {
            return;
          }
          ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "completed");
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
              status: toolCall.status === "failed" ? "failed" : "completed",
              ...(toolCall.detail ? { summary: toolCall.detail } : {}),
            },
          });
          return;
        }

        ctx.activeNestedTaskToolCallIds.add(toolCall.toolCallId);
        if (previous !== undefined) {
          return;
        }
        ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "active");
        const rawInput = toolCall.data.rawInput;
        const description =
          typeof rawInput === "object" &&
          rawInput !== null &&
          "description" in rawInput &&
          typeof rawInput.description === "string"
            ? rawInput.description
            : toolCall.detail;
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "task.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
            taskType: "subagent",
            ...(description ? { description } : {}),
          },
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SharedAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: SharedAcpSessionContext,
      options?: {
        readonly exitKind?: "graceful" | "error";
        readonly reason?: string;
        readonly awaitTermination?: boolean;
      },
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!ctx.stopped) {
            ctx.stopped = true;
            yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
            ctx.gatewaySessionLease?.release();
            sessionTeardownGate.track(ctx.threadId, ctx.teardownComplete);
            if (sessions.get(ctx.threadId) === ctx) {
              sessions.delete(ctx.threadId);
            }
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            if (ctx.sessionConfigReady !== undefined) {
              yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
              ctx.sessionConfigReady = undefined;
            }
            if (ctx.resumeReplayReady !== undefined) {
              yield* Deferred.succeed(ctx.resumeReplayReady, undefined);
              ctx.resumeReplayReady = undefined;
              ctx.resumeReplayLastSuppressedAt = undefined;
            }
            if (ctx.notificationFiber) {
              yield* Fiber.interrupt(ctx.notificationFiber);
            }

            const completeTeardown = sessionTeardownGate.complete(
              ctx.threadId,
              ctx.teardownComplete,
            );
            const teardown = Effect.gen(function* () {
              yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "session.exited",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: {
                  exitKind: options?.exitKind ?? "graceful",
                  ...(options?.reason ? { reason: options.reason } : {}),
                },
              });
            }).pipe(Effect.ensuring(completeTeardown));

            // Scope.close interrupts prompt/watchdog fibers owned by this scope.
            // A daemon performs the close so those fibers can initiate teardown
            // without waiting on their own termination.
            yield* teardown.pipe(Effect.forkDetach, Effect.asVoid);
          }

          if (options?.awaitTermination !== false) {
            yield* restore(Deferred.await(ctx.teardownComplete));
          }
        }),
      );

    const noteSuppressedRuntimeEvent = (
      ctx: SharedAcpSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isAcpDebugEnabled(debugEnvVar)) {
          return;
        }
        yield* Effect.logInfo(`${logPrefix}.runtime_event_suppressed`, {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const cancelPromptWithGrace = (
      ctx: SharedAcpSessionContext,
      promptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        const result = yield* cancelTurnAndWait({
          cancel: ctx.acp.cancel,
          promptFiber,
          graceMs: ACP_CANCEL_GRACE_MS,
        });
        if (result.cancelRequest !== "sent" || result.prompt === "timedOut") {
          yield* Effect.logWarning(`${logPrefix}.cancel_escalated`, {
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            cancelRequest: result.cancelRequest,
            prompt: result.prompt,
            ...(result.cancelFailure ? { reason: result.cancelFailure } : {}),
          });
        }
        return result;
      });

    const activeTurnIdForRuntimeEvent = (ctx: SharedAcpSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    // Holds the active-turn window open until session/update events that were
    // already enqueued when the prompt response resolved have been fully
    // handled by the notification consumer, so they settle with their turn
    // attribution (and recorded failed-tool detail) intact. Snapshotting the
    // runtime's enqueued count and waiting for the adapter's processed count
    // to catch up is immune to stream chunk buffering and in-flight handlers,
    // unlike a queue-size probe. The snapshot alone is not enough: a
    // notification can still be in flight in the runtime dispatcher (parsed
    // but not yet enqueued) when first sampled, so after reaching the target
    // one more quiet poll re-snapshots; a grown count keeps draining. Bounded
    // so a chatty stream cannot stall settlement past the cap. Costs one
    // quiet poll (~25ms) even on the fast path, so a straggler notification
    // in flight during the first snapshot is observed instead of orphaned.
    const waitForQueuedTurnEventsDrained = (ctx: SharedAcpSessionContext) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        let target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        while (Date.now() - startedAt < ACP_TURN_SETTLE_DRAIN_MAX_WAIT_MS) {
          while (
            ctx.sessionUpdatesProcessed < target &&
            Date.now() - startedAt < ACP_TURN_SETTLE_DRAIN_MAX_WAIT_MS
          ) {
            yield* Effect.sleep(ACP_TURN_SETTLE_DRAIN_POLL_MS);
          }
          yield* Effect.sleep(ACP_TURN_SETTLE_DRAIN_POLL_MS);
          const resampled = yield* ctx.acp.sessionUpdatesEnqueuedCount;
          if (resampled <= target && ctx.sessionUpdatesProcessed >= target) {
            return;
          }
          target = Math.max(target, resampled);
        }
      });

    // On session/load, the agent can replay old ACP updates after the session is "ready".
    // Keep suppression active until that stream actually goes quiet — clearing it
    // on a fixed timeout lets late historical deltas leak into the first turn as
    // its content. The hard cap only guards against a replay that never settles.
    const settleResumeReplayWhenQuiet = (ctx: SharedAcpSessionContext) =>
      Effect.gen(function* () {
        const ready = ctx.resumeReplayReady;
        if (ready === undefined) {
          return;
        }
        const startedAt = Date.now();
        ctx.resumeReplayLastSuppressedAt = startedAt;
        while (ctx.resumeReplayReady !== undefined) {
          const now = Date.now();
          const lastSuppressedAt = ctx.resumeReplayLastSuppressedAt ?? startedAt;
          const quietForMs = now - lastSuppressedAt;
          const elapsedMs = now - startedAt;
          if (
            quietForMs >= ACP_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= ACP_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= ACP_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning(`${logPrefix}.resume_replay_quiet_wait_timeout`, {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(ACP_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
      });

    const startSession: SharedAcpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          yield* sessionTeardownGate.awaitPending(input.threadId);
          const cwd = resolveAcpAgentSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const agentModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
            input,
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: SharedAcpSessionContext<S>;

          const resumeSessionId = parseAcpResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isAcpDebugEnabled(debugEnvVar),
            provider: PROVIDER,
            marker: hooks.transportDebugMarker,
            payloadLimit: ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: () => false,
          });
          const providerInstanceId = resolveProviderSessionInstanceId(input);
          const effectiveAgentSettings = resolveSessionSettings(
            input.providerOptions,
            providerInstanceId,
          );

          yield* Effect.logInfo(`${logPrefix}.start`, {
            marker: hooks.transportDebugMarker,
            debugEnv: debugEnvVar,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            command: effectiveAgentSettings.command ?? null,
          });

          const acp = yield* hooks
            .makeRuntime({
              settings: effectiveAgentSettings,
              childProcessSpawner,
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientCapabilities: { elicitation: { form: {} } },
              clientInfo: { name: "Synara", version: "0.0.0" },
              ...(agentGatewayCredentials
                ? {
                    buildMcpServers: (initializeResult: Acp.InitializeResponse) =>
                      buildAcpSynaraMcpServers({
                        connection: gatewaySessionLease!.connection,
                        initializeResult,
                        stdioProxy: agentGatewayCredentials.stdioProxy,
                      }),
                  }
                : {}),
              ...acpRuntimeLoggers,
            })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
              ),
            );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  if (policyOutcome.outcome === "selected") {
                    if (isAcpDebugEnabled(debugEnvVar)) {
                      yield* Effect.logInfo(`${logPrefix}.permission_policy_applied`, {
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        interactionMode: ctx?.activeInteractionMode,
                        optionId: policyOutcome.optionId,
                        options: params.options.map((option) => ({
                          kind: option.kind,
                          optionId: option.optionId,
                        })),
                        toolKind: params.toolCall.kind,
                        toolTitle: params.toolCall.title,
                      });
                    }
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: policyOutcome.optionId,
                      },
                    };
                  }
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (!isFormElicitationRequest(params)) {
                  return { action: "decline" as const };
                }
                const questions = elicitationQuestionsFromRequest(params);
                if (questions.length === 0) {
                  return { action: "decline" as const };
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return elicitationResponseFromAnswers(params, resolved);
              }),
            );
            const startedOption = yield* acp
              .start()
              .pipe(Effect.timeoutOption(ACP_REQUEST_TIMEOUT_MS));
            return yield* Option.match(startedOption, {
              onNone: () => Effect.fail(acpRequestTimeoutError(PROVIDER, "session/start")),
              onSome: Effect.succeed,
            });
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ProviderAdapterRequestError
                ? error
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail: `${agentDisplayName} could not resume the requested native session. Synara refused the fresh fallback to avoid silently losing conversation context.`,
            });
          }

          // `session/resume` does not replay history; only legacy `session/load`
          // needs the replay-suppression gate below.
          const resumeReplayReady =
            started.sessionSetupMethod === "load" ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const teardownComplete = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: agentModelSelection?.model,
            threadId: input.threadId,
            ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
            resumeCursor: {
              schemaVersion: ACP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            lastSettledTurnId: undefined,
            lastSettledAssistantItemsWithContent: new Set(),
            activeNestedTaskToolCallIds: new Set(),
            nestedTaskLifecycleByToolCallId: new Map(),
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady !== undefined ? Date.now() : undefined,
            agentSettings: effectiveAgentSettings,
            promptCapabilities: started.initializeResult.agentCapabilities?.promptCapabilities,
            sessionConfigReady,
            teardownComplete,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            turnStarting: false,
            pendingTurnInterrupted: false,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Only real turn progress resets the idle watchdog; mode,
                // config, and usage updates must not keep a finished or
                // wedged prompt alive forever.
                if (isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                }
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    {
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      // A completion queued behind the prompt response belongs to
                      // the just-settled turn; emit it there so a late delta is
                      // still closed instead of dropped as an orphan. Mirrors the
                      // ToolCallUpdated backdating below.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.lastSettledTurnId
                          : undefined;
                      if (lateTurnId !== undefined) {
                        const lateScopedItemId = scopeAcpRuntimeItemIdForTurn(
                          PROVIDER,
                          lateTurnId,
                          event.itemId,
                        );
                        if (!ctx.lastSettledAssistantItemsWithContent.has(lateScopedItemId)) {
                          if (isAcpDebugEnabled(debugEnvVar)) {
                            yield* Effect.logInfo(`${logPrefix}.empty_assistant_item_suppressed`, {
                              threadId: ctx.threadId,
                              turnId: lateTurnId,
                              itemId: lateScopedItemId,
                            });
                          }
                          return;
                        }
                        ctx.lastSettledAssistantItemsWithContent.delete(lateScopedItemId);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpAssistantItemEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            itemId: lateScopedItemId,
                            lifecycle: "item.completed",
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeAcpRuntimeItemIdForTurn(
                        PROVIDER,
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isAcpDebugEnabled(debugEnvVar)) {
                          yield* Effect.logInfo(`${logPrefix}.empty_assistant_item_suppressed`, {
                            threadId: ctx.threadId,
                            turnId: activeTurnId,
                            itemId: scopedItemId,
                          });
                        }
                        return;
                      }
                      ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: scopedItemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;
                  case "PlanUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;
                  case "ToolCallUpdated":
                    {
                      // A queued update for a tool call the just-settled turn
                      // already rendered belongs to that turn; emit it with the
                      // originating turn id so the existing tool row resolves in
                      // place instead of being dropped as an orphan. Resume
                      // replay stays suppressed like every other event.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* emitNestedTaskLifecycle(ctx, event.toolCall, lateTurnId);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeAcpToolCallStateForTurn(
                              PROVIDER,
                              lateTurnId,
                              event.toolCall,
                            ),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitNestedTaskLifecycle(ctx, event.toolCall, activeTurnId);
                      const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                      if (failedToolDetail !== undefined) {
                        ctx.activeTurnFailedToolDetail = failedToolDetail;
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          toolCall: scopeAcpToolCallStateForTurn(
                            PROVIDER,
                            activeTurnId,
                            event.toolCall,
                          ),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "ContentDelta":
                    {
                      // The turn's sole chunk can still be in flight when the
                      // prompt promise resolves and the settlement drain sampled
                      // a stale count; attribute the straggler to the
                      // just-settled turn so the assistant text is not lost.
                      // Mirrors the ToolCallUpdated backdating above.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.lastSettledTurnId
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        const lateScopedItemId = event.itemId
                          ? scopeAcpRuntimeItemIdForTurn(PROVIDER, lateTurnId, event.itemId)
                          : undefined;
                        if (isRenderableAcpAssistantDelta(event)) {
                          if (lateScopedItemId !== undefined) {
                            ctx.lastSettledAssistantItemsWithContent.add(lateScopedItemId);
                          }
                        }
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpContentDeltaEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            ...(lateScopedItemId ? { itemId: lateScopedItemId } : {}),
                            text: event.text,
                            ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeAcpRuntimeItemIdForTurn(PROVIDER, activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableAcpAssistantDelta(event)) {
                        ctx.activeTurnHadAssistantContent = true;
                        if (scopedItemId !== undefined) {
                          ctx.activeAssistantItemsWithContent.add(scopedItemId);
                        }
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          ...(scopedItemId ? { itemId: scopedItemId } : {}),
                          text: event.text,
                          ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "UsageUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      recordAcpSessionCost(ctx, event.cost);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpTokenUsageEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          usage: event.usage,
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }).pipe(
                // Bump the processed count only after the handler fully ran, so
                // waitForQueuedTurnEventsDrained cannot observe an event as
                // consumed while its state updates are still being applied.
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
            // The drain's lifetime is the session's, not the caller's: forking it as
            // a child of the fiber that called startSession kills it as soon as that
            // fiber returns, silently dropping every session/update.
          ).pipe(Effect.forkIn(ctx.scope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Config RPCs run after the consumer fork so replay emitted while they
          // are in flight keeps draining. The session is already registered and
          // the start-scope finalizer no longer owns the session scope, so any
          // failure OR interruption of the remaining startup steps must tear the
          // session down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            if (agentModelSelection?.model) {
              yield* hooks.applyModelSelection({
                runtime: acp,
                model: agentModelSelection.model,
                thinkingLevel: hooks.effortFromModelOptions(agentModelSelection.options),
                ...(effectiveAgentSettings.modelConfigId !== undefined
                  ? { modelConfigId: effectiveAgentSettings.modelConfigId }
                  : {}),
                ...(effectiveAgentSettings.effortConfigId !== undefined
                  ? { effortConfigId: effectiveAgentSettings.effortConfigId }
                  : {}),
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
            }
            // The requested model/effort are applied; turns gated on this
            // deferred can now prompt without inheriting provider defaults.
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // Settle the replay in the background: suppression stays active until
              // the stream is genuinely quiet, while startup only blocks briefly so
              // a long replay cannot hold session startup hostage. sendTurn awaits
              // the deferred, so the first turn stays gated until the replay has
              // actually finished.
              yield* settleResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(ACP_RESUME_REPLAY_MAX_WAIT_MS),
              );
            }

            // A concurrent stop during the config/replay waits (interruptTurn,
            // or a sendTurn error path that tore the session down) must not
            // still emit the ready sequence for a dead session.
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: `${agentDisplayName} session ready` },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.timeoutOption(ACP_REQUEST_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(acpRequestTimeoutError(PROVIDER, "session/set_config_option")),
                onSome: Effect.succeed,
              }),
            ),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignore(stopSessionInternal(ctx)),
            ),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    // Idle-progress watchdog escape hatch: force-fail a turn whose omp child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via clearAcpActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failTurnAsTimedOut = (ctx: SharedAcpSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `${agentDisplayName} stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning(`${logPrefix}.turn_idle_timeout`, {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        // Let Omp flush final ACP updates and settle session/prompt before
        // escalating to process teardown for a silent nested worker.
        yield* cancelPromptWithGrace(ctx, promptFiber);
        yield* stopSessionInternal(ctx, {
          exitKind: "error",
          reason: detail,
          awaitTermination: false,
        });
      });

    const sendTurn: SharedAcpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A second sendTurn entering while another turn is starting or still in
        // flight would clobber activeTurnId (attributing the first turn's events
        // and completion to the second) and race two ACP prompts; reject it.
        if (ctx.turnStarting || ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Another ${agentDisplayName} turn is already active or still starting for this thread.`,
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startTurn = (
      ctx: SharedAcpSessionContext,
      input: Parameters<SharedAcpAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        // Startup registers the session before its config RPCs settle; a turn
        // routed in during that window must not prompt with provider defaults.
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.await(ctx.resumeReplayReady);
        }
        // The gates above are resolved by stopSessionInternal too (a failed or
        // stopped startup must not strand waiters); a turn that was blocked on
        // them must fail here instead of emitting lifecycle events for a dead
        // session.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        const runtimeMode = ctx.session.runtimeMode;
        if (runtimeMode === "auto") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Auto runtime mode is available only to Codex and Claude.",
          });
        }
        // Selection changes normally arrive via a session restart, but a turn
        // can still carry an explicit selection; re-assert it over ACP (the
        // shared runtime skips the RPC when the value already matches).
        yield* Effect.gen(function* () {
          if (model !== undefined) {
            yield* hooks.applyModelSelection({
              runtime: ctx.acp,
              model,
              thinkingLevel: hooks.effortFromModelOptions(turnModelSelection?.options),
              ...(ctx.agentSettings.modelConfigId !== undefined
                ? { modelConfigId: ctx.agentSettings.modelConfigId }
                : {}),
              ...(ctx.agentSettings.effortConfigId !== undefined
                ? { effortConfigId: ctx.agentSettings.effortConfigId }
                : {}),
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
          }
          yield* applyAcpAgentInteractionMode({
            runtime: ctx.acp,
            interactionMode,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });
        }).pipe(
          Effect.timeoutOption(ACP_REQUEST_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(acpRequestTimeoutError(PROVIDER, "session/set_config_option")),
              onSome: Effect.succeed,
            }),
          ),
          Effect.onError((cause) =>
            stopSessionInternal(ctx, {
              exitKind: "error",
              reason: Cause.pretty(cause),
            }),
          ),
        );
        const imagePromptMode = hooks.gateImagesOnPromptCapabilities
          ? resolveAcpPromptImageMode(ctx.promptCapabilities)
          : "blocks";
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: appendProviderReferencesPromptBlock({
            text: input.input?.trim()
              ? withAcpPlanModePrompt({
                  text: input.input.trim(),
                  interactionMode,
                  promptPrefix: hooks.planModePromptPrefix,
                })
              : undefined,
            mentions: input.mentions,
          }),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
          // Without image support the attachment still reaches the agent as an
          // on-disk path it can read like any other file.
          ...(imagePromptMode === "path-references" ? { includeImage: () => true } : {}),
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        promptParts.push(
          ...(imagePromptMode === "blocks"
            ? yield* loadProviderPromptImageBlocks({
                attachments: input.attachments,
                attachmentsDir: serverConfig.attachmentsDir,
                provider: PROVIDER,
                method: "session/prompt",
                readFile: fileSystem.readFile,
              })
            : []),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeAcpSynaraHarnessPolicyTextPart(
          PROVIDER,
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        // A stop can land while the replay gate or attachment reads above were
        // in flight; opening the turn now would publish turn.started (and a
        // phantom cancelled completion) for a session that already exited.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // Late-event attribution only matters between turns; once a new turn
        // dispatches, stragglers from older turns are stale enough to drop.
        ctx.turnToolCallIds.clear();
        ctx.lastSettledTurnId = undefined;
        ctx.lastSettledAssistantItemsWithContent.clear();
        ctx.activeNestedTaskToolCallIds.clear();
        ctx.nestedTaskLifecycleByToolCallId.clear();
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { ...(model ? { model } : {}) },
        });

        const runPrompt = Effect.suspend(() =>
          // interruptTurn during the pre-prompt waits (resume replay, attachment
          // reads) or between turn.started publishing and this fiber being
          // registered sets pendingTurnInterrupted; honor it (and a concurrent
          // stop) here so a cancelled turn is never prompted. Self-interrupting
          // routes through the onInterrupt branch below, which completes the
          // turn as cancelled rather than as a provider failure.
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({ prompt: promptParts }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForQueuedTurnEventsDrained(ctx);
                const settledAssistantItems = [...ctx.activeAssistantItemsWithContent];
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                ctx.lastSettledTurnId = turnId;
                ctx.lastSettledAssistantItemsWithContent.clear();
                for (const itemId of settledAssistantItems) {
                  ctx.lastSettledAssistantItemsWithContent.add(itemId);
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
                // Transport/prompt failures make the ACP child unusable. Remove
                // it from routing immediately so ProviderService can recover on
                // the next send instead of reusing a dead session forever.
                yield* stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: detail,
                  awaitTermination: false,
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                // Drain BEFORE snapshotting turn state: queued events may still
                // set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                const settledAssistantItems = [...ctx.activeAssistantItemsWithContent];
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                ctx.lastSettledTurnId = turnId;
                ctx.lastSettledAssistantItemsWithContent.clear();
                for (const itemId of settledAssistantItems) {
                  ctx.lastSettledAssistantItemsWithContent.add(itemId);
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning(`${logPrefix}.turn_completed_without_content`, {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                ...(model ? { model } : {}),
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        // Backstop the forked prompt: if the child goes silent, fail the turn
        // instead of leaving it "Working" forever. Self-terminates when the
        // turn settles; pauses while a human approval is pending.
        yield* forkAcpTurnIdleWatchdog({
          idleTimeoutMs: TURN_IDLE_TIMEOUT_MS,
          currentIdleTimeoutMs: () =>
            ctx.activeNestedTaskToolCallIds.size > 0
              ? ACP_NESTED_TASK_IDLE_TIMEOUT_MS
              : TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: ACP_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: SharedAcpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (shouldIgnoreAcpInterrupt(turnId, ctx.activeTurnId)) {
          yield* Effect.logWarning(`${logPrefix}.stale_interrupt_ignored`, {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        if (!ctx.turnStarting && ctx.activeTurnId === undefined) {
          return;
        }
        // A turn that is still starting has no prompt fiber to interrupt yet
        // (it may be gated on resume replay); flag it so startTurn aborts
        // before prompting instead of running the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const activePromptFiber = ctx.activePromptFiber;
        yield* cancelPromptWithGrace(ctx, activePromptFiber);
        // Closing the process group is intentional: ACP agent can acknowledge
        // cancel before nested workers quiesce, so session reuse is unsafe.
        yield* stopSessionInternal(ctx, {
          exitKind: "graceful",
          reason: `${agentDisplayName} turn cancelled; runtime closed to stop nested work.`,
        });
      });

    const respondToRequest: SharedAcpAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: SharedAcpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: SharedAcpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const readExternalThread: NonNullable<SharedAcpAdapterShape["readExternalThread"]> =
      hooks.readExternalThread !== undefined
        ? (input) =>
            hooks.readExternalThread!(input, (providerOptions, providerInstanceId) =>
              resolveSessionSettings(providerOptions, providerInstanceId),
            )
        : () =>
            // ACP exposes no standard on-disk session store, so a generic adapter
            // cannot import a native transcript the way OMP's agentDir layout allows.
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/read",
                detail: `External thread import is not supported for ${agentDisplayName}.`,
              }),
            );

    const rollbackThread: SharedAcpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `${agentDisplayName} does not expose a native rewind cursor; rollback must restart the session with retained transcript context.`,
        });
      });

    const forkThread: NonNullable<SharedAcpAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveAcpAgentSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveAcpAgentSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: `A source and target cwd are required to fork an ${agentDisplayName} session.`,
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          Effect.gen(function* () {
            if (!(yield* runtime.supportsSessionFork)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "forkThread",
                issue: `This ${agentDisplayName} version does not advertise session/fork; Synara will rebuild the fork from its retained transcript.`,
              });
            }
            return yield* runtime.forkSession({ cwd: targetCwd, mcpServers: [] });
          }).pipe(
            Effect.timeoutOption(ACP_REQUEST_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(acpRequestTimeoutError(PROVIDER, "session/fork")),
                onSome: Effect.succeed,
              }),
            ),
          );

        const activeSource = sessions.get(input.sourceThreadId);
        // Forking mid-turn would branch from incomplete in-flight state, so
        // let the retained-transcript fallback handle busy sources.
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: `The source ${agentDisplayName} session has a turn in flight; Synara will rebuild the fork from its retained transcript.`,
          });
        }
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseAcpResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: `The source ${agentDisplayName} session has no resumable native cursor.`,
                });
              }
              const runtime = yield* hooks.makeRuntime({
                settings: resolveSessionSettings(input.providerOptions, input.providerInstanceId),
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Synara Fork", version: "0.0.0" },
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(ACP_REQUEST_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(acpRequestTimeoutError(PROVIDER, "session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        // Return only the cursor: ProviderService registers the binding under
        // a committed lifecycle lease and the target's first turn resumes it
        // there. Starting the runtime here would capture an undefined
        // lifecycle generation, orphaning the fork's approval requests.
        return {
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: ACP_RESUME_VERSION,
            sessionId: forked.sessionId,
          },
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterProcessError ||
          cause instanceof ProviderAdapterSessionClosedError ||
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/fork", cause),
        ),
      );

    const stopSession: SharedAcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx !== undefined && !ctx.stopped) {
            yield* stopSessionInternal(ctx);
            return;
          }
          if (sessionTeardownGate.isPending(threadId)) {
            yield* sessionTeardownGate.awaitPending(threadId);
            return;
          }
          return;
        }),
      );

    const listSessions: SharedAcpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: SharedAcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<
      SharedAcpAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        // ACP agents may expose /compact as a TUI command, but the protocol but ACP currently exposes no compaction RPC
        // and treats that text as an ordinary model prompt.
        supportsThreadCompaction: false,
        // ACP exposes no standard on-disk session store, so a generic agent's
        // external transcripts cannot be imported.
        supportsThreadImport: hooks.supportsThreadImport,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<SharedAcpAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const account = acpBoundary(input);
          const settings = mergeSettings({
            ...hooks.settingsFromDiscoveryInput(input),
            ...account,
          });
          const command = settings.command?.trim() ?? "";
          const cacheKey = [
            command,
            JSON.stringify(hooks.discoveryCacheFields(settings)),
            acpInstanceCacheScope(account, hooks.defaultInstanceId),
          ].join("\u0000");
          const cached = modelDiscoveryCache.get(cacheKey);
          const catalogFromCache = cached !== undefined && cached.expiresAt > Date.now();
          if (catalogFromCache) {
            log.info("model/list cache hit", {
              cacheKey,
              modelCount: cached.result.models.length,
            });
          }
          const catalog: ProviderListModelsResult =
            cached !== undefined && catalogFromCache
              ? cached.result
              : yield* discoverModels(settings, account).pipe(
                  Effect.timeoutOption(ACP_MODEL_DISCOVERY_TIMEOUT_MS),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "model/list",
                            detail: "Timed out while discovering ACP agent models.",
                          }),
                        ),
                      onSome: (discovered) => Effect.succeed(discovered),
                    }),
                  ),
                  Effect.tapError((cause) =>
                    Effect.sync(() => {
                      log.warn("model/list failed", {
                        method: cause.method,
                        detail: cause.detail,
                      });
                    }),
                  ),
                );
          if (!catalogFromCache) {
            log.info("model/list success", {
              modelCount: catalog.models.length,
              source: catalog.source,
            });
            setAcpDiscoveryCacheEntry(modelDiscoveryCache, cacheKey, {
              expiresAt: Date.now() + ACP_MODEL_DISCOVERY_CACHE_MS,
              result: catalog,
            });
          }
          return { ...catalog, ...(catalogFromCache ? { cached: true as const } : {}) };
        }),
      );

    const listCommands: NonNullable<SharedAcpAdapterShape["listCommands"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveAcpAgentSessionCwd(input.cwd, serverConfig);
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listCommands",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const account = acpBoundary(input);
          const settings = mergeSettings({
            ...hooks.settingsFromDiscoveryInput(input),
            ...account,
          });
          const command = settings.command?.trim() ?? "";
          const cacheKey = `${command}\u0000${JSON.stringify(hooks.discoveryCacheFields(settings))}\u0000${cwd}\u0000${acpInstanceCacheScope(account, hooks.defaultInstanceId)}`;
          const cached = commandDiscoveryCache.get(cacheKey);
          if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }
          const runtime = yield* makeDiscoveryRuntime({
            settings,
            cwd,
            clientName: `${PROVIDER}-command-discovery`,
          });
          yield* runtime.start();
          let commands = yield* runtime.getAvailableCommands;
          const startedAt = Date.now();
          while (commands.length === 0 && Date.now() - startedAt < 500) {
            yield* Effect.sleep(25);
            commands = yield* runtime.getAvailableCommands;
          }
          const result = {
            commands: commands.map((command) => ({
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
            })),
            source: "acp-agent",
            cached: false,
          } satisfies ProviderListCommandsResult;
          // A slow first advertise can leave the 500ms poll empty; caching that
          // would pin "no slash commands" for the whole TTL.
          if (commands.length > 0) {
            setAcpDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
              expiresAt: Date.now() + ACP_MODEL_DISCOVERY_CACHE_MS,
              result,
            });
          }
          return result;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof ProviderAdapterValidationError
              ? cause
              : mapAcpToAdapterError(
                  PROVIDER,
                  ThreadId.makeUnsafe(`${PROVIDER}-command-discovery`),
                  "command/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(ACP_MODEL_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "command/list",
                    detail: "Timed out while discovering ACP agent commands.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );

    const stopAll: SharedAcpAdapterShape["stopAll"] = () =>
      settleConcurrentTeardowns(sessions.values(), stopSessionInternal);

    yield* Effect.addFinalizer(() =>
      settleConcurrentTeardowns(sessions.values(), stopSessionInternal).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      readExternalThread,
      rollbackThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listCommands,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies SharedAcpAdapterShape;
  });
}
