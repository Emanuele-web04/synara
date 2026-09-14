/** Cline CLI over ACP. Authentication and model catalogs remain provider-owned. */
import type * as Acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@synara/contracts";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import { takeSynaraHarnessPolicyTextPartForProviderSession } from "../../agentGateway/harnessPolicy.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  withAgentGatewayTurnCancellation,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  readAcpFailedToolDetail,
  mapAcpToAdapterError,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
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
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { makeAcpNativeLoggers, redactAcpLogSecrets } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest, type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { isAcpTurnProgressEventTag } from "../acp/AcpTurnIdleWatchdog.ts";
import {
  clineDefaultModel,
  configureClineSession,
  makeClineAcpRuntime,
  mapClineModels,
  parseClineResumeCursor,
  type ClineAcpRuntimeSettings,
} from "../acp/ClineAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { ClineAdapter, type ClineAdapterShape } from "../Services/ClineAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "cline" as const;
const CAPABILITIES: ProviderComposerCapabilities = {
  provider: PROVIDER,
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: true,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
};

export interface ClineAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeAcpRuntime?: typeof makeClineAcpRuntime;
}

interface ClineSessionContext {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string | undefined;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly teardownComplete: Deferred.Deferred<void, ProviderAdapterError>;
  readonly pendingApprovals: Map<
    ApprovalRequestId,
    { decision: Deferred.Deferred<ProviderApprovalDecision> }
  >;
  readonly pendingUserInputs: Map<
    ApprovalRequestId,
    { answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >;
  readonly turns: ProviderThreadTurnSnapshot[];
  readonly activeTools: Set<string>;
  session: ProviderSession;
  defaultModel: string | undefined;
  activeTurnId: TurnId | undefined;
  activeInteractionMode: ProviderInteractionMode;
  activeItems: unknown[];
  failedToolDetail: string | undefined;
  lastPlanFingerprint: string | undefined;
  latestSessionCostUsd: number | undefined;
  lastTurnActivityAt: number | undefined;
  sessionUpdatesProcessed: number;
  turnStarting: boolean;
  pendingTurnInterrupted: boolean;
  stopped: boolean;
  harnessPolicyDelivered?: boolean;
}

const stamp = () => ({
  eventId: EventId.makeUnsafe(crypto.randomUUID()),
  createdAt: new Date().toISOString(),
});
const validation = (operation: string, issue: string) =>
  new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
const requestError = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: PROVIDER, method, detail });

export function makeClineAdapter(
  settings: ClineAcpRuntimeSettings = {},
  options: ClineAdapterLiveOptions = {},
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const makeRuntime = options.makeAcpRuntime ?? makeClineAcpRuntime;
    const sessions = new Map<ThreadId, ClineSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const discoveryLock = yield* Semaphore.make(1);
    const events = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));

    const emit = (ctx: ClineSessionContext, event: ProviderRuntimeEvent) =>
      PubSub.publish(
        events,
        stampAcpRuntimeEventLifecycleGeneration(event, ctx.lifecycleGeneration),
      ).pipe(Effect.asVoid);
    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx && !ctx.stopped
          ? Effect.succeed(ctx)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
      });
    const bounded = <A, E>(effect: Effect.Effect<A, E>, method: string) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          onTimeout: () => Effect.fail(requestError(method, "Cline request timed out.")),
        }),
      );

    const finishTurn = (
      ctx: ClineSessionContext,
      turnId: TurnId,
      payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"],
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId !== turnId) return;
        // Clear ownership before yielding: cancel/exit/prompt may all try to settle.
        ctx.activeTurnId = undefined;
        ctx.activeTools.clear();
        ctx.turns.push({ id: turnId, items: [...ctx.activeItems] });
        ctx.activeItems = [];
        const { activeTurnId: _active, lastError: _error, ...session } = ctx.session;
        ctx.session = {
          ...session,
          status: payload.state === "failed" ? "error" : "ready",
          updatedAt: new Date().toISOString(),
          ...(payload.errorMessage ? { lastError: payload.errorMessage } : {}),
        };
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* emit(ctx, {
          type: "turn.completed",
          ...stamp(),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { ...payload, ...finalizeAcpActiveTurnCost(ctx) },
        });
      });

    const stopInternal = (
      ctx: ClineSessionContext,
      reason?: string,
      wait = true,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!ctx.stopped) {
            ctx.stopped = true;
            ctx.pendingTurnInterrupted = true;
            ctx.gatewaySessionLease?.release();
            if (ctx.activeTurnId)
              yield* finishTurn(ctx, ctx.activeTurnId, {
                state: reason ? "failed" : "cancelled",
                stopReason: "cancelled",
                ...(reason ? { errorMessage: reason } : {}),
              });
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            // A prompt/exit consumer can request cleanup of its own scope. A separate
            // fiber closes it, while callers outside that scope await the barrier.
            yield* Scope.close(ctx.scope, Exit.void).pipe(
              Effect.matchCauseEffect({
                onFailure: () =>
                  Deferred.fail(
                    ctx.teardownComplete,
                    requestError(
                      "session/stop",
                      "Cline process cleanup failed; restart Synara before retrying.",
                    ),
                  ),
                onSuccess: () =>
                  Effect.gen(function* () {
                    if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
                    yield* emit(ctx, {
                      type: "session.exited",
                      ...stamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: {
                        exitKind: reason ? "error" : "graceful",
                        ...(reason ? { reason } : {}),
                      },
                    });
                    yield* Deferred.succeed(ctx.teardownComplete, undefined);
                  }),
              }),
              Effect.forkDetach,
            );
          }
          if (wait) yield* restore(Deferred.await(ctx.teardownComplete));
        }),
      );

    const processEvent = (ctx: ClineSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (ctx.stopped || turnId === undefined) return; // Includes session/load replay.
        if (isAcpTurnProgressEventTag(event._tag)) ctx.lastTurnActivityAt = Date.now();
        const common = { stamp: stamp(), provider: PROVIDER, threadId: ctx.threadId, turnId };
        let mapped: ProviderRuntimeEvent | undefined;
        switch (event._tag) {
          case "AssistantItemStarted":
          case "AssistantItemCompleted":
            mapped = makeAcpAssistantItemEvent({
              ...common,
              itemId: scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId),
              lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
            });
            break;
          case "ContentDelta":
            mapped = makeAcpContentDeltaEvent({
              ...common,
              text: event.text,
              ...(event.itemId
                ? { itemId: scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, event.itemId) }
                : {}),
              ...(event.streamKind ? { streamKind: event.streamKind } : {}),
              rawPayload: event.rawPayload,
            });
            break;
          case "ToolCallUpdated":
            ctx.failedToolDetail = readAcpFailedToolDetail(event.toolCall) ?? ctx.failedToolDetail;
            if (event.toolCall.status === "pending" || event.toolCall.status === "inProgress")
              ctx.activeTools.add(event.toolCall.toolCallId);
            else if (event.toolCall.status === "completed" || event.toolCall.status === "failed")
              ctx.activeTools.delete(event.toolCall.toolCallId);
            mapped = makeAcpToolCallEvent({
              ...common,
              toolCall: scopeAcpToolCallStateForTurn(PROVIDER, turnId, event.toolCall),
              rawPayload: event.rawPayload,
            });
            break;
          case "PlanUpdated":
            if (acceptAcpPlanUpdate(ctx, event.payload))
              mapped = makeAcpPlanUpdatedEvent({
                ...common,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              });
            break;
          case "UsageUpdated":
            recordAcpSessionCost(ctx, event.cost);
            mapped = makeAcpTokenUsageEvent({
              ...common,
              usage: event.usage,
              rawPayload: event.rawPayload,
            });
            break;
          case "ModeChanged":
            break;
        }
        if (mapped) {
          ctx.activeItems.push(mapped);
          yield* emit(ctx, mapped);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.sessionUpdatesProcessed += 1;
          }),
        ),
      );

    const registerInteractions = (ctx: ClineSessionContext) =>
      Effect.gen(function* () {
        yield* ctx.acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            if (ctx.stopped || ctx.activeTurnId === undefined)
              return { outcome: { outcome: "cancelled" as const } };
            const policy = resolveAcpPermissionPolicy({
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: ctx.activeInteractionMode,
              options: params.options,
            });
            if (policy) return { outcome: policy };
            const permissionRequest = parsePermissionRequest(params);
            const id = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const requestId = RuntimeRequestId.makeUnsafe(id);
            const turnId = ctx.activeTurnId;
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            ctx.pendingApprovals.set(id, { decision });
            return yield* Effect.gen(function* () {
              yield* emit(
                ctx,
                makeAcpRequestOpenedEvent({
                  stamp: stamp(),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  requestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? "Cline requests permission.",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              yield* emit(
                ctx,
                makeAcpRequestResolvedEvent({
                  stamp: stamp(),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  requestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const optionId =
                resolved === "cancel"
                  ? undefined
                  : selectAcpPermissionOptionId(resolved, params.options);
              return {
                outcome: optionId
                  ? { outcome: "selected" as const, optionId }
                  : { outcome: "cancelled" as const },
              };
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.pendingApprovals.delete(id);
                }),
              ),
            );
          }),
        );
        yield* ctx.acp.handleElicitation((params) =>
          Effect.gen(function* () {
            if (ctx.stopped || ctx.activeTurnId === undefined || !isFormElicitationRequest(params))
              return { action: "decline" as const };
            const questions = elicitationQuestionsFromRequest(params);
            if (!questions.length) return { action: "decline" as const };
            const id = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const requestId = RuntimeRequestId.makeUnsafe(id);
            const turnId = ctx.activeTurnId;
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            ctx.pendingUserInputs.set(id, { answers });
            return yield* Effect.gen(function* () {
              yield* emit(ctx, {
                type: "user-input.requested",
                ...stamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                requestId,
                payload: { questions },
              });
              const resolved = yield* Deferred.await(answers);
              yield* emit(ctx, {
                type: "user-input.resolved",
                ...stamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                requestId,
                payload: { answers: resolved },
              });
              return elicitationResponseFromAnswers(params, resolved);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.pendingUserInputs.delete(id);
                }),
              ),
            );
          }),
        );
      });

    const startSession: ClineAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (
            (input.provider !== undefined && input.provider !== PROVIDER) ||
            (input.modelSelection && input.modelSelection.provider !== PROVIDER)
          ) {
            return yield* validation(
              "startSession",
              "Cline requires a Cline provider/model selection.",
            );
          }
          if (input.runtimeMode === "auto")
            return yield* validation("startSession", "Cline does not support Auto runtime mode.");
          const resume = parseClineResumeCursor(input.resumeCursor);
          if (input.resumeCursor !== undefined && !resume)
            return yield* validation(
              "startSession",
              "Invalid Cline resume cursor; refusing a fresh-session fallback.",
            );
          const previous = sessions.get(input.threadId);
          if (previous) yield* stopInternal(previous);
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (!cwd) return yield* validation("startSession", "A working directory is required.");
          const scope = yield* Scope.make("sequential");
          const lease = acquireAgentGatewaySessionLease(credentials, input.threadId, PROVIDER);
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => lease?.release()),
          );
          let ctx: ClineSessionContext | undefined;
          return yield* Effect.gen(function* () {
            const acp = yield* makeRuntime({
              childProcessSpawner,
              clineSettings: { ...settings, ...input.providerOptions?.cline },
              cwd,
              ...(resume ? { resumeSessionId: resume.sessionId } : {}),
              clientInfo: { name: "Synara", version: "0.0.0" },
              clientCapabilities: { elicitation: { form: {} } },
              ...(lease && credentials
                ? {
                    buildMcpServers: (initializeResult: Acp.InitializeResponse) =>
                      buildAcpSynaraMcpServers({
                        connection: lease.connection,
                        initializeResult,
                        stdioProxy: credentials.stdioProxy,
                      }),
                  }
                : {}),
              ...makeAcpNativeLoggers({
                nativeEventLogger,
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );
            const now = new Date().toISOString();
            const context: ClineSessionContext = {
              threadId: input.threadId,
              lifecycleGeneration: input.lifecycleGeneration,
              scope,
              acp,
              gatewaySessionLease: lease,
              teardownComplete: yield* Deferred.make<void, ProviderAdapterError>(),
              pendingApprovals: new Map(),
              pendingUserInputs: new Map(),
              turns: [],
              activeTools: new Set(),
              defaultModel: undefined,
              activeTurnId: undefined,
              activeInteractionMode: "default",
              activeItems: [],
              failedToolDetail: undefined,
              lastPlanFingerprint: undefined,
              latestSessionCostUsd: undefined,
              lastTurnActivityAt: undefined,
              sessionUpdatesProcessed: 0,
              turnStarting: false,
              pendingTurnInterrupted: false,
              stopped: false,
              session: {
                provider: PROVIDER,
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                status: "connecting",
                cwd,
                model: input.modelSelection?.model ?? "default",
                createdAt: now,
                updatedAt: now,
              },
            };
            ctx = context;
            sessions.set(input.threadId, context);
            yield* registerInteractions(context);
            yield* Stream.runForEach(acp.getEvents(), (event) => processEvent(context, event)).pipe(
              Effect.catchCause(() =>
                stopInternal(context, "Cline event stream failed.", false).pipe(Effect.ignore),
              ),
              Effect.forkIn(scope),
            );
            const started = yield* acp
              .start()
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
                ),
              );
            if (resume && started.sessionSetupMethod === "new")
              return yield* requestError(
                "session/load",
                "Cline could not resume the saved session; refusing to discard conversation context.",
              );
            context.defaultModel = clineDefaultModel(started);
            yield* bounded(
              configureClineSession({
                runtime: acp,
                model: context.session.model ?? "default",
                defaultModel: context.defaultModel,
              }).pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/configure", error),
                ),
              ),
              "session/configure",
            );
            if (context.stopped)
              return yield* validation("startSession", "Cline startup was cancelled.");
            context.session = {
              ...context.session,
              status: "ready",
              updatedAt: new Date().toISOString(),
              resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
            };
            yield* emit(context, {
              type: "session.started",
              ...stamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* emit(context, {
              type: "session.state.changed",
              ...stamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Cline ACP session ready" },
            });
            yield* emit(context, {
              type: "thread.started",
              ...stamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
            yield* acp.awaitExit.pipe(
              Effect.andThen(stopInternal(context, "Cline process exited.", false)),
              Effect.ignore,
              Effect.forkIn(scope),
            );
            return context.session;
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : ctx
                  ? stopInternal(ctx).pipe(Effect.ignore)
                  : Scope.close(scope, Exit.void),
            ),
          );
        }),
      );

    const drain = (ctx: ClineSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: 2_000,
        pollMs: 10,
      });
    const sendTurn: ClineAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.turnStarting || ctx.activeTurnId || ctx.session.status !== "ready")
          return yield* validation("sendTurn", "Cline is not ready for another turn.");
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER)
          return yield* validation("sendTurn", "A Cline session requires a Cline model.");
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* Effect.gen(function* () {
          const model = input.modelSelection?.model ?? ctx.session.model ?? "default";
          const interactionMode = input.interactionMode ?? "default";
          yield* bounded(
            configureClineSession({
              runtime: ctx.acp,
              model,
              defaultModel: ctx.defaultModel,
              interactionMode,
            }).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/configure", error),
              ),
            ),
            "session/configure",
          ).pipe(Effect.onError(() => stopInternal(ctx).pipe(Effect.ignore)));
          const prompt: Acp.ContentBlock[] = [];
          const text = appendFileAttachmentsPromptBlock({
            text: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          });
          if (text) prompt.push({ type: "text", text });
          prompt.push(
            ...(yield* loadProviderPromptImageBlocks({
              attachments: input.attachments,
              attachmentsDir: serverConfig.attachmentsDir,
              provider: PROVIDER,
              method: "session/prompt",
              readFile: fileSystem.readFile,
            })),
          );
          if (!prompt.length)
            return yield* validation("sendTurn", "A turn requires text or attachments.");
          if (ctx.stopped || ctx.pendingTurnInterrupted)
            return yield* validation("sendTurn", "Cline turn was cancelled before dispatch.");
          const policy = takeSynaraHarnessPolicyTextPartForProviderSession(ctx, {
            provider: PROVIDER,
            scopedGatewayConnectionAvailable: ctx.gatewaySessionLease !== undefined,
          });
          if (policy) prompt.unshift(policy);
          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          ctx.activeTurnId = turnId;
          ctx.activeInteractionMode = interactionMode;
          ctx.lastPlanFingerprint = undefined;
          ctx.failedToolDetail = undefined;
          ctx.lastTurnActivityAt = Date.now();
          ctx.activeItems = [{ prompt }];
          ctx.session = {
            ...ctx.session,
            model,
            activeTurnId: turnId,
            status: "running",
            updatedAt: new Date().toISOString(),
          };
          yield* emit(ctx, {
            type: "turn.started",
            ...stamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { model },
          });
          yield* Effect.suspend(() =>
            ctx.stopped || ctx.pendingTurnInterrupted
              ? Effect.interrupt
              : ctx.acp.prompt({ prompt }),
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  yield* drain(ctx);
                  const redacted = redactAcpLogSecrets(error.message);
                  const detail = typeof redacted === "string" ? redacted : "Cline prompt failed.";
                  yield* finishTurn(ctx, turnId, {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                  });
                  yield* stopInternal(ctx, detail, false).pipe(Effect.ignore);
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  yield* drain(ctx);
                  const completion = classifyAcpPromptTurnCompletion({
                    stopReason: result.stopReason,
                    failedToolDetail: ctx.failedToolDetail,
                  });
                  yield* finishTurn(ctx, turnId, {
                    ...completion,
                    stopReason: result.stopReason,
                    ...(result.usage ? { usage: result.usage } : {}),
                  });
                }),
            }),
            Effect.onInterrupt(() =>
              finishTurn(ctx, turnId, { state: "cancelled", stopReason: "cancelled" }),
            ),
            Effect.catchCause(() =>
              stopInternal(ctx, "Cline turn processing failed.", false).pipe(Effect.ignore),
            ),
            Effect.forkIn(ctx.scope),
          );
          yield* forkAcpAdapterTurnIdleWatchdog({
            context: ctx,
            turnId,
            idleTimeoutMs: 30 * 60_000,
            currentIdleTimeoutMs: () => (ctx.activeTools.size ? 60 * 60_000 : 30 * 60_000),
            checkIntervalMs: 5_000,
            onIdleTimeout: () =>
              stopInternal(
                ctx,
                "Cline stopped reporting progress; the session was stopped.",
                false,
              ).pipe(Effect.ignore),
          });
          return { threadId: ctx.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const interruptTurn: ClineAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) return;
        ctx.pendingTurnInterrupted = true;
        const activeTurnId = ctx.activeTurnId;
        if (!activeTurnId) return;
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            yield* ctx.acp.cancel.pipe(Effect.timeoutOption("3 seconds"), Effect.ignore);
            yield* finishTurn(ctx, activeTurnId, { state: "cancelled", stopReason: "cancelled" });
            // Retire after cancel, so late output cannot enter the next turn. The
            // persisted cursor lets ProviderService resume with a fresh gateway lease.
            yield* stopInternal(ctx);
          }),
        );
      });

    const listModels: NonNullable<ClineAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermit(
        Effect.gen(function* () {
          if (input.provider !== PROVIDER)
            return yield* validation("listModels", "Expected the Cline provider.");
          return yield* Effect.gen(function* () {
            const runtime = yield* makeRuntime({
              childProcessSpawner,
              clineSettings: {
                ...settings,
                ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              },
              cwd:
                resolveAcpSessionCwd({
                  inputCwd: input.cwd,
                  serverCwd: serverConfig.cwd,
                  homeDir: serverConfig.homeDir,
                }) ?? process.cwd(),
              clientInfo: { name: "Synara model discovery", version: "0.0.0" },
            });
            // Disposable probes never receive tool approvals or gateway authority.
            yield* runtime.handleRequestPermission(() =>
              Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
            );
            const result = yield* runtime.start();
            const models = mapClineModels(result);
            if (!models.length)
              return yield* requestError(
                "models/list",
                "Cline returned an empty model catalog. Check `cline auth` and the configured provider.",
              );
            return { models, source: "cline.acp" } satisfies ProviderListModelsResult;
          }).pipe(
            Effect.scoped,
            Effect.mapError((error) =>
              error instanceof ProviderAdapterRequestError
                ? error
                : requestError("models/list", String(redactAcpLogSecrets(error.message))),
            ),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              onTimeout: () =>
                Effect.fail(requestError("models/list", "Cline model discovery timed out.")),
            }),
          );
        }),
      );

    const stopAll: ClineAdapterShape["stopAll"] = () =>
      settleConcurrentTeardowns(sessions.values(), (ctx) => stopInternal(ctx));
    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignoreCause({ log: true })));
    return {
      provider: PROVIDER,
      capabilities: {
        ...CAPABILITIES,
        sessionModelSwitch: "in-session",
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      listModels,
      didResumeSession: (input, session) => {
        const requested = parseClineResumeCursor(input.resumeCursor);
        return (
          requested !== undefined &&
          requested.sessionId === parseClineResumeCursor(session.resumeCursor)?.sessionId
        );
      },
      respondToRequest: (threadId, id, decision) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingApprovals.get(id);
          if (!pending)
            return yield* validation(
              "respondToRequest",
              "Unknown or already settled Cline approval.",
            );
          yield* Deferred.succeed(pending.decision, decision);
        }),
      respondToUserInput: (threadId, id, answers) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUserInputs.get(id);
          if (!pending)
            return yield* validation(
              "respondToUserInput",
              "Unknown or already settled Cline question.",
            );
          yield* Deferred.succeed(pending.answers, answers);
        }),
      stopSession: (threadId) =>
        withThreadLock(
          threadId,
          Effect.suspend(() => {
            const ctx = sessions.get(threadId);
            return ctx ? stopInternal(ctx) : Effect.void;
          }),
        ),
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()].filter((ctx) => !ctx.stopped).map((ctx) => ctx.session),
        ),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((ctx) => ({
            threadId,
            ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
            turns: [...ctx.turns],
          })),
        ),
      rollbackThread: () =>
        Effect.fail(
          validation(
            "rollbackThread",
            "Cline does not expose native rollback; restart with conversation history instead.",
          ),
        ),
      stopAll,
      streamEvents: Stream.fromPubSub(events),
      getComposerCapabilities: () => Effect.succeed(CAPABILITIES),
    } satisfies ClineAdapterShape;
  });
}

export const makeClineAdapterLive = (
  settings: ClineAcpRuntimeSettings = {},
  options?: ClineAdapterLiveOptions,
) => Layer.effect(ClineAdapter, makeClineAdapter(settings, options));
