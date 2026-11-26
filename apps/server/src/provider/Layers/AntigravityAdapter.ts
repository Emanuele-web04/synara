/**
 * AntigravityAdapterLive - Antigravity CLI (`agy acp`) via the Agent Client Protocol.
 *
 * ACP gives Antigravity the same runtime shape as the other ACP providers:
 * streamed assistant and reasoning text, tool calls with kinds and live
 * status, usage updates, and per-session MCP servers. The Synara gateway and
 * every granted connector are attached at `session/new`, so they no longer
 * depend on the CLI's plugin MCP loading.
 *
 * @module AntigravityAdapterLive
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@synara/contracts";
import { unsupportedAutoRuntimeModeMessage } from "@synara/shared/runtimeMode";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
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
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  AntigravityAdapter,
  type AntigravityAdapterShape,
} from "../Services/AntigravityAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
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
  forkAcpAdapterTurnIdleWatchdog,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
} from "../acp/AcpAdapterSessionSupport.ts";
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
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  type AcpToolCallState,
  findSessionConfigOption,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  buildAcpModelDescriptor,
  findSelectConfig,
  flattenConfigOptions,
} from "../acp/AcpConfigOptions.ts";
import {
  type AntigravityAcpModel,
  antigravityInteractionQuestion,
  antigravityModelConfig,
  antigravitySupportsTurnSteering,
  antigravityThoughtLevelConfig,
  buildAntigravityAcpSpawnInput,
  chooseAntigravityAcpModel,
  makeAntigravityAcpRuntime,
  readAntigravityAcpModels,
  readAntigravityConfigModels,
  resolveAntigravityAcpModelId,
  setAntigravityAcpModel,
  withAntigravityToolSummary,
} from "../acp/AntigravityAcpSupport.ts";
import {
  type AntigravityChildWork,
  asAntigravitySubagentCall,
  readAntigravityChildWork,
  resolveAntigravityProfile,
} from "../acp/AntigravityChildWork.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { makeSessionTeardownGate } from "../acp/SessionTeardownGate.ts";
import { cancelTurnAndWait } from "../acp/TurnCancellation.ts";
import {
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  readAntigravityResumeSessionId,
  resolveAntigravityCliModelLabel,
  runAntigravityHelperProcess,
} from "../antigravityCli.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "antigravity" as const;
const ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_STARTUP_CONFIG_MAX_WAIT_MS = 3_000;
const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const ANTIGRAVITY_TURN_SETTLE_DRAIN_POLL_MS = 25;
const ANTIGRAVITY_CANCEL_GRACE_MS = 5_000;
const ANTIGRAVITY_TURN_WATCHDOG_INTERVAL_MS = 15_000;
// Backstop for an alive-but-silent agy child: force-fail a turn with no ACP
// activity for this long instead of showing "Working" forever.
const ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
// `agy acp` keeps working after `end_turn` when a command it sent to the
// background finishes: it reports the command's completion and replies again.
// The turn stays open until those commands settle and the agent goes quiet.
const ANTIGRAVITY_BACKGROUND_QUIET_MS = 2_500;
const ANTIGRAVITY_BACKGROUND_POLL_MS = 250;
const ANTIGRAVITY_BACKGROUND_MAX_WAIT_MS = 30 * 60_000;

export const takeAntigravitySynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });

export interface AntigravityAdapterDependencies {
  readonly makeRuntime?: typeof makeAntigravityAcpRuntime;
  readonly runHelper?: typeof runAntigravityHelperProcess;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Quiet period before a turn waiting on background commands settles. */
  readonly backgroundQuietMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface AntigravitySessionContext {
  harnessPolicyDelivered?: boolean;
  readonly enableComputerControl?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly acpSessionId: string;
  readonly antigravityProfile: string;
  readonly availableModels: ReadonlyArray<AntigravityAcpModel>;
  appliedModelId: string | undefined;
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
  activeSteerRequests: number;
  activeSteerCompletion: Pick<TurnOutcome, "state" | "stopReason" | "errorMessage"> | undefined;
  lastTurnActivityAt: number | undefined;
  finishingTurnId: TurnId | undefined;
  /** Recent tool calls and outstanding calls that can still report after their turn ends. */
  readonly toolCallOwners: Map<string, { readonly turnId: TurnId; readonly settled: boolean }>;
  /** Non-daemon tool calls of the active turn that have not settled yet. */
  readonly runningToolCallIds: Set<string>;
  readonly subagentCalls: Map<
    string,
    {
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  >;
  subagentChildren: ReadonlyMap<string, ReadonlyArray<AntigravityChildWork>>;
  /** Set while a turn whose prompt returned waits for background commands. */
  backgroundWaitTurnId: TurnId | undefined;
  /** Resolves once the requested model is applied; turns wait on it. */
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  readonly teardownComplete: Deferred.Deferred<void>;
  latestSessionCostUsd: number | undefined;
  sessionUpdatesProcessed: number;
  turnStarting: boolean;
  pendingTurnInterrupted: boolean;
  stopped: boolean;
}

type TurnOutcome = {
  readonly state: "completed" | "cancelled" | "failed";
  readonly stopReason: string | null;
  readonly errorMessage?: string;
  readonly usage?: unknown;
  readonly item: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trim(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export function resolveAntigravitySessionCwd(
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

/** Daemons (dev servers, watchers) run until stopped; a turn must not wait on them. */
export function isAntigravityDaemonToolCall(toolCall: AcpToolCallState): boolean {
  const rawInput = toolCall.data.rawInput;
  return isRecord(rawInput) && rawInput.IsDaemon === true;
}

function antigravityAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `Antigravity ACP did not respond to ${method} within ${ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

/** The Synara model name (display label without effort) for an ACP model id. */
function sessionModelName(
  availableModels: ReadonlyArray<AntigravityAcpModel>,
  modelId: string | undefined,
): string | undefined {
  const name = availableModels.find((model) => model.modelId === modelId)?.name;
  return name ? (parseAntigravityCliModelLabel(name)?.model ?? name) : undefined;
}

// The advertised config value wins over the deprecated session mode state.
const readAntigravityPermissionMode = Effect.fnUntraced(function* (acp: AcpSessionRuntimeShape) {
  const config = findSelectConfig(yield* acp.getConfigOptions, { id: "mode", category: "mode" });
  if (config) return { id: config.currentValue, configId: config.id };
  const legacyMode = yield* acp.getModeState;
  return legacyMode ? { id: legacyMode.currentModeId } : undefined;
});

export function makeAntigravityAdapter(dependencies: AntigravityAdapterDependencies = {}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const makeRuntime = dependencies.makeRuntime ?? makeAntigravityAcpRuntime;
    const runHelper = dependencies.runHelper ?? runAntigravityHelperProcess;
    const backgroundQuietMs = dependencies.backgroundQuietMs ?? ANTIGRAVITY_BACKGROUND_QUIET_MS;
    const nativeEventLogger = dependencies.nativeEventLogger;

    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const sessionTeardownGate = makeSessionTeardownGate();
    const defaultEffortByModel = new Map<string, string>();
    const withThreadLock = yield* makeAcpThreadLock();
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

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: AntigravitySessionContext,
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
            // Scope.close interrupts fibers owned by this scope; a daemon runs
            // the close so those fibers can start teardown without self-waiting.
            yield* teardown.pipe(Effect.forkDetach, Effect.asVoid);
          }
          if (options?.awaitTermination !== false) {
            yield* restore(Deferred.await(ctx.teardownComplete));
          }
        }),
      );

    const waitForQueuedTurnEventsDrained = (ctx: AntigravitySessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: ANTIGRAVITY_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
        pollMs: ANTIGRAVITY_TURN_SETTLE_DRAIN_POLL_MS,
      });

    const withAcpTimeout = <A, E>(method: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(antigravityAcpTimeoutError(method)),
            onSome: (value: A) => Effect.succeed(value),
          }),
        ),
      );

    const emitToolCall = (
      ctx: AntigravitySessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const children =
          turnId === ctx.activeTurnId ? ctx.subagentChildren.get(toolCall.toolCallId) : undefined;
        const enrichedCall =
          children && children.length > 0
            ? {
                ...toolCall,
                data: {
                  ...toolCall.data,
                  receiverAgents: children.map((child) => ({
                    threadId: child.threadId,
                    agentRole: child.role,
                    prompt: child.prompt,
                  })),
                  agentStates: Object.fromEntries(
                    children.map((child) => [
                      child.threadId,
                      {
                        status: child.status ?? (child.atWork ? "running" : "unreported"),
                        ...(child.latestUpdate ? { latestUpdate: child.latestUpdate } : {}),
                      },
                    ]),
                  ),
                },
              }
            : toolCall;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpToolCallEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            toolCall: scopeAcpToolCallStateForTurn(
              PROVIDER,
              turnId,
              withAntigravityToolSummary(enrichedCall),
            ),
            rawPayload,
          }),
        );
      });

    /** Applies a saved model and its model-specific thought level before any prompt is sent. */
    const applyModelSelection = (
      ctx: AntigravitySessionContext,
      selection: { readonly model: string; readonly reasoningEffort?: string | undefined },
    ) =>
      Effect.gen(function* () {
        const configError = (cause: Parameters<typeof mapAcpToAdapterError>[3]) =>
          mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_config_option", cause);
        const setConfig = (id: string, value: string) =>
          withAcpTimeout(
            "session/set_config_option",
            ctx.acp.setConfigOption(id, value).pipe(Effect.mapError(configError)),
          );
        const configOptions = yield* ctx.acp.getConfigOptions.pipe(Effect.mapError(configError));
        const modelConfig = antigravityModelConfig(configOptions);
        if (modelConfig) {
          const { availableModels, currentModelId } = readAntigravityConfigModels(modelConfig);
          const parsed = parseAntigravityCliModelLabel(selection.model);
          const bareOrchestrator = parsed?.model.toLowerCase() === "orchestrator";
          const effort = selection.reasoningEffort ?? parsed?.effort;
          const savedLabel = resolveAntigravityCliModelLabel(
            selection.model,
            effort ? { reasoningEffort: effort } : undefined,
          );
          const baseMatches = availableModels.filter(
            (model) =>
              parseAntigravityCliModelLabel(model.name)?.model.toLowerCase() ===
              parsed?.model.toLowerCase(),
          );
          const savedAlias =
            !bareOrchestrator &&
            parsed?.effort &&
            (parsed.effort === "low" ||
              parsed.effort === "medium" ||
              parsed.effort === "high" ||
              parsed.effort === "thinking")
              ? resolveAntigravityAcpModelId(availableModels, parsed.model)
              : undefined;
          const legacyPlanner =
            bareOrchestrator && !effort
              ? (baseMatches.find((model) => model.modelId === currentModelId)?.modelId ??
                (baseMatches.length === 1 ? baseMatches[0]?.modelId : undefined))
              : undefined;
          const exactId =
            bareOrchestrator && effort
              ? undefined
              : availableModels.find((model) => model.modelId === selection.model)?.modelId;
          const variant = effort
            ? resolveAntigravityAcpModelId(availableModels, savedLabel)
            : undefined;
          const modelId =
            exactId ??
            variant ??
            (!(bareOrchestrator && effort)
              ? resolveAntigravityAcpModelId(availableModels, selection.model)
              : undefined) ??
            savedAlias ??
            legacyPlanner;
          if (!modelId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/set_config_option",
              issue: `Antigravity does not offer the model '${effort ? savedLabel : selection.model}'. Refresh the model list and pick an available model.`,
            });
          }
          yield* Effect.gen(function* () {
            const selectedConfig =
              modelId === currentModelId
                ? configOptions
                : (yield* setConfig(modelConfig.id, modelId)).configOptions;
            if (!effort || (bareOrchestrator && variant === modelId)) return;
            // A model switch replaces the thought-level choices. Validate the new model's menu.
            const thoughtLevel = antigravityThoughtLevelConfig(selectedConfig);
            const levelOptions = thoughtLevel ? flattenConfigOptions(thoughtLevel.options) : [];
            const byLabel = levelOptions.filter(
              (option) => option.name.toLowerCase() === effort.toLowerCase(),
            );
            const level =
              levelOptions.find((option) => option.value === effort) ??
              (byLabel.length === 1 ? byLabel[0] : undefined);
            if (thoughtLevel && level) {
              if (level.value !== thoughtLevel.currentValue)
                yield* setConfig(thoughtLevel.id, level.value);
            } else if (variant !== modelId || thoughtLevel) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "session/set_config_option",
                issue: `Antigravity model '${selection.model}' does not offer '${effort}' as a thinking level.`,
              });
            }
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                // Changing the model can succeed before setting its effort fails. Restore both values.
                const previousLevel = antigravityThoughtLevelConfig(configOptions);
                if (modelId !== currentModelId) yield* setConfig(modelConfig.id, currentModelId);
                if (previousLevel) yield* setConfig(previousLevel.id, previousLevel.currentValue);
              }).pipe(
                Effect.catch(() =>
                  stopSessionInternal(ctx, {
                    exitKind: "error",
                    reason: "Antigravity could not restore the session's model settings.",
                    awaitTermination: false,
                  }),
                ),
              ),
            ),
          );
          return modelId;
        }

        const label = resolveAntigravityCliModelLabel(
          selection.model,
          selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : undefined,
          defaultEffortByModel.get(
            `${ctx.session.providerInstanceId ?? PROVIDER}\0${selection.model}`,
          ),
        );
        const choice = chooseAntigravityAcpModel(ctx.availableModels, label, ctx.appliedModelId);
        switch (choice.kind) {
          case "unavailable":
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/set_model",
              issue: `Antigravity does not offer the model '${label}'. Refresh the model list and pick an available model.`,
            });
          case "model":
            if (choice.modelId !== ctx.appliedModelId) {
              yield* withAcpTimeout(
                "session/set_model",
                setAntigravityAcpModel(ctx.acp, ctx.acpSessionId, choice.modelId).pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_model", cause),
                  ),
                ),
              );
            }
            return choice.modelId;
          case "base": {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/set_model",
              issue: `Antigravity does not offer a selectable model for '${choice.baseName}'. Refresh the model list and pick an available model.`,
            });
          }
        }
      });

    /** Emits the single terminal turn.completed for `turnId`; idempotent. */
    const settleTurn = (
      ctx: AntigravitySessionContext,
      turnId: TurnId,
      initialOutcome: TurnOutcome,
    ) =>
      Effect.suspend(() => {
        if (ctx.activeTurnId !== turnId || ctx.finishingTurnId === turnId)
          return Effect.succeed(false);
        ctx.finishingTurnId = turnId;
        // An explicit Stop or transport failure retains ownership of the outcome.
        const outcome =
          initialOutcome.state === "completed" && ctx.activeSteerCompletion
            ? { ...initialOutcome, ...ctx.activeSteerCompletion }
            : initialOutcome;
        return Effect.gen(function* () {
          yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
          yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
          if (!clearAcpActiveTurn(ctx, turnId)) return false;
          ctx.backgroundWaitTurnId = undefined;
          ctx.activeSteerCompletion = undefined;
          ctx.runningToolCallIds.clear();
          const completedCost = finalizeAcpActiveTurnCost(ctx);
          ctx.turns.push({ id: turnId, items: [outcome.item] });
          const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
          const updatedAt = yield* nowIso;
          ctx.session =
            outcome.state === "failed"
              ? {
                  ...sessionWithoutLastError,
                  status: "error",
                  updatedAt,
                  ...(outcome.errorMessage ? { lastError: outcome.errorMessage } : {}),
                }
              : { ...sessionWithoutLastError, status: "ready", updatedAt };
          const stamp = yield* makeEventStamp();
          ctx.finishingTurnId = undefined;
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "turn.completed",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              state: outcome.state,
              stopReason: outcome.stopReason,
              ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
              ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
              ...completedCost,
            },
          } as ProviderRuntimeEvent);
          return true;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (ctx.finishingTurnId === turnId) ctx.finishingTurnId = undefined;
            }),
          ),
        );
      });

    /**
     * Keeps a turn whose prompt returned open while its background commands
     * run, then settles it once they finish and the agent stops reporting.
     */
    const awaitBackgroundCommands = (
      ctx: AntigravitySessionContext,
      turnId: TurnId,
      outcome: TurnOutcome,
    ) =>
      Effect.gen(function* () {
        ctx.backgroundWaitTurnId = turnId;
        const startedAt = Date.now();
        let nextChildScanAt = startedAt;
        let waking = false;
        while (ctx.activeTurnId === turnId && !ctx.stopped) {
          if (ctx.pendingTurnInterrupted) return;
          if (Date.now() >= nextChildScanAt && ctx.subagentCalls.size > 0) {
            const children = yield* readAntigravityChildWork({
              profile: ctx.antigravityProfile,
              sessionId: ctx.acpSessionId,
              toolCallIds: new Set(ctx.subagentCalls.keys()),
            }).pipe(Effect.timeoutOption(1_000));
            nextChildScanAt = Date.now() + 1_000;
            if (ctx.activeTurnId !== turnId || ctx.stopped || ctx.pendingTurnInterrupted) return;
            const observed = Option.getOrUndefined(children);
            if (observed) {
              if (waking !== observed.waking) ctx.lastTurnActivityAt = Date.now();
              waking = observed.waking;
              const previous = ctx.subagentChildren;
              ctx.subagentChildren = observed.children;
              for (const [id, current] of observed.children) {
                if (JSON.stringify(current) === JSON.stringify(previous.get(id))) continue;
                const call = ctx.subagentCalls.get(id);
                if (call) {
                  ctx.lastTurnActivityAt = Date.now();
                  yield* emitToolCall(ctx, call.toolCall, turnId, call.rawPayload);
                }
              }
            }
          }
          const childrenAtWork = [...ctx.subagentChildren.values()].some((children) =>
            children.some((child) => child.atWork),
          );
          const quietFor = Date.now() - (ctx.lastTurnActivityAt ?? startedAt);
          if (ctx.pendingUserInputs.size > 0 || ctx.pendingApprovals.size > 0) {
            yield* Effect.sleep(ANTIGRAVITY_BACKGROUND_POLL_MS);
            continue;
          }
          if (
            !waking &&
            !childrenAtWork &&
            ctx.runningToolCallIds.size === 0 &&
            ctx.activeSteerRequests === 0 &&
            quietFor >= backgroundQuietMs
          ) {
            yield* waitForQueuedTurnEventsDrained(ctx);
            if (
              !ctx.pendingTurnInterrupted &&
              ctx.runningToolCallIds.size === 0 &&
              ctx.activeSteerRequests === 0 &&
              ctx.pendingUserInputs.size === 0 &&
              ctx.pendingApprovals.size === 0 &&
              Date.now() - (ctx.lastTurnActivityAt ?? startedAt) >= backgroundQuietMs
            ) {
              yield* settleTurn(ctx, turnId, outcome);
              return;
            }
            continue;
          }
          if (
            ctx.activeSteerRequests === 0 &&
            Date.now() - startedAt >= ANTIGRAVITY_BACKGROUND_MAX_WAIT_MS
          ) {
            yield* Effect.logWarning("antigravity.acp.background_wait_expired", {
              threadId: ctx.threadId,
              turnId,
              running: ctx.runningToolCallIds.size,
            });
            break;
          }
          yield* Effect.sleep(ANTIGRAVITY_BACKGROUND_POLL_MS);
        }
        yield* waitForQueuedTurnEventsDrained(ctx);
        yield* settleTurn(ctx, turnId, outcome);
      });

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
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
          if (input.runtimeMode === "auto") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "session/start",
              issue: unsupportedAutoRuntimeModeMessage(PROVIDER),
            });
          }
          yield* sessionTeardownGate.awaitPending(input.threadId);
          const cwd = resolveAntigravitySessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const modelSelection =
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
          let ctx!: AntigravitySessionContext;

          // Capture turn ownership at open so a late resolution cannot attach to a later turn.
          const requestUserInput = (
            questions: ReadonlyArray<UserInputQuestion>,
            method: string,
            params: unknown,
            validate?: (answers: ProviderUserInputAnswers) => boolean,
          ) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const turnId = ctx?.activeTurnId;
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                if (
                  ctx?.stopped ||
                  ctx?.pendingTurnInterrupted ||
                  ctx?.finishingTurnId !== undefined ||
                  (validate && !turnId)
                )
                  return {};
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: { source: "acp.jsonrpc", method, payload: params },
                });
                const result = yield* Effect.exit(restore(Deferred.await(answers)));
                const resolved =
                  Exit.isSuccess(result) && (validate?.(result.value) ?? true) ? result.value : {};
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return resolved;
              }),
            );

          const resumeSessionId = readAntigravityResumeSessionId(input.resumeCursor);
          const providerOptions = input.providerOptions?.antigravity;
          const antigravitySettings = {
            ...(providerOptions?.binaryPath ? { binaryPath: providerOptions.binaryPath } : {}),
            ...(providerOptions?.environment ? { environment: providerOptions.environment } : {}),
          };
          const acp = yield* makeRuntime({
            antigravitySettings,
            childProcessSpawner,
            cwd,
            ...(input.additionalDirectories !== undefined
              ? { additionalDirectories: input.additionalDirectories }
              : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            // Antigravity asks clarifying questions as ACP form elicitations when
            // the client supports them, and as plain chat text otherwise.
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "Synara", version: "0.0.0" },
            ...(agentGatewayCredentials && gatewaySessionLease
              ? {
                  // The Synara gateway plus every connector granted to this
                  // session (Notion, Linear, ...) attach per session over ACP.
                  buildMcpServers: (initializeResult: Acp.InitializeResponse) =>
                    buildAcpSynaraMcpServers({
                      connection: gatewaySessionLease.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              const cancelled = { outcome: { outcome: "cancelled" as const } };
              const turnId = ctx?.activeTurnId;
              if (turnId === undefined || params.sessionId !== ctx.acpSessionId) return cancelled;
              // Earlier background calls can still report after another turn starts.
              const ownsTurn = () => {
                const toolOwner = ctx.toolCallOwners.get(params.toolCall.toolCallId);
                return (
                  ctx.activeTurnId === turnId &&
                  (toolOwner === undefined || toolOwner.turnId === turnId) &&
                  !ctx.pendingTurnInterrupted &&
                  ctx.finishingTurnId === undefined &&
                  !ctx.stopped
                );
              };
              if (!ownsTurn()) return cancelled;
              yield* logNative(input.threadId, "session/request_permission", params);
              if (!ownsTurn()) return cancelled;
              if (params.toolCall.toolCallId.startsWith("interaction_")) {
                const question = antigravityInteractionQuestion(params);
                if (!question) return cancelled;
                ctx.lastTurnActivityAt = Date.now();
                const answers = yield* requestUserInput(
                  [question],
                  "session/request_permission",
                  params,
                  (reply) =>
                    Object.keys(reply).length === 1 &&
                    typeof reply[question.id] === "string" &&
                    question.options.some((option) => option.value === reply[question.id]),
                );
                ctx.lastTurnActivityAt = Date.now();
                const optionId = answers[question.id];
                return ownsTurn() && typeof optionId === "string"
                  ? { outcome: { outcome: "selected" as const, optionId } }
                  : cancelled;
              }
              const nativeMode = yield* Effect.exit(readAntigravityPermissionMode(acp));
              if (Exit.isFailure(nativeMode) || !ownsTurn()) return cancelled;
              // Full access may grant this call but must not install a lasting native rule.
              const policyOptions = params.options.filter(
                (option) => option.kind !== "allow_always",
              );
              const hasOneTimeGrant = policyOptions.some(
                (option) => option.kind === "allow_once" && option.optionId.trim(),
              );
              const policyOutcome = resolveAcpPermissionPolicy({
                runtimeMode: hasOneTimeGrant ? ctx.session.runtimeMode : "approval-required",
                interactionMode:
                  nativeMode.value?.id === "plan" ? "plan" : ctx.activeInteractionMode,
                options: policyOptions,
                computerControlEnabled: ctx?.enableComputerControl === true,
                activeTurn: ctx?.activeTurnId !== undefined,
                toolCall: params.toolCall,
              });
              if (policyOutcome !== undefined) {
                return policyOutcome.outcome === "selected"
                  ? {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: policyOutcome.optionId,
                      },
                    }
                  : { outcome: { outcome: "cancelled" as const } };
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              if (!ownsTurn()) return cancelled;
              pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
              return yield* Effect.gen(function* () {
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const response = yield* Deferred.await(decision);
                const stamp = yield* makeEventStamp();
                const selectedOptionId = selectAcpPermissionOptionId(
                  ownsTurn() ? response : "cancel",
                  response === "accept"
                    ? params.options.filter((option) => option.kind === "allow_once")
                    : params.options,
                );
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: selectedOptionId === undefined ? "cancel" : response,
                  }),
                );
                // Publishing can wait on subscribers. Stop must still cancel the ACP response.
                return selectedOptionId === undefined || !ownsTurn()
                  ? cancelled
                  : { outcome: { outcome: "selected" as const, optionId: selectedOptionId } };
              }).pipe(Effect.ensuring(Effect.sync(() => void pendingApprovals.delete(requestId))));
            }),
          );

          yield* acp.handleElicitation((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/elicitation", params);
              if (!isFormElicitationRequest(params)) {
                return { action: "decline" as const };
              }
              const mapping = { otherAnswerConvention: "antigravity" } as const;
              const questions = elicitationQuestionsFromRequest(params, mapping);
              if (questions.length === 0) {
                return { action: "decline" as const };
              }
              const resolved = yield* requestUserInput(questions, "session/elicitation", params);
              return elicitationResponseFromAnswers(params, resolved, mapping);
            }),
          );

          const started = yield* acp.start().pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
            Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(antigravityAcpTimeoutError("session/start")),
                onSome: Effect.succeed,
              }),
            ),
          );
          if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail:
                "Antigravity could not resume the requested conversation. Synara refused the fresh fallback to avoid silently losing conversation context.",
            });
          }
          if (gatewaySessionLease) {
            yield* Effect.logDebug("antigravity.acp.gateway_configured", {
              threadId: input.threadId,
              setupMethod: started.sessionSetupMethod,
              transport:
                started.initializeResult.agentCapabilities?.mcpCapabilities?.http === true
                  ? "http"
                  : "stdio",
            });
          }

          const models = readAntigravityAcpModels(started.sessionSetupResult);
          const modelConfig = antigravityModelConfig(
            started.sessionSetupResult.configOptions ?? [],
          );
          const sessionConfigReady = yield* Deferred.make<void>();
          const teardownComplete = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const sessionModel =
            modelSelection?.model ??
            modelConfig?.currentValue ??
            sessionModelName(models.availableModels, models.currentModelId);
          const session: ProviderSession = {
            provider: PROVIDER,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            supportsNativeTurnSteering: antigravitySupportsTurnSteering(started.initializeResult),
            cwd,
            ...(sessionModel ? { model: sessionModel } : {}),
            threadId: input.threadId,
            // A bare id keeps resume compatible with print-mode threads: agy
            // uses one id for the conversation and its ACP session.
            resumeCursor: started.sessionId,
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            enableComputerControl: input.enableComputerControl === true,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            antigravityProfile: resolveAntigravityProfile(
              cwd,
              buildAntigravityAcpSpawnInput(antigravitySettings, cwd).env ?? {},
            ),
            availableModels: models.availableModels,
            appliedModelId: models.currentModelId,
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
            activeSteerRequests: 0,
            activeSteerCompletion: undefined,
            lastTurnActivityAt: undefined,
            finishingTurnId: undefined,
            toolCallOwners: new Map(),
            runningToolCallIds: new Set(),
            subagentCalls: new Map(),
            subagentChildren: new Map(),
            backgroundWaitTurnId: undefined,
            sessionConfigReady,
            teardownComplete,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            turnStarting: false,
            pendingTurnInterrupted: false,
            stopped: false,
          };

          const activeTurnIdFor = (eventTag: string) =>
            Effect.gen(function* () {
              if (ctx.activeTurnId === undefined) {
                yield* Effect.logDebug("antigravity.acp.runtime_event_suppressed", {
                  threadId: ctx.threadId,
                  eventTag,
                  reason: "orphan-turn-event",
                });
              }
              return ctx.activeTurnId;
            });

          const handleEvent = (
            event: Stream.Success<ReturnType<AcpSessionRuntimeShape["getEvents"]>>,
          ) =>
            Effect.gen(function* () {
              if (event._tag !== "ToolCallUpdated" && isAcpTurnProgressEventTag(event._tag)) {
                ctx.lastTurnActivityAt = Date.now();
              }
              switch (event._tag) {
                case "ModeChanged":
                case "AssistantItemStarted":
                  return;
                case "AssistantItemCompleted": {
                  const turnId = yield* activeTurnIdFor(event._tag);
                  if (turnId === undefined) return;
                  const itemId = scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId);
                  if (!ctx.activeAssistantItemsWithContent.delete(itemId)) return;
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpAssistantItemEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  return;
                }
                case "PlanUpdated": {
                  const turnId = yield* activeTurnIdFor(event._tag);
                  if (turnId === undefined) return;
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  if (!acceptAcpPlanUpdate(ctx, event.payload)) return;
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                }
                case "ToolCallUpdated": {
                  const preparedLaunch = asAntigravitySubagentCall(
                    event.toolCall,
                    ctx.subagentCalls.get(event.toolCall.toolCallId)?.toolCall,
                  );
                  const toolCall = preparedLaunch ?? event.toolCall;
                  const owner = ctx.toolCallOwners.get(toolCall.toolCallId);
                  const turnId = owner?.turnId ?? (yield* activeTurnIdFor(event._tag));
                  if (turnId === undefined) return;
                  const settled = toolCall.status === "completed" || toolCall.status === "failed";
                  ctx.toolCallOwners.set(toolCall.toolCallId, { turnId, settled });
                  if (turnId !== ctx.activeTurnId) {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitToolCall(ctx, toolCall, turnId, event.rawPayload);
                    return;
                  }
                  ctx.lastTurnActivityAt = Date.now();
                  if (preparedLaunch) {
                    ctx.subagentCalls.set(toolCall.toolCallId, {
                      toolCall,
                      rawPayload: event.rawPayload,
                    });
                  }
                  if (settled) {
                    ctx.runningToolCallIds.delete(toolCall.toolCallId);
                  } else if (!isAntigravityDaemonToolCall(toolCall)) {
                    ctx.runningToolCallIds.add(toolCall.toolCallId);
                  }
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  const failedToolDetail = readAcpFailedToolDetail(toolCall);
                  if (failedToolDetail !== undefined) {
                    ctx.activeTurnFailedToolDetail = failedToolDetail;
                  }
                  yield* emitToolCall(ctx, toolCall, turnId, event.rawPayload);
                  return;
                }
                case "ContentDelta": {
                  const turnId = yield* activeTurnIdFor(event._tag);
                  if (turnId === undefined) return;
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  const itemId = event.itemId
                    ? scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId)
                    : undefined;
                  if (event.streamKind !== "reasoning_text" && event.text.trim().length > 0) {
                    ctx.activeTurnHadAssistantContent = true;
                    if (itemId !== undefined) ctx.activeAssistantItemsWithContent.add(itemId);
                  }
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      ...(itemId ? { itemId } : {}),
                      text: event.text,
                      ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                }
                case "UsageUpdated": {
                  const turnId = yield* activeTurnIdFor(event._tag);
                  if (turnId === undefined) return;
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                  recordAcpSessionCost(ctx, event.cost);
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpTokenUsageEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      usage: event.usage,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                }
              }
            }).pipe(
              // Count an event only after its handler ran, so the settle drain
              // never observes state updates still in flight.
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.sessionUpdatesProcessed += 1;
                }),
              ),
            );

          // The drain lives as long as the session, not the startSession caller.
          ctx.notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), handleEvent),
          ).pipe(Effect.forkIn(sessionScope));
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* Effect.gen(function* () {
            const configurationFiber = yield* acp.awaitLoadReplayReady.pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
              ),
              Effect.andThen(
                modelSelection?.model
                  ? applyModelSelection(ctx, {
                      model: modelSelection.model,
                      reasoningEffort: modelSelection.options?.reasoningEffort,
                    }).pipe(
                      Effect.map((modelId) => {
                        ctx.appliedModelId = modelId;
                      }),
                    )
                  : Effect.void,
              ),
              // Turns wait on this gate, so none runs with the CLI default model.
              Effect.andThen(
                Effect.gen(function* () {
                  yield* Deferred.succeed(sessionConfigReady, undefined);
                  ctx.sessionConfigReady = undefined;
                }),
              ),
              Effect.onError((cause) =>
                stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: Cause.pretty(cause),
                  awaitTermination: false,
                }),
              ),
              Effect.forkIn(ctx.scope),
            );
            yield* Fiber.join(configurationFiber).pipe(
              Effect.timeoutOption(ANTIGRAVITY_STARTUP_CONFIG_MAX_WAIT_MS),
            );
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
              payload: { state: "ready", reason: "Antigravity ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.ignore(stopSessionInternal(ctx, { awaitTermination: false })),
            ),
          );

          // Once a prompt has returned, no pending prompt RPC will announce a lost ACP process.
          yield* acp.awaitExit.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (
                  ctx.stopped ||
                  (ctx.activeTurnId !== undefined &&
                    (ctx.pendingTurnInterrupted || ctx.backgroundWaitTurnId === undefined))
                )
                  return;
                const turnId = ctx.backgroundWaitTurnId;
                const reason = "Antigravity ACP exited while the session was open.";
                if (turnId !== undefined) {
                  yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
                  yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
                  yield* settleTurn(ctx, turnId, {
                    state: "failed",
                    stopReason: null,
                    errorMessage: reason,
                    item: { prompt: turnId, exited: true },
                  });
                }
                yield* stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason,
                  awaitTermination: false,
                });
              }),
            ),
            Effect.forkIn(sessionScope),
          );
          return session;
        }).pipe(Effect.scoped),
      );

    const failTurnAsTimedOut = (ctx: AntigravitySessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        const detail = `Antigravity stopped responding (no activity for ${Math.round(idleMs / 1000)}s); the turn was timed out.`;
        const settled = yield* settleTurn(ctx, turnId, {
          state: "failed",
          stopReason: null,
          errorMessage: detail,
          item: { prompt: turnId, timedOut: true, idleMs },
        });
        if (!settled) return;
        yield* Effect.logWarning("antigravity.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* cancelTurnAndWait({
          cancel: ctx.acp.cancel,
          promptFiber,
          graceMs: ANTIGRAVITY_CANCEL_GRACE_MS,
        });
        yield* stopSessionInternal(ctx, {
          exitKind: "error",
          reason: detail,
          awaitTermination: false,
        });
      });

    // Both fresh prompts and steers use the same attachment and reference projection.
    const buildPromptParts = (input: Parameters<AntigravityAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        const text = appendFileAttachmentsPromptBlock({
          text: appendProviderReferencesPromptBlock({
            text: trim(input.input),
            mentions: input.mentions,
          }),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        const parts: Array<Acp.ContentBlock> = text ? [{ type: "text", text }] : [];
        parts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );
        if (parts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session/prompt",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        return parts;
      });

    const startTurn = (
      ctx: AntigravitySessionContext,
      input: Parameters<AntigravityAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // A new prompt ends the wait for an earlier turn's background commands;
        // agy keeps running them and reports their output into the conversation.
        const waitingTurnId = ctx.backgroundWaitTurnId;
        if (waitingTurnId !== undefined) {
          yield* settleTurn(ctx, waitingTurnId, {
            state: "completed",
            stopReason: "end_turn",
            item: { prompt: waitingTurnId, supersededWhileWaiting: true },
          });
        }
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "An Antigravity turn is already active for this thread.",
          });
        }
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        if (turnModelSelection?.model) {
          ctx.appliedModelId = yield* applyModelSelection(ctx, {
            model: turnModelSelection.model,
            reasoningEffort: turnModelSelection.options?.reasoningEffort,
          });
        }
        const model = turnModelSelection?.model ?? ctx.session.model;

        const promptParts = yield* buildPromptParts(input);
        // Check after model selection, which can replace the native config options.
        const nativeMode = yield* readAntigravityPermissionMode(ctx.acp).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/mode", error),
          ),
        );
        if (nativeMode && nativeMode.id !== "default" && nativeMode.id !== "plan") {
          if (nativeMode.configId === undefined) {
            yield* withAcpTimeout(
              "session/set_mode",
              ctx.acp
                .setMode("default", { legacy: true })
                .pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_mode", error),
                  ),
                ),
            );
          } else {
            const config = yield* withAcpTimeout(
              "session/set_config_option",
              ctx.acp
                .setConfigOption(nativeMode.configId, "default")
                .pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      ctx.threadId,
                      "session/set_config_option",
                      error,
                    ),
                  ),
                ),
            );
            const mode = findSessionConfigOption(config.configOptions, nativeMode.configId);
            if (mode?.type !== "select" || mode.currentValue !== "default") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/set_config_option",
                detail: "Antigravity did not confirm the native Default permission mode.",
              });
            }
          }
        }
        const harnessPolicy = takeAntigravitySynaraHarnessPolicyTextPart(
          ctx,
          ctx.gatewaySessionLease !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.activeInteractionMode = input.interactionMode ?? "default";
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        for (const [toolCallId, owner] of ctx.toolCallOwners) {
          if (owner.settled) ctx.toolCallOwners.delete(toolCallId);
        }
        ctx.runningToolCallIds.clear();
        ctx.subagentCalls.clear();
        ctx.subagentChildren = new Map();
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            ...(model ? { model } : {}),
            ...(ctx.session.supportsNativeTurnSteering !== undefined
              ? { supportsNativeTurnSteering: ctx.session.supportsNativeTurnSteering }
              : {}),
          },
        });

        ctx.activePromptFiber = yield* Effect.suspend(() =>
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
                if (ctx.pendingTurnInterrupted) return;
                const settled = yield* settleTurn(ctx, turnId, {
                  state: "failed",
                  stopReason: null,
                  errorMessage: error.message,
                  item: { prompt: promptParts, error },
                });
                // A failed prompt leaves the agy child unusable; drop it from
                // routing so the next send recovers instead of reusing it.
                if (settled) {
                  yield* stopSessionInternal(ctx, {
                    exitKind: "error",
                    reason: error.message,
                    awaitTermination: false,
                  });
                }
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                yield* waitForQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId || ctx.pendingTurnInterrupted) return;
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(ctx.activeTurnFailedToolDetail !== undefined
                    ? { failedToolDetail: ctx.activeTurnFailedToolDetail }
                    : {}),
                });
                const outcome: TurnOutcome = {
                  state: completion.state,
                  stopReason: result.stopReason ?? null,
                  ...(completion.errorMessage !== undefined
                    ? { errorMessage: completion.errorMessage }
                    : {}),
                  ...(result.usage ? { usage: result.usage } : {}),
                  item: { prompt: promptParts, result },
                };
                if (
                  completion.state === "completed" &&
                  (ctx.runningToolCallIds.size > 0 ||
                    ctx.activeSteerRequests > 0 ||
                    ctx.subagentCalls.size > 0 ||
                    ctx.pendingUserInputs.size > 0 ||
                    ctx.pendingApprovals.size > 0)
                ) {
                  yield* awaitBackgroundCommands(ctx, turnId, outcome);
                  return;
                }
                yield* settleTurn(ctx, turnId, outcome);
              }),
          }),
          Effect.onInterrupt(() =>
            settleTurn(ctx, turnId, {
              state: "cancelled",
              stopReason: "cancelled",
              item: { prompt: promptParts, interrupted: true },
            }).pipe(Effect.asVoid),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );

        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS,
          // Background commands are quiet by nature; their own cap bounds the wait.
          currentIdleTimeoutMs: () =>
            ctx.backgroundWaitTurnId === turnId
              ? ANTIGRAVITY_BACKGROUND_MAX_WAIT_MS + ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS
              : ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: ANTIGRAVITY_TURN_WATCHDOG_INTERVAL_MS,
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

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (
          ctx.turnStarting ||
          ctx.finishingTurnId !== undefined ||
          (ctx.activeTurnId !== undefined && ctx.pendingTurnInterrupted)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Antigravity turn is still starting for this thread.",
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

    const steerTurn: NonNullable<AntigravityAdapterShape["steerTurn"]> = (input, options) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = ctx.activeTurnId;
        const prompt = yield* buildPromptParts(input);
        if (
          ctx.session.supportsNativeTurnSteering !== true ||
          turnId === undefined ||
          ctx.activeTurnId !== turnId ||
          (options?.expectedTurnId !== undefined && options.expectedTurnId !== turnId) ||
          ctx.pendingTurnInterrupted ||
          ctx.finishingTurnId !== undefined ||
          ctx.stopped
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/steer.stale",
            issue: "Antigravity has no active turn that supports live steering.",
          });
        }
        const reportDeliveryFailure = (detail: string) =>
          options?.onSteerDeliveryFailure?.(detail) ??
          Effect.gen(function* () {
            yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                message: "Antigravity could not deliver the steering message.",
                detail,
              },
            });
          });
        ctx.activeSteerRequests += 1;
        ctx.lastTurnActivityAt = Date.now();
        // Only the ACP call is interruptible so a rejected send can report its outcome.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() =>
            ctx.pendingTurnInterrupted ||
            ctx.finishingTurnId !== undefined ||
            ctx.stopped ||
            ctx.activeTurnId !== turnId
              ? reportDeliveryFailure("The active turn ended before the steering message was sent.")
              : restore(ctx.acp.prompt({ prompt }, { continueActiveTurn: true })).pipe(
                  Effect.tap((result) =>
                    Effect.gen(function* () {
                      if (result.stopReason !== "cancelled") return;
                      // Apply late tool failures before releasing the background wait.
                      yield* waitForQueuedTurnEventsDrained(ctx);
                      if (
                        ctx.activeTurnId !== turnId ||
                        ctx.pendingTurnInterrupted ||
                        ctx.finishingTurnId !== undefined ||
                        ctx.stopped ||
                        ctx.activeSteerCompletion?.state === "failed"
                      )
                        return;
                      ctx.activeSteerCompletion = {
                        ...classifyAcpPromptTurnCompletion({
                          stopReason: result.stopReason,
                          failedToolDetail: ctx.activeTurnFailedToolDetail,
                        }),
                        stopReason: result.stopReason,
                      };
                    }),
                  ),
                  Effect.catch((error) =>
                    error._tag === "AcpRequestError" ||
                    (!ctx.pendingTurnInterrupted && !ctx.stopped && ctx.activeTurnId === turnId)
                      ? reportDeliveryFailure(error.message)
                      : Effect.void,
                  ),
                ),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.activeSteerRequests -= 1;
              if (ctx.activeTurnId === turnId) ctx.lastTurnActivityAt = Date.now();
            }),
          ),
          Effect.forkIn(ctx.scope, { startImmediately: true }),
        );
        return { threadId: input.threadId, turnId, resumeCursor: ctx.acpSessionId };
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) return;
        if (ctx.finishingTurnId !== undefined) return;
        if (!ctx.turnStarting && ctx.activeTurnId === undefined) return;
        const activeTurnId = turnId ?? ctx.activeTurnId;
        ctx.pendingTurnInterrupted = true;
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            if (activeTurnId !== undefined && ctx.backgroundWaitTurnId === activeTurnId) {
              // The prompt already returned; only background commands remain.
              // agy stops a session's background tasks when it is closed, so
              // settle the turn and close the session; the next message
              // resumes the same conversation.
              if (ctx.activeSteerRequests > 0) {
                yield* ctx.acp.cancel.pipe(
                  Effect.timeoutOption(ANTIGRAVITY_CANCEL_GRACE_MS),
                  Effect.ignore,
                );
              }
              yield* settleTurn(ctx, activeTurnId, {
                state: "cancelled",
                stopReason: "cancelled",
                item: { prompt: activeTurnId, interrupted: true },
              });
              yield* stopSessionInternal(ctx, {
                exitKind: "graceful",
                reason: "Antigravity turn stopped; session closed to stop its background commands.",
                awaitTermination: false,
              });
              return;
            }
            // session/cancel ends the running prompt with its tool calls,
            // background tasks, and subagents.
            const result = yield* cancelTurnAndWait({
              cancel: ctx.acp.cancel,
              promptFiber: ctx.activePromptFiber,
              graceMs: ANTIGRAVITY_CANCEL_GRACE_MS,
            });
            if (activeTurnId !== undefined) {
              yield* settleTurn(ctx, activeTurnId, {
                state: "cancelled",
                stopReason: "cancelled",
                item: { prompt: activeTurnId, interrupted: true },
              });
            }
            if (
              result.prompt === "timedOut" ||
              result.cancelRequest !== "sent" ||
              ctx.activeSteerRequests > 0
            ) {
              yield* stopSessionInternal(ctx, {
                exitKind: "error",
                reason: "Antigravity did not stop the turn after cancellation.",
                awaitTermination: false,
              });
            }
          }),
        );
      });

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
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

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((ctx) => ({
          threadId,
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
          turns: snapshotProviderTurns(ctx.turns),
        })),
      );

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "Antigravity has no native rewind cursor; rollback restarts the session with retained transcript context.",
        });
      });

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
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
          }
        }),
      );

    const listLegacyModels: NonNullable<AntigravityAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const result = await runHelper(trim(input.binaryPath) ?? "agy", ["models"], {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            timeoutMs: ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS,
            ...(input.environment ? { environment: input.environment } : {}),
          });
          if (result.code !== 0) throw new Error(result.stderr || "agy models failed");
          const models = parseAntigravityModelLines(result.stdout);
          for (const model of models) {
            if (model.defaultReasoningEffort) {
              defaultEffortByModel.set(
                `${input.instanceId ?? PROVIDER}\0${model.slug}`,
                model.defaultReasoningEffort,
              );
            }
          }
          return {
            models,
            source: "antigravity.cli",
            cached: false,
          } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail:
              cause instanceof Error && cause.message.trim()
                ? cause.message
                : "Failed to list Antigravity models.",
            cause,
          }),
      });

    const listModels: NonNullable<AntigravityAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        const cwd = resolveAntigravitySessionCwd(input.cwd, serverConfig);
        if (!cwd) return yield* listLegacyModels(input);
        // A disposable session reads this instance's catalog without changing the active thread.
        const discovered = yield* Effect.gen(function* () {
          const acp = yield* makeRuntime({
            cwd,
            childProcessSpawner,
            antigravitySettings: {
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              environment: {
                ...input.environment,
                AGY_CLI_DISABLE_AUTO_UPDATE: "true",
                NO_BROWSER: "true",
              },
            },
            clientInfo: { name: "Synara", version: "0.0.0" },
          });
          yield* acp.handleRequestPermission(() =>
            Effect.succeed({ outcome: { outcome: "cancelled" } }),
          );
          const started = yield* acp
            .start()
            .pipe(Effect.timeoutOption(ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS));
          if (Option.isNone(started)) return undefined;
          const configOptions = yield* acp.getConfigOptions;
          const modelConfig = antigravityModelConfig(configOptions);
          if (!modelConfig) return undefined;
          const modelOptions = flattenConfigOptions(modelConfig.options);
          const descriptors = new Map<string, ReturnType<typeof buildAcpModelDescriptor>>();
          yield* Effect.forEach(
            modelOptions,
            (option) =>
              Effect.gen(function* () {
                const response = yield* acp.setConfigOption(modelConfig.id, option.value).pipe(
                  Effect.timeoutOption(1_000),
                  Effect.orElseSucceed(() => Option.none()),
                );
                const config = Option.getOrUndefined(response)?.configOptions;
                descriptors.set(
                  option.value,
                  buildAcpModelDescriptor(
                    option,
                    config ? antigravityThoughtLevelConfig(config) : undefined,
                  ),
                );
              }),
            { discard: true },
          ).pipe(Effect.timeoutOption(5_000));
          const models = modelOptions.map(
            (option) => descriptors.get(option.value) ?? buildAcpModelDescriptor(option, undefined),
          );
          return {
            models,
            source: "antigravity.acp",
            cached: false,
          } satisfies ProviderListModelsResult;
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => undefined),
        );
        return discovered ?? (yield* listLegacyModels(input));
      });

    const stopAll = () => settleConcurrentTeardowns(sessions.values(), stopSessionInternal);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      readThread,
      rollbackThread,
      stopAll,
      listModels,
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AntigravityAdapterShape;
  });
}

export function makeAntigravityAdapterLive(dependencies: AntigravityAdapterDependencies = {}) {
  return Layer.effect(AntigravityAdapter, makeAntigravityAdapter(dependencies));
}
