/**
 * DevinAdapterLive - Devin CLI (`devin acp`) via ACP.
 *
 * @module DevinAdapterLive
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  selectAcpFullAccessPermissionOptionId,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { type AcpSessionMode, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeDevinAcpRuntime, type DevinAcpRuntimeSettings } from "../acp/DevinAcpSupport.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import type { ProviderThreadTurnSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "devin" as const;
const DEVIN_RESUME_VERSION = 1 as const;
const DEVIN_PLAN_MODE_ALIASES = ["plan"];
const DEVIN_FULL_ACCESS_MODE_ALIASES = ["bypass", "bypass permissions"];
const DEVIN_CODE_MODE_ALIASES = ["accept-edits", "code", "accept edits"];
const DEVIN_ACP_MODEL_ALIASES: Readonly<Record<string, string>> = {
  swe: "swe-1-6",
  opus: "claude-opus-4-8-medium",
  sonnet: "claude-sonnet-4-6",
  gpt: "gpt-5-5-medium",
  codex: "gpt-5-3-codex-medium",
  gemini: "gemini-3-5-flash-medium",
};

function normalizeDevinAcpModel(model: string): string {
  const trimmed = model.trim();
  return DEVIN_ACP_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export interface DevinAcpRuntimeFactoryInput {
  readonly devinSettings: DevinAcpRuntimeSettings;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly resumeSessionId?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export interface DevinAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeRuntime?: (
    input: DevinAcpRuntimeFactoryInput,
  ) => Effect.Effect<AcpSessionRuntimeShape, ProviderAdapterError, Scope.Scope>;
}

export interface DevinAdapterMockRuntimeOptions extends DevinAdapterLiveOptions {
  readonly makeRuntime: NonNullable<DevinAdapterLiveOptions["makeRuntime"]>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Scope;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: ProviderThreadTurnSnapshot[];
  activeTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnFailedToolDetail: string | undefined;
  stopped: boolean;
}

function nowIso(): Effect.Effect<string> {
  return Effect.sync(() => new Date().toISOString());
}

function makeEventStamp(): Effect.Effect<Pick<ProviderRuntimeEvent, "eventId" | "createdAt">> {
  return Effect.gen(function* () {
    return {
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      createdAt: yield* nowIso(),
    };
  });
}

function readDevinResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as { readonly schemaVersion?: unknown; readonly sessionId?: unknown };
  if (cursor.schemaVersion !== DEVIN_RESUME_VERSION) return undefined;
  return typeof cursor.sessionId === "string" && cursor.sessionId.trim()
    ? cursor.sessionId.trim()
    : undefined;
}

function clearActiveTurn(ctx: DevinSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }
  ctx.activeTurnId = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  return true;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingApprovals.values()],
    (pending) => Deferred.succeed(pending.decision, "cancel" as const),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingApprovals.clear())));
}

function staticDevinModels() {
  return [
    { slug: "swe", name: "SWE" },
    { slug: "opus", name: "Opus" },
    { slug: "sonnet", name: "Sonnet" },
    { slug: "gpt", name: "GPT" },
    { slug: "codex", name: "Codex" },
    { slug: "gemini", name: "Gemini" },
  ];
}

function normalizedModeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function findDevinModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map(normalizedModeText);
  return modes.find((mode) => {
    const haystack = normalizedModeText(`${mode.id} ${mode.name} ${mode.description ?? ""}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

function resolveDevinModeId(input: {
  readonly modes: ReadonlyArray<AcpSessionMode>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return findDevinModeByAliases(input.modes, DEVIN_PLAN_MODE_ALIASES)?.id;
  }
  if (input.runtimeMode === "full-access") {
    return (
      findDevinModeByAliases(input.modes, DEVIN_FULL_ACCESS_MODE_ALIASES)?.id ??
      findDevinModeByAliases(input.modes, DEVIN_CODE_MODE_ALIASES)?.id
    );
  }
  return findDevinModeByAliases(input.modes, DEVIN_CODE_MODE_ALIASES)?.id;
}

function applyDevinModeSelection(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    if (!modeState) return;
    const modeId = resolveDevinModeId({
      modes: modeState.availableModes,
      runtimeMode: input.runtimeMode,
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    });
    if (!modeId || modeId === modeState.currentModeId) return;
    yield* input.runtime
      .setMode(modeId)
      .pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", error),
        ),
      );
  });
}

function makeDefaultRuntimeFactory(input: DevinAcpRuntimeFactoryInput) {
  const acpNativeLoggers = makeAcpNativeLoggers({
    nativeEventLogger: input.nativeEventLogger,
    provider: PROVIDER,
    threadId: input.threadId,
  });
  return makeDevinAcpRuntime({
    devinSettings: input.devinSettings,
    childProcessSpawner: input.childProcessSpawner,
    cwd: input.cwd,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    clientInfo: { name: "Synara", version: "0.0.0" },
    ...acpNativeLoggers,
  }).pipe(
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
}

function makeProviderAdapter(
  options: DevinAdapterLiveOptions | undefined,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined,
) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, DevinSessionContext>();
    const makeRuntime = options?.makeRuntime ?? makeDefaultRuntimeFactory;

    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

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

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: DevinAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const cwd = input.cwd?.trim() || process.cwd();
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const devinSettings = {
          binaryPath: input.providerOptions?.devin?.binaryPath?.trim() || "devin",
        };
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        let ctx!: DevinSessionContext;

        const resumeSessionId = readDevinResumeSessionId(input.resumeCursor);
        const acp = yield* makeRuntime({
          devinSettings,
          cwd,
          threadId: input.threadId,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
          childProcessSpawner:
            childProcessSpawner ??
            (undefined as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]),
        }).pipe(Effect.provideService(Scope.Scope, sessionScope));

        const started = yield* Effect.gen(function* () {
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              if (input.runtimeMode === "full-access") {
                const autoApprovedOptionId = selectAcpFullAccessPermissionOptionId(params.options);
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
                }
              }

              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
              yield* publish(
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
              yield* publish(
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

              const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
              return {
                outcome:
                  selectedOptionId === undefined
                    ? ({ outcome: "cancelled" } as const)
                    : ({
                        outcome: "selected" as const,
                        optionId: selectedOptionId,
                      } as const),
              };
            }),
          );
          return yield* acp.start();
        }).pipe(
          Effect.mapError((error: EffectAcpErrors.AcpError) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const selectedModel =
          input.modelSelection?.provider === PROVIDER
            ? normalizeDevinAcpModel(input.modelSelection.model)
            : "";
        yield* applyDevinModeSelection({
          runtime: acp,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
        });
        if (selectedModel) {
          yield* acp
            .setModel(selectedModel)
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
              ),
            );
        }

        const now = yield* nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(selectedModel ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: DEVIN_RESUME_VERSION,
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
          activeTurnFailedToolDetail: undefined,
          stopped: false,
        };

        const notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "ModeChanged":
                  return;
                case "AssistantItemStarted":
                  yield* publish(
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
                  yield* publish(
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
                case "PlanUpdated":
                  yield* publish(
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
                  const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                  if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
                    ctx.activeTurnFailedToolDetail = failedToolDetail;
                  }
                  yield* publish(
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
                case "ContentDelta":
                  yield* publish(
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
                  yield* publish(
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
        ).pipe(Effect.forkIn(sessionScope));

        ctx.notificationFiber = notificationFiber;
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;

        yield* publish({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Devin ACP session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });

        return session;
      }).pipe(Effect.scoped);

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const promptText = input.input?.trim();
        if (!promptText) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Devin requires a non-empty prompt.",
          });
        }
        if (ctx.activeTurnId !== undefined || ctx.activePromptFiber !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Devin already has an active turn. Wait for it to finish or cancel it first.",
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModel =
          input.modelSelection?.provider === PROVIDER
            ? normalizeDevinAcpModel(input.modelSelection.model)
            : "";
        const model = turnModel || ctx.session.model;
        yield* applyDevinModeSelection({
          runtime: ctx.acp,
          threadId: input.threadId,
          runtimeMode: ctx.session.runtimeMode,
          ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        });
        if (turnModel) {
          yield* ctx.acp
            .setModel(turnModel)
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
              ),
            );
        }

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [
          {
            type: "text",
            text: promptText,
          },
        ];
        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: yield* nowIso(),
        };

        yield* publish({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (!clearActiveTurn(ctx, turnId)) return;
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso(),
                  lastError: error.message,
                };
                yield* publish({
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
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearActiveTurn(ctx, turnId)) return;
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const {
                  lastError: _lastError,
                  activeTurnId: _activeTurnId,
                  ...sessionRest
                } = ctx.session;
                ctx.session = {
                  ...sessionRest,
                  status: "ready",
                  updatedAt: yield* nowIso(),
                  ...(model ? { model } : {}),
                };
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* publish({
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
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearActiveTurn(ctx, turnId)) return;
              const {
                lastError: _lastError,
                activeTurnId: _activeTurnId,
                ...sessionRest
              } = ctx.session;
              ctx.session = {
                ...sessionRest,
                status: "ready",
                updatedAt: yield* nowIso(),
                ...(model ? { model } : {}),
              };
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              yield* publish({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const adapter: DevinAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          const activePromptFiber = ctx.activePromptFiber;
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
            ),
          );
          if (activePromptFiber) {
            yield* Fiber.interrupt(activePromptFiber);
          }
        }),
      respondToRequest: (threadId, requestId, decision) =>
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
        }),
      respondToUserInput: (_threadId, requestId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          }),
        ),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((ctx) => ({
            threadId,
            turns: ctx.turns,
            ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
          })),
        ),
      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail:
              "Devin ACP rollback is unsupported until Synara can map rollback to a native Devin session revert, fork, or rewind operation.",
          });
        }),
      stopAll: () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          yield* Effect.forEach(contexts, stopSessionInternal, { discard: true });
        }),
      streamEvents: Stream.fromPubSub(events),
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: false,
          supportsThreadImport: true,
        } satisfies ProviderComposerCapabilities),
      listModels: () =>
        Effect.succeed({
          models: staticDevinModels(),
          source: "devin",
          cached: true,
        }),
    };

    return adapter;
  });
}

export function makeDevinAdapterLive(
  options: DevinAdapterMockRuntimeOptions,
): Layer.Layer<DevinAdapter>;
export function makeDevinAdapterLive(
  options?: DevinAdapterLiveOptions,
): Layer.Layer<DevinAdapter, never, ChildProcessSpawner.ChildProcessSpawner>;
export function makeDevinAdapterLive(options?: DevinAdapterLiveOptions) {
  return Layer.effect(
    DevinAdapter,
    options?.makeRuntime
      ? makeProviderAdapter(options, undefined)
      : Effect.gen(function* () {
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return yield* makeProviderAdapter(options, childProcessSpawner);
        }),
  );
}

export const DevinAdapterLive = makeDevinAdapterLive();
