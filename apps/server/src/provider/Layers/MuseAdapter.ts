import type * as Acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@synara/contracts";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import { takeSynaraHarnessPolicyTextPartForProviderSession } from "../../agentGateway/harnessPolicy.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { MuseAdapter, type MuseAdapterShape } from "../Services/MuseAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  resolveProviderSessionInstanceId,
} from "../Services/ProviderAdapter.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeMuseRuntime, configureMuse, discoverMuseModels } from "../acp/MuseAcpSupport.ts";
import {
  mapAcpToAdapterError,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpThreadLock,
  waitForAcpQueuedTurnEventsDrained,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  forkAcpAdapterTurnIdleWatchdog,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpToolCallEvent,
  makeAcpTokenUsageEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  isFormElicitationRequest,
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
} from "../acp/AcpElicitationSupport.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";

interface Session {
  readonly acp: AcpSessionRuntimeShape;
  readonly scope: Scope.Closeable;
  readonly gateway: AgentGatewaySessionLease | undefined;
  readonly generation: string | undefined;
  readonly enableComputerControl: boolean;
  readonly pendingApprovals: Map<
    ApprovalRequestId,
    { decision: Deferred.Deferred<ProviderApprovalDecision> }
  >;
  readonly pendingUserInputs: Map<
    ApprovalRequestId,
    { answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >;
  readonly turns: Array<{ id: TurnId; items: unknown[] }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  plan: boolean;
  stopped: boolean;
  processed: number;
  harnessPolicyDelivered?: boolean;
}

export function museResumeId(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("sessionId" in value)
  )
    return undefined;
  return typeof value.sessionId === "string" && value.sessionId.trim()
    ? value.sessionId.trim()
    : undefined;
}

export const makeMuseAdapter = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
  const sessions = new Map<ThreadId, Session>();
  const lock = yield* makeAcpThreadLock();
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(
    PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  );
  const stamp = () => ({
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    createdAt: new Date().toISOString(),
  });
  const emit = (ctx: Session, event: ProviderRuntimeEvent) =>
    PubSub.publish(events, {
      ...event,
      ...(ctx.generation ? { lifecycleGeneration: ctx.generation } : {}),
      ...(ctx.session.providerInstanceId
        ? { providerInstanceId: ctx.session.providerInstanceId }
        : {}),
    }).pipe(Effect.asVoid);
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<Session, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: "muse", threadId }));
  };
  const finish = (
    ctx: Session,
    turnId: TurnId,
    state: "completed" | "failed" | "cancelled",
    detail?: string,
  ) =>
    Effect.gen(function* () {
      if (ctx.activeTurnId !== turnId) return;
      yield* cancelAgentGatewayTurn(ctx.gateway, turnId);
      ctx.activeTurnId = undefined;
      ctx.promptFiber = undefined;
      const { activeTurnId: _active, lastError: _error, ...session } = ctx.session;
      ctx.session = {
        ...session,
        status: state === "failed" ? "error" : "ready",
        updatedAt: new Date().toISOString(),
        ...(detail ? { lastError: detail } : {}),
      };
      yield* emit(ctx, {
        ...stamp(),
        type: "turn.completed",
        provider: "muse",
        threadId: session.threadId,
        turnId,
        payload: {
          state,
          stopReason: state === "cancelled" ? "cancelled" : null,
          ...(detail ? { errorMessage: detail } : {}),
        },
      });
    });
  const interrupt = (ctx: Session) =>
    Effect.gen(function* () {
      const turn = ctx.activeTurnId;
      const fiber = ctx.promptFiber;
      yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
      yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
      yield* ctx.acp.cancel.pipe(Effect.timeoutOption(5_000), Effect.ignore);
      if (fiber) yield* Fiber.interrupt(fiber);
      if (turn) yield* finish(ctx, turn, "cancelled");
    });
  const stop = (ctx: Session) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* interrupt(ctx);
      ctx.gateway?.release();
      yield* Scope.close(ctx.scope, Exit.void);
      if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
      yield* emit(ctx, {
        ...stamp(),
        type: "session.exited",
        provider: "muse",
        threadId: ctx.session.threadId,
        payload: { exitKind: "graceful" },
      });
    });
  const startSession: MuseAdapterShape["startSession"] = (input) =>
    lock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider && input.provider !== "muse")
          return yield* new ProviderAdapterValidationError({
            provider: "muse",
            operation: "startSession",
            issue: "Expected Muse Code provider.",
          });
        const resumeSessionId = museResumeId(input.resumeCursor);
        if (input.resumeCursor != null && !resumeSessionId)
          return yield* new ProviderAdapterValidationError({
            provider: "muse",
            operation: "startSession",
            issue: "Invalid Muse resume cursor; refusing to start a fresh conversation.",
          });
        const previous = sessions.get(input.threadId);
        if (previous) yield* stop(previous);
        const scope = yield* Scope.make();
        const gateway = acquireAgentGatewaySessionLease(credentials, input.threadId, "muse", input);
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred
            ? Effect.void
            : Effect.gen(function* () {
                gateway?.release();
                yield* Scope.close(scope, Exit.void);
              }),
        );
        const instanceId = resolveProviderSessionInstanceId(input);
        const cwd = input.cwd?.trim() || config.cwd;
        const acp = yield* makeMuseRuntime({
          settings: {
            ...input.providerOptions?.muse,
            ...(instanceId ? { instanceId } : {}),
            homeDir: config.homeDir,
            isolationRootDir: config.stateDir,
          },
          cwd,
          childProcessSpawner: spawner,
          clientInfo: { name: "Synara", version: "1.0.0" },
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(credentials && gateway
            ? {
                buildMcpServers: (result: Acp.InitializeResponse) =>
                  buildAcpSynaraMcpServers({
                    connection: gateway.connection,
                    initializeResult: result,
                    stdioProxy: credentials.stdioProxy,
                  }),
              }
            : {}),
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const ctx: Session = {
          acp,
          scope,
          gateway,
          generation: input.lifecycleGeneration,
          enableComputerControl: input.enableComputerControl === true,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeTurnId: undefined,
          promptFiber: undefined,
          lastTurnActivityAt: undefined,
          plan: false,
          stopped: false,
          processed: 0,
          session: {
            provider: "muse",
            ...(instanceId ? { providerInstanceId: instanceId } : {}),
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd,
            status: "connecting",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            const policy = resolveAcpPermissionPolicy({
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: ctx.plan ? "plan" : "default",
              options: params.options,
              computerControlEnabled: ctx.enableComputerControl,
              activeTurn: ctx.activeTurnId !== undefined,
              toolCall: params.toolCall,
            });
            if (policy) return { outcome: policy };
            const permissionRequest = parsePermissionRequest(params);
            const id = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            ctx.pendingApprovals.set(id, { decision });
            const common = {
              stamp: stamp(),
              provider: "muse" as const,
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(id),
              permissionRequest,
            };
            yield* emit(
              ctx,
              makeAcpRequestOpenedEvent({
                ...common,
                detail: permissionRequest.detail ?? "Muse tool approval",
                args: params,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );
            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(Effect.sync(() => ctx.pendingApprovals.delete(id))),
            );
            yield* emit(
              ctx,
              makeAcpRequestResolvedEvent({ ...common, stamp: stamp(), decision: resolved }),
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
          }),
        );
        yield* acp.handleElicitation((params) =>
          Effect.gen(function* () {
            if (!isFormElicitationRequest(params) || ctx.stopped)
              return { action: "cancel" as const };
            const id = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            ctx.pendingUserInputs.set(id, { answers });
            yield* emit(ctx, {
              ...stamp(),
              type: "user-input.requested",
              provider: "muse",
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(id),
              payload: { questions: elicitationQuestionsFromRequest(params) },
            });
            const resolved = yield* Deferred.await(answers).pipe(
              Effect.ensuring(Effect.sync(() => ctx.pendingUserInputs.delete(id))),
            );
            yield* emit(ctx, {
              ...stamp(),
              type: "user-input.resolved",
              provider: "muse",
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(id),
              payload: { answers: resolved },
            });
            return Object.keys(resolved).length
              ? elicitationResponseFromAnswers(params, resolved)
              : { action: "cancel" as const };
          }),
        );
        yield* Stream.runForEach(acp.getEvents(), (event) =>
          Effect.gen(function* () {
            ctx.lastTurnActivityAt = Date.now();
            const common = {
              stamp: stamp(),
              provider: "muse" as const,
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
            };
            switch (event._tag) {
              case "ModeChanged":
                break;
              case "ContentDelta":
                yield* emit(
                  ctx,
                  makeAcpContentDeltaEvent({
                    ...common,
                    text: event.text,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                    rawPayload: event.rawPayload,
                  }),
                );
                break;
              case "AssistantItemStarted":
              case "AssistantItemCompleted":
                yield* emit(
                  ctx,
                  makeAcpAssistantItemEvent({
                    ...common,
                    itemId: event.itemId,
                    lifecycle:
                      event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                  }),
                );
                break;
              case "ToolCallUpdated":
                yield* emit(
                  ctx,
                  makeAcpToolCallEvent({
                    ...common,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                break;
              case "PlanUpdated":
                yield* emit(
                  ctx,
                  makeAcpPlanUpdatedEvent({
                    ...common,
                    payload: event.payload,
                    rawPayload: event.rawPayload,
                    source: "acp.jsonrpc",
                    method: "session/update",
                  }),
                );
                break;
              case "UsageUpdated":
                yield* emit(
                  ctx,
                  makeAcpTokenUsageEvent({
                    ...common,
                    usage: event.usage,
                    rawPayload: event.rawPayload,
                  }),
                );
                break;
            }
            ctx.processed++;
          }),
        ).pipe(Effect.forkIn(scope));
        const started = yield* acp.start();
        yield* acp.awaitLoadReplayReady;
        const selection =
          input.modelSelection?.provider === "muse" ? input.modelSelection : undefined;
        yield* configureMuse(acp, selection?.model, selection?.options, false);
        ctx.session = {
          ...ctx.session,
          status: "ready",
          model: selection?.model,
          resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
        };
        sessions.set(input.threadId, ctx);
        transferred = true;
        yield* startAgentGatewaySessionLeaseExitWatcher(gateway, acp.awaitExit);
        yield* acp.awaitExit.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (ctx.stopped) return;
              if (ctx.activeTurnId)
                yield* finish(
                  ctx,
                  ctx.activeTurnId,
                  "failed",
                  "Muse ACP process exited unexpectedly.",
                );
              ctx.session = {
                ...ctx.session,
                status: "error",
                lastError: "Muse ACP process exited.",
              };
              yield* emit(ctx, {
                ...stamp(),
                type: "session.exited",
                provider: "muse",
                threadId: input.threadId,
                payload: { exitKind: "error" },
              });
            }),
          ),
          Effect.forkIn(scope),
        );
        yield* emit(ctx, {
          ...stamp(),
          type: "session.started",
          provider: "muse",
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* emit(ctx, {
          ...stamp(),
          type: "session.state.changed",
          provider: "muse",
          threadId: input.threadId,
          payload: { state: "ready", reason: "Muse ACP session ready" },
        });
        yield* emit(ctx, {
          ...stamp(),
          type: "thread.started",
          provider: "muse",
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return ctx.session;
      }).pipe(
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof ProviderAdapterValidationError
            ? error
            : mapAcpToAdapterError("muse", input.threadId, "session/start", error),
        ),
      ),
    );

  const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
    lock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurnId)
          return yield* new ProviderAdapterValidationError({
            provider: "muse",
            operation: "sendTurn",
            issue: "Muse already has a turn in progress.",
          });
        const selection =
          input.modelSelection?.provider === "muse" ? input.modelSelection : undefined;
        const model = selection?.model ?? ctx.session.model;
        ctx.plan = input.interactionMode === "plan";
        yield* configureMuse(ctx.acp, model, selection?.options, ctx.plan).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError("muse", input.threadId, "session/configure", error),
          ),
        );
        const prompt: Acp.ContentBlock[] = [];
        const text = appendFileAttachmentsPromptBlock({
          text: input.input,
          attachments: input.attachments,
          attachmentsDir: config.attachmentsDir,
          include: "all-files",
        });
        if (text?.trim()) prompt.push({ type: "text", text });
        prompt.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: config.attachmentsDir,
            provider: "muse",
            method: "session/prompt",
            readFile: fs.readFile,
          })),
        );
        if (!prompt.length)
          return yield* new ProviderAdapterValidationError({
            provider: "muse",
            operation: "sendTurn",
            issue: "A prompt or attachment is required.",
          });
        const policy = takeSynaraHarnessPolicyTextPartForProviderSession(ctx, {
          provider: "muse",
          scopedGatewayConnectionAvailable: ctx.gateway !== undefined,
        });
        if (policy) prompt.unshift(policy);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.lastTurnActivityAt = Date.now();
        ctx.session = {
          ...ctx.session,
          model,
          activeTurnId: turnId,
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        yield* emit(ctx, {
          ...stamp(),
          type: "turn.started",
          provider: "muse",
          threadId: input.threadId,
          turnId,
          payload: { model },
        });
        ctx.promptFiber = yield* ctx.acp.prompt({ prompt }).pipe(
          Effect.tap(() =>
            waitForAcpQueuedTurnEventsDrained({
              sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
              sessionUpdatesProcessed: () => ctx.processed,
              maxWaitMs: 5_000,
              pollMs: 5,
            }),
          ),
          Effect.matchEffect({
            onFailure: (error) => finish(ctx, turnId, "failed", error.message),
            onSuccess: (result) =>
              Effect.gen(function* () {
                ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
                yield* finish(
                  ctx,
                  turnId,
                  result.stopReason === "cancelled" ? "cancelled" : "completed",
                );
              }),
          }),
          Effect.onInterrupt(() => finish(ctx, turnId, "cancelled")),
          Effect.forkIn(ctx.scope),
        );
        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: 600_000,
          checkIntervalMs: 15_000,
          onIdleTimeout: () =>
            Effect.gen(function* () {
              yield* finish(ctx, turnId, "failed", "Muse stopped producing ACP activity.");
              yield* stop(ctx);
            }),
        });
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }),
    );

  const listModels: NonNullable<MuseAdapterShape["listModels"]> = (input) =>
    Effect.gen(function* () {
      const runtime = yield* makeMuseRuntime({
        settings: {
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
          homeDir: config.homeDir,
          isolationRootDir: config.stateDir,
        },
        cwd: input.cwd || config.cwd,
        childProcessSpawner: spawner,
        clientInfo: { name: "Synara model discovery", version: "1.0.0" },
      });
      yield* runtime.start();
      return {
        models: yield* discoverMuseModels(runtime),
        source: "muse.acp",
        cached: false,
      };
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: "muse",
            method: "model/list",
            detail:
              "Muse model discovery failed. Check Muse Code and muse-acp installation and login.",
            cause,
          }),
      ),
    );
  const stopAll = () => settleConcurrentTeardowns(sessions.values(), stop);
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ensuring(PubSub.shutdown(events))));
  return {
    provider: "muse",
    capabilities: {
      sessionModelSwitch: "in-session",
      conversationRollback: "restart-session",
      supportsRuntimeModelList: true,
    },
    startSession,
    sendTurn,
    listModels,
    interruptTurn: (id, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(id);
        if (turnId === undefined || turnId === ctx.activeTurnId) yield* interrupt(ctx);
      }),
    stopSession: (id) =>
      Effect.gen(function* () {
        const ctx = sessions.get(id);
        if (ctx) yield* stop(ctx);
      }),
    stopAll,
    hasSession: (id) =>
      Effect.sync(() => {
        const ctx = sessions.get(id);
        return !!ctx && !ctx.stopped;
      }),
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()].filter((ctx) => !ctx.stopped).map((ctx) => ({ ...ctx.session })),
      ),
    readThread: (id) =>
      requireSession(id).pipe(
        Effect.map((ctx) => ({ threadId: id, turns: snapshotProviderTurns(ctx.turns) })),
      ),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "muse",
          operation: "rollbackThread",
          issue: "Muse rollback requires a restarted session built from retained history.",
        }),
      ),
    respondToRequest: (id, requestId, answer) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(id);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterRequestError({
            provider: "muse",
            method: "session/request_permission",
            detail: "Unknown Muse approval request.",
          });
        yield* Deferred.succeed(pending.decision, answer);
      }),
    respondToUserInput: (id, requestId, answer) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(id);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterRequestError({
            provider: "muse",
            method: "elicitation/create",
            detail: "Unknown Muse question.",
          });
        yield* Deferred.succeed(pending.answers, answer);
      }),
    getComposerCapabilities: () =>
      Effect.succeed({
        provider: "muse",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies MuseAdapterShape;
});
export const MuseAdapterLive = Layer.effect(MuseAdapter, makeMuseAdapter);
