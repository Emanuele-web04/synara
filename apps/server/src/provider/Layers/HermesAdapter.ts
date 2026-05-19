/**
 * HermesAdapterLive — Hermes Agent (`hermes acp`) via ACP.
 *
 * Model discovery: Hermes ACP documents `session/set_model` but no public `list_models`
 * RPC (see https://hermes-agent.nousresearch.com/docs/user-guide/features/acp). MVP stays on
 * static `hermes-agent` plus `settings.providers.hermes.customHermesModels`.
 *
 * User input: editor flows use ACP permission prompts and terminal auth (`hermes acp --setup`),
 * not AskUserQuestion-style elicitation. `respondToUserInput` is intentionally unimplemented
 * until Hermes exposes a matching ACP notification.
 *
 * Health auth: probes use `hermes acp --version` / `--check` only; credential state stays
 * `unknown` because `hermes status` has no machine-readable auth output.
 *
 * @module HermesAdapterLive
 */
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Random,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { AcpSessionRuntime, type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { resolveHermesAcpSpawn, selectHermesAuthMethodId } from "../hermesAcp.ts";
import { HermesAdapter, type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "hermes" as const;
const HERMES_RESUME_VERSION = 1 as const;

export interface HermesAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  currentAcpModelId: string | undefined;
  lastPlanFingerprint: string | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shouldSetHermesAcpModel(model: string | undefined): model is string {
  return model !== undefined && model.trim().length > 0 && model !== "hermes-agent";
}

function parseHermesResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== HERMES_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function resolveHermesSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) return nodePath.resolve(requestedCwd);

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

function clearHermesActiveTurn(ctx: HermesSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) return false;

  ctx.activeTurnId = undefined;
  ctx.activePromptFiber = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

const makeHermesAcpRuntime = (input: {
  readonly binaryPath?: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly resumeSessionId?: string;
}): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpSpawn = resolveHermesAcpSpawn(input.binaryPath);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: acpSpawn.command,
          args: acpSpawn.args,
          cwd: input.cwd,
        },
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientInfo: { name: "dp-code", version: "0.0.0" },
        selectAuthMethodId: selectHermesAuthMethodId,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function makeHermesAdapter(options?: HermesAdapterLiveOptions) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const fileSystem = yield* FileSystem.FileSystem;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

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

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const setHermesSessionModel = (ctx: HermesSessionContext, model: string, threadId: ThreadId) =>
      Effect.gen(function* () {
        if (ctx.currentAcpModelId === model) return;
        yield* ctx.acp
          .setSessionModel(model)
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/set_model", error),
            ),
          );
        ctx.currentAcpModelId = model;
        ctx.session = { ...ctx.session, model, updatedAt: yield* nowIso };
      });

    const requireSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((ctx) =>
          ctx && !ctx.stopped
            ? Effect.succeed(ctx)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
        ),
      );

    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.activePromptFiber) yield* Fiber.interrupt(ctx.activePromptFiber);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        yield* Scope.close(ctx.scope, Exit.void);
        const now = yield* nowIso;
        ctx.session = { ...ctx.session, status: "closed", updatedAt: now };
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state: "stopped", reason: "Hermes session stopped" },
        });
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: HermesAdapterShape["startSession"] = (input) =>
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
          const cwd = resolveHermesSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const providerHermesOptions = input.providerOptions?.hermes;
          const resumeSessionId = parseHermesResume(input.resumeCursor)?.sessionId;
          const acp = yield* makeHermesAcpRuntime({
            childProcessSpawner,
            cwd,
            ...(providerHermesOptions?.binaryPath
              ? { binaryPath: providerHermesOptions.binaryPath }
              : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          let ctx!: HermesSessionContext;
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
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
                      : { outcome: "selected" as const, optionId: acpPermissionOutcome(resolved) },
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const hermesModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const currentAcpModelId = trimToUndefined(
            started.sessionSetupResult.models?.currentModelId,
          );
          const model = hermesModelSelection?.model ?? currentAcpModelId ?? "hermes-agent";
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            activeTurnId: undefined,
            activePromptFiber: undefined,
            currentAcpModelId,
            lastPlanFingerprint: undefined,
            stopped: false,
          };

          if (shouldSetHermesAcpModel(hermesModelSelection?.model)) {
            yield* setHermesSessionModel(ctx, hermesModelSelection.model, input.threadId);
          }

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
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
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Hermes ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const text = input.input?.trim();
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (text) {
            promptParts.push({ type: "text", text });
          }
          for (const attachment of input.attachments ?? []) {
            switch (attachment.type) {
              case "assistant-selection":
                promptParts.push({
                  type: "text",
                  text: `Selected assistant message:\n${attachment.text}`,
                });
                break;
              case "image": {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
                promptParts.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
                break;
              }
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const turnId = TurnId.makeUnsafe(randomUUID());
          const model =
            input.modelSelection?.provider === PROVIDER
              ? input.modelSelection.model
              : (ctx.session.model ?? "hermes-agent");
          if (shouldSetHermesAcpModel(model)) {
            yield* setHermesSessionModel(ctx, model, input.threadId);
          }
          ctx.activeTurnId = turnId;
          ctx.lastPlanFingerprint = undefined;
          const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
          ctx.session = {
            ...sessionWithoutLastError,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model,
          };

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model },
          });

          const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  if (!clearHermesActiveTurn(ctx, turnId)) return;
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                  ctx.session = {
                    ...ctx.session,
                    status: "error",
                    updatedAt: yield* nowIso,
                    model,
                    lastError: error.message,
                  };
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: "failed",
                      stopReason: null,
                      errorMessage: error.message,
                    },
                  });
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  if (!clearHermesActiveTurn(ctx, turnId)) return;
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
                    status: "ready",
                    updatedAt: yield* nowIso,
                    model,
                  };
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                      stopReason: result.stopReason ?? null,
                      ...(result.usage ? { usage: result.usage } : {}),
                    },
                  });
                }),
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (!clearHermesActiveTurn(ctx, turnId)) return;
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
                ctx.session = {
                  ...ctx.session,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model,
                };
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "cancelled", stopReason: "cancelled" },
                });
              }),
            ),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(ctx.scope),
          );
          ctx.activePromptFiber = yield* runPrompt;

          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }),
      );

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (ctx.activePromptFiber) yield* Fiber.interrupt(ctx.activePromptFiber);
      });

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
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
            method: "respondToRequest",
            detail: `Unknown approval request '${requestId}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: `Hermes adapter has no pending user input request '${requestId}'.`,
            }),
          ),
        ),
      );

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
      });

    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (numTurns <= 0) return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns), numTurns);
        return { threadId, turns: ctx.turns, cwd: ctx.session.cwd ?? null };
      });

    const getComposerCapabilities = Effect.succeed({
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
      supportsThreadCompaction: false,
      supportsThreadImport: false,
    } satisfies ProviderComposerCapabilities);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll: () =>
        Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      getComposerCapabilities: () => getComposerCapabilities,
    } satisfies HermesAdapterShape;
  });
}

export function makeHermesAdapterLive(options?: HermesAdapterLiveOptions) {
  return Layer.effect(HermesAdapter, makeHermesAdapter(options));
}
