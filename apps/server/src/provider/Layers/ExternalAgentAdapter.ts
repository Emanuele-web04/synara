/**
 * ExternalAgentAdapterLive - Profile-driven external agent via ACP.
 *
 * Unlike built-in adapters, the spawn command/args/env are not fixed: they come
 * from a resolved `ExternalAgentSessionLaunch` (profile + revision + expanded
 * credential env) handed to `startSession` via
 * `ProviderSessionStartInput.externalAgentLaunch`. The adapter feeds that launch
 * into the shared `AcpSessionRuntime` (which is already parameterized by spawn
 * command/args/env/cwd) and drives the standard ACP handshake + turn loop.
 *
 * @module ExternalAgentAdapterLive
 */
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

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
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import type { ExternalAgentSessionLaunch } from "../../externalAgents/AgentProfileService.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
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
  buildAcpGatewayMcpServers,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionStartupTimeouts,
} from "../acp/AcpSessionRuntime.ts";
import { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
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
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import { ExternalAgentAdapter } from "../Services/ExternalAgentAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "external" as const;

export const takeExternalSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });

// External agents are arbitrary user-configured connectors, so startup budgets
// stay generous (a slow upstream or auth handshake is expected) but bounded so a
// stuck child cannot hold a thread forever.
const EXTERNAL_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 30_000,
  authenticateMs: 30_000,
  sessionSetupMs: 30_000,
  totalMs: 90_000,
} as const satisfies AcpSessionStartupTimeouts;

// Backstop for an alive-but-silent external child. Generous by design so
// legitimate long, quiet tool runs are not killed; override per workload.
const EXTERNAL_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_EXTERNAL_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const EXTERNAL_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const EXTERNAL_ACP_REQUEST_TIMEOUT_MS = 30_000;

export interface ExternalAgentAdapterLiveOptions {
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

/**
 * External agent session state machine over the ACP runtime, keyed by threadId.
 * Same shape Cursor uses, parameterized by profileId/revisionId instead of
 * cursor-specific fields. Holds the ACP runtime, the session, pending
 * approvals/userInputs, turns, and active-turn state.
 */
interface ExternalAgentSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly profileId: string;
  readonly revisionId: string;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly assistantItemTurnIds: Map<string, TurnId>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

interface ExternalAgentLaunchSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function resolveExternalAssistantItemTurnId(
  ctx: ExternalAgentSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) {
    return ctx.activeTurnId;
  }
  const knownTurnId = ctx.assistantItemTurnIds.get(itemId);
  if (knownTurnId !== undefined) {
    return knownTurnId;
  }
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
    return ctx.activeTurnId;
  }
  return ctx.assistantItemTurnIds.get(itemId);
}

/**
 * Extracts the spawn spec from a resolved profile launch. Only the `command`
 * connector kind is launchable; `endpoint` connectors are not yet supported
 * (they would need a transport-bridging runtime, not a stdio child).
 */
function resolveExternalLaunchSpawn(input: {
  readonly launch: ExternalAgentSessionLaunch;
  readonly cwd: string;
}): ExternalAgentLaunchSpawn | undefined {
  const { launch } = input;
  if (launch.revision.launch.kind !== "command") {
    return undefined;
  }
  const command = launch.revision.launch.command.trim();
  if (!command) {
    return undefined;
  }
  const args = launch.revision.launch.args ?? [];
  const cwd = launch.revision.launch.cwd?.trim()
    ? nodePath.resolve(launch.revision.launch.cwd.trim())
    : input.cwd;
  return {
    command,
    args,
    cwd,
    env: { ...launch.env },
  };
}

function externalAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `External agent did not respond to ${method} within ${EXTERNAL_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

/**
 * Builds the ACP runtime from a profile launch. Mirrors the per-provider
 * `makeXAcpRuntime` factories, but the spawn command/args/env come from the
 * profile revision instead of a fixed binary lookup.
 */
function makeExternalAgentAcpRuntime(input: {
  readonly spawn: ExternalAgentLaunchSpawn;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly agentGatewayCredentials:
    | { readonly stdioProxy: import("../../agentGateway/Services/AgentGatewayCredentials.ts").AgentGatewayStdioProxySpawn }
    | undefined;
  readonly resumeSessionId?: string;
}): Effect.Effect<AcpSessionRuntimeShape, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: input.spawn.command,
          args: [...input.spawn.args],
          cwd: input.spawn.cwd,
          env: input.spawn.env,
        },
        cwd: input.spawn.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "Synara", version: "0.0.0" },
        startupTimeouts: EXTERNAL_ACP_STARTUP_TIMEOUTS,
        ...buildAcpGatewayMcpServers({
          gatewaySessionLease: input.gatewaySessionLease,
          agentGatewayCredentials: input.agentGatewayCredentials,
        }),
        ...makeAcpNativeLoggers({
          nativeEventLogger: input.nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return acpContext.get(AcpSessionRuntime);
  });
}

export function makeExternalAgentAdapter(options?: ExternalAgentAdapterLiveOptions) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
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

    const sessions = new Map<ThreadId, ExternalAgentSessionContext>();
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
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: randomUUID(),
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

    const stopSessionInternal = (
      ctx: ExternalAgentSessionContext,
      cleanup?: { readonly exitKind?: "error" | "normal"; readonly reason?: string },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        ctx.stopped = true;
        ctx.notificationFiber = undefined;
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals).pipe(Effect.ignore);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs).pipe(Effect.ignore);
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId).pipe(Effect.ignore);
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        ctx.session = {
          ...sessionWithoutActiveTurn,
          status: "closed",
          updatedAt: yield* nowIso,
          ...(cleanup?.exitKind === "error" && cleanup.reason
            ? { lastError: cleanup.reason }
            : {}),
        };
        yield* Effect.ignore(ctx.acp.cancel);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const requireSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const completeAssistantItemTurnId = (ctx: ExternalAgentSessionContext, itemId: string) => {
      const turnId = resolveExternalAssistantItemTurnId(ctx, itemId);
      ctx.assistantItemTurnIds.delete(itemId);
      return turnId;
    };

    const startSession: ExternalAgentAdapter["startSession"] = (input) =>
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
          const launch = input.externalAgentLaunch as ExternalAgentSessionLaunch | undefined;
          if (launch === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "External agent session start requires a resolved profile launch (externalAgentLaunch).",
            });
          }
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            sessionCwd: launch.revision.launch.kind === "command" ? launch.revision.launch.cwd : undefined,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir ?? "",
          });
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const spawn = resolveExternalLaunchSpawn({ launch, cwd });
          if (spawn === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `External agent profile '${launch.profile.name}' uses an unsupported launch kind; only command launches are supported.`,
            });
          }

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
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: ExternalAgentSessionContext;

          const externalModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const resumeSessionId = parseExternalResume(input.resumeCursor)?.sessionId;

          const acp = yield* makeExternalAgentAcpRuntime({
            spawn,
            childProcessSpawner,
            nativeEventLogger,
            threadId: input.threadId,
            gatewaySessionLease,
            agentGatewayCredentials,
            ...(resumeSessionId ? { resumeSessionId } : {}),
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error
                ? new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to start external agent '${launch.profile.name}': ${cause.message}`,
                    cause,
                  })
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
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
              });
              if (policyOutcome !== undefined) {
                return policyOutcome.outcome === "selected"
                  ? { outcome: { outcome: "selected" as const, optionId: policyOutcome.optionId } }
                  : { outcome: { outcome: "cancelled" as const } };
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
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
              if (resolved === "cancel") {
                return { outcome: { outcome: "cancelled" as const } };
              }
              const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
              return selectedOptionId === undefined
                ? { outcome: { outcome: "cancelled" as const } }
                : { outcome: { outcome: "selected" as const, optionId: selectedOptionId } };
            }),
          );

          yield* acp.handleElicitation((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/elicitation", params);
              const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
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
                payload: { params },
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
              // Decline non-form elicitations: external connectors vary widely,
              // so a structured answer is only returned when the request is a
              // form the user answered. Empty answers decline politely.
              return { action: "decline" as const };
            }),
          );

          const startedOption = yield* acp
            .start()
            .pipe(Effect.timeoutOption(EXTERNAL_ACP_REQUEST_TIMEOUT_MS));
          const started = yield* Option.match(startedOption, {
            onNone: () => Effect.fail(externalAcpTimeoutError("session/start")),
            onSome: Effect.succeed,
          });

          if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail:
                "External agent could not resume the requested native session and a fresh fallback was refused to avoid losing conversation context.",
            });
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: externalModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: EXTERNAL_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            profileId: launch.profile.profileId,
            revisionId: launch.revision.revisionId,
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
            assistantItemTurnIds: new Map(),
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                ctx.lastTurnActivityAt = Date.now();
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    return;
                  case "AssistantItemCompleted": {
                    const activeTurnId = resolveExternalAssistantItemTurnId(ctx, event.itemId);
                    if (activeTurnId === undefined) return;
                    const scopedItemId = scopeAcpRuntimeItemIdForTurn(PROVIDER, activeTurnId, event.itemId);
                    if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                      return;
                    }
                    ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                    completeAssistantItemTurnId(ctx, event.itemId);
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        itemId: scopedItemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "ContentDelta": {
                    const activeTurnId = resolveExternalAssistantItemTurnId(ctx, event.itemId);
                    if (activeTurnId === undefined) return;
                    if (event.text.length === 0) return;
                    const itemId = event.itemId
                      ? scopeAcpRuntimeItemIdForTurn(PROVIDER, activeTurnId, event.itemId)
                      : undefined;
                    if (itemId) {
                      ctx.activeAssistantItemsWithContent.add(itemId);
                    }
                    ctx.activeTurnHadAssistantContent = true;
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        ...(itemId ? { itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated": {
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId === undefined) return;
                    const fingerprint = `${activeTurnId}:${JSON.stringify(event.payload)}`;
                    if (ctx.lastPlanFingerprint === fingerprint) return;
                    ctx.lastPlanFingerprint = fingerprint;
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated": {
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId === undefined) return;
                    const scoped = scopeAcpToolCallStateForTurn(PROVIDER, activeTurnId, event.toolCall);
                    const failedDetail = readAcpFailedToolDetail(event.toolCall);
                    if (failedDetail !== undefined) {
                      ctx.activeTurnFailedToolDetail = failedDetail;
                    }
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        toolCall: scoped,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "UsageUpdated": {
                    recordAcpSessionCost(ctx, event.cost);
                    const activeTurnId = ctx.activeTurnId;
                    yield* offerRuntimeEvent(
                      ctx.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                }
              }),
            ),
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning("external.acp.notification_stream_failed", {
                threadId: ctx.threadId,
                cause: String(cause),
              }),
            ),
            Effect.forkIn(sessionScope),
          );
          ctx.notificationFiber = notificationFiber;
          sessionScopeTransferred = true;
          sessions.set(input.threadId, ctx);
          return ctx.session;
        }),
      );

    const sendTurn: ExternalAgentAdapter["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const runtimeMode = ctx.session.runtimeMode;
          if (runtimeMode === "auto") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Auto runtime mode is available only to Codex and Claude.",
            });
          }
          const turnId = TurnId.makeUnsafe(randomUUID());
          const turnModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);

          const promptText = appendFileAttachmentsPromptBlock({
            text: appendProviderReferencesPromptBlock({
              text: input.input?.trim() ? input.input.trim() : undefined,
              mentions: input.mentions,
            }),
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          });
          const promptParts: Array<Acp.ContentBlock> = [];
          if (promptText) {
            promptParts.push({ type: "text", text: promptText });
          }
          promptParts.push(
            ...(yield* loadProviderPromptImageBlocks({
              attachments: input.attachments,
              attachmentsDir: serverConfig.attachmentsDir,
              provider: PROVIDER,
              method: "session/prompt",
              readFile: (path) => fileSystem.readFile(path),
            })),
          );
          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          const harnessPolicy = takeExternalSynaraHarnessPolicyTextPart(
            ctx,
            agentGatewayCredentials !== undefined,
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

          ctx.activeTurnId = turnId;
          ctx.activeTurnHadAssistantContent = false;
          ctx.activeAssistantItemsWithContent.clear();
          ctx.activeTurnFailedToolDetail = undefined;
          ctx.assistantItemTurnIds.clear();
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
            ctx.stopped ? Effect.interrupt : ctx.acp.prompt({ prompt: promptParts }),
          ).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

          const promptFiber = yield* runPrompt.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  if (ctx.activeTurnId !== turnId) return;
                  yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                  if (!clearExternalActiveTurn(ctx, turnId)) return;
                  const completedCost = finalizeExternalActiveTurnCost(ctx);
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                  const detail = error.message;
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
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
                  yield* stopSessionInternal(ctx, { exitKind: "error", reason: detail });
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                  const failedToolDetail = ctx.activeTurnFailedToolDetail;
                  if (ctx.activeTurnId !== turnId) return;
                  yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                  if (!clearExternalActiveTurn(ctx, turnId)) return;
                  const completedCost = finalizeExternalActiveTurnCost(ctx);
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
                    status: "ready",
                    updatedAt: yield* nowIso,
                    ...(model ? { model } : {}),
                  };
                  if (!hadAssistantContent && result.stopReason !== "cancelled") {
                    yield* Effect.logWarning("external.acp.turn_completed_without_content", {
                      threadId: input.threadId,
                      turnId,
                      stopReason: result.stopReason ?? null,
                    });
                  }
                  const completion = classifyExternalPromptTurnCompletion({
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
            Effect.forkIn(ctx.scope),
          );
          ctx.activePromptFiber = promptFiber;

          // Idle-progress watchdog: force-fail a silently hung turn so the UI
          // never shows "Working" forever on an alive-but-silent external child.
          yield* forkAcpTurnIdleWatchdog({
            idleTimeoutMs: EXTERNAL_TURN_IDLE_TIMEOUT_MS,
            checkIntervalMs: EXTERNAL_TURN_WATCHDOG_INTERVAL_MS,
            scope: ctx.scope,
            isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
            isAwaitingHuman: () =>
              ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
            lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
            touchActivity: () => {
              ctx.lastTurnActivityAt = Date.now();
            },
            onIdleTimeout: (idleMs) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                yield* Fiber.interrupt(promptFiber);
                yield* Effect.logWarning("external.acp.turn_idle_timeout", {
                  threadId: input.threadId,
                  turnId,
                  idleMs,
                });
              }),
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn: ExternalAgentAdapter["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          if (turnId !== undefined && ctx.activeTurnId !== turnId) return;
          const promptFiber = ctx.activePromptFiber;
          if (promptFiber) {
            yield* Fiber.interrupt(promptFiber);
          }
          if (ctx.activeTurnId !== undefined) {
            yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
            clearExternalActiveTurn(ctx, ctx.activeTurnId);
            const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
            ctx.session = {
              ...sessionWithoutLastError,
              status: "ready",
              updatedAt: yield* nowIso,
            };
          }
        }),
      );

    const respondToRequest: ExternalAgentAdapter["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `No pending approval request '${requestId}' for thread '${threadId}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ExternalAgentAdapter["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `No pending user-input request '${requestId}' for thread '${threadId}'.`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ExternalAgentAdapter["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
          sessions.delete(threadId);
        }),
      );

    const listSessions: ExternalAgentAdapter["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    const hasSession: ExternalAgentAdapter["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: ExternalAgentAdapter["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        };
      });

    const rollbackThread: ExternalAgentAdapter["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (numTurns <= 0) {
          return {
            threadId,
            turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
            ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
          };
        }
        // External agents do not support native history rollback; trim the
        // in-memory turn log so the snapshot reflects the requested state. A
        // full rollback requires a session restart, which the caller drives.
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        };
      });

    const stopAll: ExternalAgentAdapter["stopAll"] = () =>
      Effect.gen(function* () {
        const threadIds = Array.from(sessions.keys());
        yield* Effect.forEach(threadIds, (threadId) => stopSession(threadId), { discard: true });
      });

    if (managedNativeEventLogger !== undefined) {
      yield* Scope.addFinalizer(() => managedNativeEventLogger.close().pipe(Effect.ignore));
    }

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ExternalAgentAdapter["Type"];
  });
}

const EXTERNAL_RESUME_VERSION = 1 as const;

function parseExternalResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== EXTERNAL_RESUME_VERSION) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  return { sessionId: value.sessionId.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void isRecord;

function clearExternalActiveTurn(
  ctx: ExternalAgentSessionContext,
  turnId: TurnId,
): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }
  ctx.activeTurnId = undefined;
  ctx.activeTurnHadAssistantContent = false;
  ctx.activeAssistantItemsWithContent.clear();
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function finalizeExternalActiveTurnCost(ctx: ExternalAgentSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function classifyExternalPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  return classifyAcpPromptTurnCompletion(input);
}

export const ExternalAgentAdapterLive = Layer.effect(
  ExternalAgentAdapter,
  makeExternalAgentAdapter(),
);

export function makeExternalAgentAdapterLive(
  options?: ExternalAgentAdapterLiveOptions,
) {
  return Layer.effect(ExternalAgentAdapter, makeExternalAgentAdapter(options));
}
