/**
 * KiroAdapterLive — Kiro CLI (`kiro-cli acp`) via ACP.
 *
 * Kiro speaks standard ACP over stdio. Model, effort and agent (ACP mode) are
 * selected in-session through config options before each turn; permission
 * requests always flow through Synara's policy so Plan turns can decline
 * mutations.
 *
 * @module KiroAdapterLive
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
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
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
  Semaphore,
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
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  resolveProviderSessionInstanceId,
} from "../Services/ProviderAdapter.ts";
import { KiroAdapter, type KiroAdapterShape } from "../Services/KiroAdapter.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  acpPromptUsageSnapshot,
  finalizeAcpActiveTurnCost,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  resolveRequestedAcpSessionModeId,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
  forkAcpAdapterTurnIdleWatchdog,
  type AcpSessionModeAliases,
} from "../acp/AcpAdapterSessionSupport.ts";
import type * as AcpErrors from "../acp/AcpErrors.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
  type AcpSessionStartupTimeouts,
} from "../acp/AcpSessionRuntime.ts";
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
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { resolveAcpTurnIdleTimeoutMs } from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyKiroAcpEffortSelection,
  applyKiroAcpModelSelection,
  applyKiroAcpSessionMode,
  discoverKiroAcpModels,
  makeKiroAcpRuntime,
  resolveKiroBinaryPath,
  type KiroAcpRuntimeSettings,
} from "../acp/KiroAcpSupport.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "kiro" as const;
export const resolveKiroStartInstanceId = resolveProviderSessionInstanceId;

export const takeKiroSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });

const KIRO_RESUME_VERSION = 1 as const;
// `kiro-cli acp` may refresh its login and load MCP servers before answering
// session/new, so session setup gets more room than the ACP default.
const KIRO_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 20_000,
  sessionSetupMs: 45_000,
  totalMs: 75_000,
} as const satisfies Partial<AcpSessionStartupTimeouts>;
const KIRO_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const KIRO_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const KIRO_DISCOVERY_CACHE_MAX_ENTRIES = 16;
// Backstop for an alive-but-silent child. Override with SYNARA_KIRO_TURN_IDLE_TIMEOUT_MS.
const KIRO_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_KIRO_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const KIRO_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const KIRO_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const KIRO_TURN_SETTLE_DRAIN_POLL_MS = 25;
// Kiro agents are ACP modes. `kiro_planner` is Kiro's built-in planning agent.
// Default turns return to the agent the session started with instead of
// forcing `kiro_default`, so a user's configured default agent is kept.
export const KIRO_ACP_SESSION_MODE_ALIASES = {
  plan: ["kiro_planner", "planner", "plan"],
  implement: ["kiro_default", "default"],
  approval: [],
} as const satisfies AcpSessionModeAliases;
const KIRO_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Kiro plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, reply with the final implementation plan in Markdown.",
].join("\n");

export interface KiroAdapterLiveOptions {
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

interface KiroSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly enableComputerControl?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly started: AcpSessionRuntimeStartResult;
  // Kiro agent the session started with; default turns return to it.
  initialModeId: string | undefined;
  // Tracked here because a direct `session/set_mode` bypasses the runtime's mode state.
  currentModeId: string | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly assistantItemTurnIds: Map<string, TurnId>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Assistant text of the active Plan turn; becomes the proposed plan.
  activePlanResponseText: string;
  latestContextUsage: ThreadTokenUsageSnapshot | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  sessionUpdatesProcessed: number;
  // Turns wait here until startup configuration finished under the thread lock.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  stopped: boolean;
}

export interface KiroResume {
  readonly sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseKiroResume(raw: unknown): KiroResume | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== KIRO_RESUME_VERSION) return undefined;
  const sessionId = optionalTrimmed(raw.sessionId);
  return sessionId ? { sessionId } : undefined;
}

export function isRenderableKiroAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.length > 0;
}

export function extractKiroTerminalPlanMarkdown(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly assistantText: string;
}): string | undefined {
  if (input.interactionMode !== "plan") return undefined;
  const planMarkdown = input.assistantText.trim();
  return planMarkdown.length > 0 ? planMarkdown : undefined;
}

/**
 * Plan turns use Kiro's planning agent when advertised. Other turns return to
 * the agent the session started with.
 */
export function resolveKiroTurnModeId(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly modeState: Parameters<typeof resolveRequestedAcpSessionModeId>[0]["modeState"];
  readonly initialModeId: string | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;
  const targetModeId =
    input.interactionMode === "plan"
      ? resolveRequestedAcpSessionModeId({
          interactionMode: "plan",
          runtimeMode: input.runtimeMode,
          modeState,
          aliases: KIRO_ACP_SESSION_MODE_ALIASES,
        })
      : (input.initialModeId ??
        resolveRequestedAcpSessionModeId({
          interactionMode: input.interactionMode,
          runtimeMode: input.runtimeMode,
          modeState,
          aliases: KIRO_ACP_SESSION_MODE_ALIASES,
        }));
  return targetModeId !== undefined && targetModeId !== modeState.currentModeId
    ? targetModeId
    : undefined;
}

function describeKiroErrorCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim();
  if (typeof cause === "string") return cause.trim();
  return "";
}

function describeKiroAcpErrorData(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (!isRecord(data)) return "";
  const detail = data.detail ?? data.details ?? data.message;
  return typeof detail === "string" && detail.trim() ? detail.trim() : "";
}

// Startup failures are the only signal the user gets about why Kiro did not
// come up, so keep the agent's own wording instead of a generic wrapper.
export function kiroAcpFailureDetail(error: AcpErrors.AcpError): string {
  if (error._tag === "AcpRequestError") {
    const message = error.errorMessage.trim();
    const data = describeKiroAcpErrorData(error.data);
    const detail = [message, data && data !== message ? data : ""].filter(Boolean).join(" — ");
    return detail || `Kiro ACP request failed (JSON-RPC ${String(error.code)}).`;
  }
  const causeDetail = describeKiroErrorCause(error.cause);
  const baseDetail =
    error._tag === "AcpTransportError" ? error.detail.trim() : error.message.trim();
  return [baseDetail, causeDetail && causeDetail !== baseDetail ? causeDetail : ""]
    .filter(Boolean)
    .join(" — ");
}

function kiroDiscoveryCacheKey(input: {
  readonly binaryPath: string;
  readonly instanceId?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}): string {
  return JSON.stringify({
    binaryPath: input.binaryPath,
    instanceId: input.instanceId ?? null,
    environment: input.environment
      ? Object.entries(input.environment).toSorted(([left], [right]) => left.localeCompare(right))
      : null,
  });
}

function resolveKiroAssistantItemTurnId(
  ctx: KiroSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) return ctx.activeTurnId;
  const knownTurnId = ctx.assistantItemTurnIds.get(itemId);
  if (knownTurnId !== undefined) return knownTurnId;
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
  }
  return ctx.activeTurnId;
}

function clearKiroActiveTurn(ctx: KiroSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) return false;
  ctx.activeTurnId = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  ctx.activePlanResponseText = "";
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

export function makeKiroAdapter(
  kiroSettings: KiroAcpRuntimeSettings,
  options?: KiroAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer.
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

    const sessions = new Map<ThreadId, KiroSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const discoveryLock = yield* Semaphore.make(1);
    const modelDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListModelsResult }
    >();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) => {
      const stamped = stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration);
      const providerInstanceId = sessions.get(event.threadId)?.session.providerInstanceId;
      return PubSub.publish(
        runtimeEventPubSub,
        providerInstanceId && stamped.providerInstanceId !== providerInstanceId
          ? { ...stamped, providerInstanceId }
          : stamped,
      ).pipe(Effect.asVoid);
    };

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

    const nativeSessionRefs = (
      ctx: KiroSessionContext,
    ): ProviderRuntimeEvent["providerRefs"] | undefined => {
      const sessionId = parseKiroResume(ctx.session.resumeCursor)?.sessionId;
      return sessionId === undefined ? undefined : { providerThreadId: sessionId };
    };

    const emitWarning = (input: {
      readonly threadId: ThreadId;
      readonly lifecycleGeneration: string | undefined;
      readonly message: string;
      readonly detail: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent(input.lifecycleGeneration, {
          type: "runtime.warning",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { message: input.message, detail: input.detail },
        });
      });

    const failTurnAsTimedOut = (ctx: KiroSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) return;
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!clearKiroActiveTurn(ctx, turnId)) return;
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const detail = `Kiro stopped responding (no activity for ${Math.round(idleMs / 1000)}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("kiro.acp.turn_idle_timeout", {
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
          payload: { state: "failed", stopReason: null, errorMessage: detail, ...completedCost },
        });
        yield* Effect.ignore(ctx.acp.cancel);
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KiroSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: KiroSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
          ctx.sessionConfigReady = undefined;
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        const providerInstanceId = ctx.session.providerInstanceId;
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(providerInstanceId ? { providerInstanceId } : {}),
          payload: { exitKind: "graceful" },
        });
      });

    const handleSessionEvents = (
      ctx: KiroSessionContext,
      lifecycleGeneration: string | undefined,
    ) =>
      Stream.runDrain(
        Stream.mapEffect(ctx.acp.getEvents(), (event) =>
          Effect.gen(function* () {
            // Any inbound ACP event proves the child is alive; reset the watchdog.
            ctx.lastTurnActivityAt = Date.now();
            switch (event._tag) {
              case "ModeChanged":
                ctx.currentModeId = event.modeId;
                return;
              case "AssistantItemStarted":
              case "AssistantItemCompleted": {
                const turnId = resolveKiroAssistantItemTurnId(ctx, event.itemId);
                if (event._tag === "AssistantItemCompleted") {
                  ctx.assistantItemTurnIds.delete(event.itemId);
                }
                yield* offerRuntimeEvent(
                  lifecycleGeneration,
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId,
                    itemId: event.itemId,
                    lifecycle:
                      event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                  }),
                );
                return;
              }
              case "PlanUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                if (!acceptAcpPlanUpdate(ctx, event.payload)) return;
                yield* offerRuntimeEvent(
                  lifecycleGeneration,
                  makeAcpPlanUpdatedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    payload: event.payload,
                    source: "acp.jsonrpc",
                    method: "session/update",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ToolCallUpdated": {
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
                  ctx.activeTurnFailedToolDetail = failedToolDetail;
                }
                yield* offerRuntimeEvent(
                  lifecycleGeneration,
                  makeAcpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              }
              case "ContentDelta": {
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                const turnId = resolveKiroAssistantItemTurnId(ctx, event.itemId);
                if (
                  turnId !== undefined &&
                  turnId === ctx.activeTurnId &&
                  ctx.activeInteractionMode === "plan" &&
                  isRenderableKiroAssistantDelta(event)
                ) {
                  ctx.activePlanResponseText += event.text;
                }
                yield* offerRuntimeEvent(
                  lifecycleGeneration,
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              }
              case "UsageUpdated": {
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                ctx.latestContextUsage = event.usage;
                recordAcpSessionCost(ctx, event.cost);
                const providerRefs = nativeSessionRefs(ctx);
                yield* offerRuntimeEvent(
                  lifecycleGeneration,
                  makeAcpTokenUsageEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    ...(providerRefs ? { providerRefs } : {}),
                    usage: event.usage,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              }
            }
          }).pipe(
            // Count the event only after its handler ran, so turn settlement
            // never observes it as consumed while its state is still applying.
            Effect.ensuring(
              Effect.sync(() => {
                ctx.sessionUpdatesProcessed += 1;
              }),
            ),
          ),
        ),
      );

    const startSession: KiroAdapterShape["startSession"] = (input) => {
      let registeredCtx: KiroSessionContext | undefined;
      const setup = withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const kiroModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const requestedModel = kiroModelSelection?.model.trim() || undefined;
          const requestedEffort = kiroModelSelection?.options?.reasoningEffort?.trim() || undefined;
          const resolvedProviderInstanceId = resolveKiroStartInstanceId(input);
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resume = parseKiroResume(input.resumeCursor);

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
          let ctx: KiroSessionContext | undefined;

          const providerKiroOptions = input.providerOptions?.kiro;
          const binaryPath = providerKiroOptions?.binaryPath ?? kiroSettings.binaryPath;
          const effectiveKiroSettings: KiroAcpRuntimeSettings = {
            homeDir: serverConfig.homeDir,
            isolationRootDir: serverConfig.stateDir,
            ...(resolvedProviderInstanceId !== undefined
              ? { instanceId: resolvedProviderInstanceId }
              : {}),
            ...(binaryPath !== undefined ? { binaryPath } : {}),
            ...(providerKiroOptions?.environment !== undefined
              ? { environment: providerKiroOptions.environment }
              : {}),
          };

          yield* Effect.logInfo("kiro.acp.start", {
            threadId: input.threadId,
            cwd,
            resume: resume !== undefined,
            model: requestedModel,
            reasoningEffort: requestedEffort,
            binaryPath: resolveKiroBinaryPath(binaryPath),
          });

          const acp = yield* makeKiroAcpRuntime({
            kiroSettings: effectiveKiroSettings,
            childProcessSpawner,
            cwd,
            ...(resume ? { resumeSessionId: resume.sessionId } : {}),
            clientInfo: { name: "Synara", version: "0.0.0" },
            startupTimeouts: KIRO_ACP_STARTUP_TIMEOUTS,
            ...(agentGatewayCredentials && gatewaySessionLease
              ? {
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
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: kiroAcpFailureDetail(cause),
                  cause,
                }),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              const policyOutcome = resolveAcpPermissionPolicy({
                runtimeMode: input.runtimeMode,
                interactionMode: ctx?.activeInteractionMode,
                options: params.options,
                computerControlEnabled: ctx?.enableComputerControl === true,
                activeTurn: ctx?.activeTurnId !== undefined,
                toolCall: params.toolCall,
              });
              if (policyOutcome !== undefined) {
                return { outcome: policyOutcome };
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
              const selectedOptionId =
                resolved === "cancel"
                  ? undefined
                  : selectAcpPermissionOptionId(resolved, params.options);
              return {
                outcome:
                  selectedOptionId === undefined
                    ? ({ outcome: "cancelled" } as const)
                    : ({ outcome: "selected", optionId: selectedOptionId } as const),
              };
            }),
          );

          const started = yield* acp.start().pipe(
            Effect.mapError((error) =>
              resume !== undefined && error._tag === "AcpRequestError"
                ? // A saved session Kiro can no longer load (deleted or from
                  // another profile): start fresh and carry the transcript.
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Kiro could not reopen session '${resume.sessionId}': ${kiroAcpFailureDetail(error)}`,
                    reason: "resume-state-unavailable",
                    cause: error,
                  })
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: `Kiro session startup failed: ${kiroAcpFailureDetail(error)}`,
                    cause: error,
                  }),
            ),
          );

          const sessionConfigReady = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            ...(resolvedProviderInstanceId
              ? { providerInstanceId: resolvedProviderInstanceId }
              : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(requestedModel ? { model: requestedModel } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: KIRO_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          const registered: KiroSessionContext = {
            enableComputerControl: input.enableComputerControl === true,
            threadId: input.threadId,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            started,
            initialModeId: undefined,
            currentModeId: undefined,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            assistantItemTurnIds: new Map(),
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            activePlanResponseText: "",
            latestContextUsage: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            sessionConfigReady,
            stopped: false,
          };
          ctx = registered;
          // The drain's lifetime is the session's, not the caller's.
          registered.notificationFiber = yield* handleSessionEvents(
            registered,
            input.lifecycleGeneration,
          ).pipe(Effect.forkIn(sessionScope));

          sessions.set(input.threadId, registered);
          registeredCtx = registered;
          sessionScopeTransferred = true;
          return { ctx: registered, session, requestedModel, requestedEffort, sessionConfigReady };
        }).pipe(Effect.scoped),
      );

      return Effect.gen(function* () {
        const { ctx, session, requestedModel, requestedEffort, sessionConfigReady } = yield* setup;
        // The replay wait runs without the thread lock so stop/restart can
        // close the registered scope instead of waiting for the hard cap.
        yield* ctx.acp.awaitLoadReplayReady.pipe(
          Effect.mapError((cause) =>
            ctx.stopped
              ? new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                })
              : mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
          ),
        );

        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            if (ctx.stopped || sessions.get(input.threadId) !== ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            ctx.initialModeId = (yield* ctx.acp.getModeState.pipe(
              Effect.orElseSucceed(() => undefined),
            ))?.currentModeId;
            ctx.currentModeId ??= ctx.initialModeId;
            yield* applySessionSelection(ctx, {
              model: requestedModel,
              reasoningEffort: requestedEffort,
            });
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: ctx.started.initializeResult },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Kiro ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: ctx.started.sessionId },
            });
          }),
        );

        return session;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || registeredCtx === undefined
            ? Effect.void
            : Effect.ignore(stopSessionInternal(registeredCtx)),
        ),
      );
    };

    // Selects model, then effort (Kiro advertises `effortLevel` per model). A
    // value Kiro does not offer is surfaced as a warning, not a failed turn.
    const applySessionSelection = (
      ctx: KiroSessionContext,
      selection: {
        readonly model: string | undefined;
        readonly reasoningEffort: string | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const warn = (message: string, detail: Record<string, unknown>) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("kiro.acp.selection_degraded", {
              threadId: ctx.threadId,
              ...detail,
            });
            yield* emitWarning({
              threadId: ctx.threadId,
              lifecycleGeneration: ctx.lifecycleGeneration,
              message,
              detail,
            });
          });
        if (selection.model !== undefined) {
          const outcome = yield* applyKiroAcpModelSelection({
            runtime: ctx.acp,
            started: ctx.started,
            model: selection.model,
          });
          if (outcome._tag === "NotAdvertised") {
            yield* warn(
              `Kiro does not offer the model '${selection.model}' for this account; the session continues on Kiro's current model.`,
              { reason: "model_not_advertised", requestedModel: selection.model },
            );
          }
        }
        if (selection.reasoningEffort !== undefined) {
          const outcome = yield* applyKiroAcpEffortSelection({
            runtime: ctx.acp,
            reasoningEffort: selection.reasoningEffort,
          });
          if (outcome._tag === "NotAdvertised") {
            yield* warn(
              `Kiro does not offer the '${selection.reasoningEffort}' effort for this model; it keeps its current effort.`,
              {
                reason: "effort_not_advertised",
                requestedEffort: selection.reasoningEffort,
                advertised: outcome.advertised,
              },
            );
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_config_option", cause),
        ),
      );

    // A failed agent switch must not fail the turn: Plan turns still carry the
    // plan prompt and Synara's permission policy declines mutating tools.
    const applyTurnMode = (ctx: KiroSessionContext, interactionMode: ProviderInteractionMode) =>
      Effect.gen(function* () {
        const modeState = yield* ctx.acp.getModeState.pipe(Effect.orElseSucceed(() => undefined));
        const modeId = resolveKiroTurnModeId({
          interactionMode,
          runtimeMode: ctx.session.runtimeMode,
          modeState:
            modeState === undefined
              ? undefined
              : { ...modeState, currentModeId: ctx.currentModeId ?? modeState.currentModeId },
          initialModeId: ctx.initialModeId,
        });
        if (modeId === undefined) return;
        const switched = yield* applyKiroAcpSessionMode({
          runtime: ctx.acp,
          sessionId: ctx.started.sessionId,
          modeId,
        }).pipe(Effect.result);
        if (switched._tag === "Success") {
          ctx.currentModeId = modeId;
          return;
        }
        const detail = kiroAcpFailureDetail(switched.failure);
        yield* Effect.logWarning("kiro.acp.mode_switch_failed", {
          threadId: ctx.threadId,
          modeId,
          detail,
        });
        yield* emitWarning({
          threadId: ctx.threadId,
          lifecycleGeneration: ctx.lifecycleGeneration,
          message:
            interactionMode === "plan"
              ? `Kiro could not switch to its '${modeId}' agent; this Plan turn runs on the current agent with mutations declined.`
              : `Kiro could not switch back to its '${modeId}' agent.`,
          detail: { reason: "mode_switch_failed", modeId, detail },
        });
      });

    const sendTurn: KiroAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model.trim() || ctx.session.model;
        yield* applySessionSelection(ctx, {
          model,
          reasoningEffort: turnModelSelection?.options?.reasoningEffort?.trim() || undefined,
        });
        if (model !== undefined && model !== ctx.session.model) {
          ctx.session = { ...ctx.session, model };
        }
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applyTurnMode(ctx, interactionMode);

        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim()
            ? withAcpPlanModePrompt({
                text: input.input.trim(),
                interactionMode,
                promptPrefix: KIRO_PLAN_MODE_PROMPT_PREFIX,
              })
            : undefined,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({ type: "text", text: promptText });
        }
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeKiroSynaraHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }
        // A stop can land during the mode switch or attachment reads above.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.activeInteractionMode = interactionMode;
        ctx.activePlanResponseText = "";
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
          payload: model ? { model } : {},
        });

        const drainQueuedTurnEvents = waitForAcpQueuedTurnEventsDrained({
          sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
          sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
          maxWaitMs: KIRO_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
          pollMs: KIRO_TURN_SETTLE_DRAIN_POLL_MS,
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* drainQueuedTurnEvents;
                if (ctx.activeTurnId !== turnId) return;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearKiroActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
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
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                // Drain before snapshotting: queued updates may still add plan
                // text or a failed-tool detail to this turn.
                yield* drainQueuedTurnEvents;
                if (ctx.activeTurnId !== turnId) return;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                const planMarkdown =
                  result.stopReason === "cancelled"
                    ? undefined
                    : extractKiroTerminalPlanMarkdown({
                        interactionMode: ctx.activeInteractionMode,
                        assistantText: ctx.activePlanResponseText,
                      });
                if (planMarkdown !== undefined) {
                  yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { planMarkdown },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "synara.kiro.terminal-plan-response",
                      payload: result,
                    },
                  });
                }
                if (!clearKiroActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                };
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                const promptUsage = acpPromptUsageSnapshot(result.usage, ctx.latestContextUsage);
                if (promptUsage !== undefined) {
                  const providerRefs = nativeSessionRefs(ctx);
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpTokenUsageEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      ...(providerRefs ? { providerRefs } : {}),
                      usage: promptUsage,
                      rawPayload: result,
                    }),
                  );
                }
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
              if (!clearKiroActiveTurn(ctx, turnId)) return;
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state: "cancelled", stopReason: "cancelled", ...completedCost },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        // Backstop: fail a turn whose child goes silent instead of leaving it
        // "Working" forever. Pauses while a human approval is pending.
        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: KIRO_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: KIRO_TURN_WATCHDOG_INTERVAL_MS,
          onIdleTimeout: (idleMs) => failTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: KiroAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning("kiro.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            const activePromptFiber = ctx.activePromptFiber;
            yield* Effect.ignore(ctx.acp.cancel);
            if (activePromptFiber) {
              yield* Fiber.interrupt(activePromptFiber);
            }
          }),
        );
      });

    const respondToRequest: KiroAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: KiroAdapterShape["respondToUserInput"] = (
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
            method: "user-input/respond",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: KiroAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const rollbackThread: KiroAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const stopSession: KiroAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: KiroAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: KiroAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<KiroAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    // Discovery runs a disposable `kiro-cli acp` session and reads the model
    // catalog Kiro advertises for the signed-in account.
    const listModels: NonNullable<KiroAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const binaryPath = input.binaryPath?.trim() || kiroSettings.binaryPath;
          const cacheKey = kiroDiscoveryCacheKey({
            binaryPath: resolveKiroBinaryPath(binaryPath),
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            ...(input.environment ? { environment: input.environment } : {}),
          });
          const cached = modelDiscoveryCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }
          const runtime = yield* makeKiroAcpRuntime({
            kiroSettings: {
              homeDir: serverConfig.homeDir,
              isolationRootDir: serverConfig.stateDir,
              ...(binaryPath ? { binaryPath } : {}),
              ...(input.instanceId ? { instanceId: input.instanceId } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            },
            childProcessSpawner,
            cwd:
              resolveAcpSessionCwd({
                inputCwd: input.cwd,
                serverCwd: serverConfig.cwd,
                homeDir: serverConfig.homeDir,
              }) ?? serverConfig.homeDir,
            clientInfo: { name: "Synara Model Discovery", version: "0.0.0" },
            startupTimeouts: KIRO_ACP_STARTUP_TIMEOUTS,
          });
          const started = yield* runtime.start();
          const result = yield* discoverKiroAcpModels({ runtime, started });
          if (modelDiscoveryCache.size >= KIRO_DISCOVERY_CACHE_MAX_ENTRIES) {
            const oldestKey = modelDiscoveryCache.keys().next().value;
            if (oldestKey !== undefined) modelDiscoveryCache.delete(oldestKey);
          }
          modelDiscoveryCache.set(cacheKey, {
            expiresAt: Date.now() + KIRO_MODEL_DISCOVERY_CACHE_MS,
            result,
          });
          return result;
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(KIRO_MODEL_DISCOVERY_TIMEOUT_MS),
          Effect.mapError((cause) =>
            mapAcpToAdapterError(
              PROVIDER,
              ThreadId.makeUnsafe("kiro-model-discovery"),
              "model/list",
              cause,
            ),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "model/list",
                    detail: "Timed out while discovering Kiro models via ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );

    const stopAll = () => settleConcurrentTeardowns(sessions.values(), stopSessionInternal);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listModels,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies KiroAdapterShape;
  });
}

export const KiroAdapterLive = Layer.effect(KiroAdapter, makeKiroAdapter({}));

export function makeKiroAdapterLive(
  kiroSettings: KiroAcpRuntimeSettings = {},
  options?: KiroAdapterLiveOptions,
) {
  return Layer.effect(KiroAdapter, makeKiroAdapter(kiroSettings, options));
}
