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
  type ProviderListModelsInput,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Scope,
  Semaphore,
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
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  settlePendingApprovalsAsCancelled,
  settlePendingUserInputsAsEmptyAnswers,
  makeAcpThreadLock,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
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
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { filterProviderPromptImageAttachments } from "../promptAttachments.ts";
import { makeDevinAcpRuntime, type DevinAcpRuntimeSettings } from "../acp/DevinAcpSupport.ts";
import {
  elicitationFormToUserInputQuestions,
  userInputAnswersToElicitationContent,
  validateUserInputAnswersForElicitation,
} from "../acp/DevinElicitation.ts";
import { applyDevinModeSelection } from "../acp/DevinModeMapper.ts";
import {
  DEVIN_FALLBACK_MODELS,
  normalizeDevinModelSlug,
  buildDevinVariantMatrix,
  resolveDevinModelSlug,
  type DevinBaseModel,
} from "../acp/DevinModelCatalog.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import type { ProviderThreadTurnSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import serverPackageJson from "../../../package.json" with { type: "json" };

const PROVIDER = "devin" as const;
const DEVIN_RESUME_VERSION = 1 as const;
/** clientInfo.name identifies Synara to the Devin ACP backend. */
const DEVIN_CLIENT_INFO_NAME = "synara";
/** Maximum turns retained in-memory per session to prevent unbounded growth. */
const MAX_TURNS_PER_SESSION = 200;
/** Timeout for pending approvals/elicitations before auto-cancelling (5 minutes). */
const PENDING_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
/** Timeout for cold-start model discovery via ACP session. */
const DEVIN_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
/** Reuse cold-start model discovery results to avoid repeated short-lived spawns. */
const DEVIN_COLD_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEVIN_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 10 * 60 * 1000,
});
const DEVIN_TURN_WATCHDOG_INTERVAL_MS = 5_000;

export interface DevinAcpRuntimeFactoryInput {
  readonly devinSettings: DevinAcpRuntimeSettings;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly resumeSessionId?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly childProcessSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
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

type DevinFormElicitationRequest = Extract<EffectAcpSchema.ElicitationRequest, { mode: "form" }>;

interface PendingUserInput {
  readonly request: DevinFormElicitationRequest;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type DevinModelEntry = {
  readonly slug: string;
  readonly name: string;
  readonly upstreamProviderId?: string | undefined;
  readonly upstreamProviderName?: string | undefined;
  readonly supportedReasoningEfforts?:
    | ReadonlyArray<{ value: string; label?: string | undefined; description?: string | undefined }>
    | undefined;
  readonly defaultReasoningEffort?: string | undefined;
  readonly supportsFastMode?: boolean | undefined;
  readonly supportsThinkingToggle?: boolean | undefined;
  readonly contextWindowOptions?:
    | ReadonlyArray<{ value: string; label: string; isDefault?: true | undefined }>
    | undefined;
  readonly defaultContextWindow?: string | undefined;
};

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: ProviderThreadTurnSnapshot[];
  activeTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnFailedToolDetail: string | undefined;
  lastTurnActivityAt: number | undefined;
  /** Cached model list extracted from config options, updated on session start. */
  cachedModels: ReadonlyArray<DevinModelEntry> | undefined;
  /** Binary path that produced cachedModels, for cache invalidation. */
  cachedModelsBinaryPath: string | undefined;
  /** Variant matrix built from config options, for resolving base+options to full slugs. */
  variantMatrix: ReadonlyMap<string, DevinBaseModel> | undefined;
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

function pushTurnCapped(ctx: DevinSessionContext, turn: ProviderThreadTurnSnapshot): void {
  ctx.turns.push(turn);
  if (ctx.turns.length > MAX_TURNS_PER_SESSION) {
    ctx.turns.splice(0, ctx.turns.length - MAX_TURNS_PER_SESSION);
  }
}

function clearActiveTurn(ctx: DevinSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }
  ctx.activeTurnId = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.lastTurnActivityAt = undefined;
  return true;
}

function readColdDiscoveredModels(
  cache: Map<
    string,
    { readonly models: ReadonlyArray<DevinModelEntry>; readonly cachedAt: number }
  >,
  binaryPath: string,
) {
  const cached = cache.get(binaryPath);
  if (!cached) {
    return undefined;
  }
  if (Date.now() - cached.cachedAt > DEVIN_COLD_MODEL_DISCOVERY_CACHE_TTL_MS) {
    cache.delete(binaryPath);
    return undefined;
  }
  return cached.models;
}

function storeColdDiscoveredModels(
  cache: Map<
    string,
    { readonly models: ReadonlyArray<DevinModelEntry>; readonly cachedAt: number }
  >,
  binaryPath: string,
  models: ReadonlyArray<DevinModelEntry>,
): void {
  cache.set(binaryPath, {
    models,
    cachedAt: Date.now(),
  });
}

function extractDevinModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): {
  readonly models: readonly DevinModelEntry[];
  readonly matrix: ReadonlyMap<string, DevinBaseModel>;
} {
  const modelOption = configOptions.find((opt) => opt.category === "model");
  if (!modelOption || modelOption.type !== "select") {
    return { models: [], matrix: new Map() };
  }

  const rawEntries = modelOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ slug: entry.value, name: entry.name ?? entry.value }]
      : entry.options.map((option) => ({ slug: option.value, name: option.name ?? option.value })),
  );

  const matrix = buildDevinVariantMatrix(rawEntries);

  const models: DevinModelEntry[] = [];
  for (const base of matrix.values()) {
    const supportedReasoningEfforts =
      base.supportedEfforts.length > 0
        ? base.supportedEfforts.map((effort) => ({ value: effort }))
        : undefined;
    const contextWindowOptions =
      base.contextWindowOptions.length > 0
        ? base.contextWindowOptions.map((cw) => ({ value: cw, label: cw === "1m" ? "1M" : cw }))
        : undefined;
    const defaultVariant = base.defaultVariant;

    models.push({
      slug: base.baseSlug,
      name: base.baseName,
      upstreamProviderId: base.baseSlug,
      upstreamProviderName: base.baseName,
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      ...(defaultVariant.effort ? { defaultReasoningEffort: defaultVariant.effort } : {}),
      ...(base.supportsFastMode ? { supportsFastMode: true } : {}),
      ...(base.supportsThinking ? { supportsThinkingToggle: true } : {}),
      ...(contextWindowOptions ? { contextWindowOptions } : {}),
      ...(defaultVariant.contextWindow
        ? { defaultContextWindow: defaultVariant.contextWindow }
        : {}),
    });
  }

  return { models, matrix };
}

function makeDefaultRuntimeFactory(input: DevinAcpRuntimeFactoryInput) {
  if (!input.childProcessSpawner) {
    throw new Error(
      "childProcessSpawner is required for Devin ACP runtime (only omitted in test/mock paths)",
    );
  }
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
    clientInfo: { name: DEVIN_CLIENT_INFO_NAME, version: serverPackageJson.version },
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
  deps?: { readonly fileSystem: FileSystem.FileSystem; readonly serverConfig: ServerConfigShape },
) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, DevinSessionContext>();
    const coldDiscoveredModelsByBinaryPath = new Map<
      string,
      { readonly models: ReadonlyArray<DevinModelEntry>; readonly cachedAt: number }
    >();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const { withThreadLock } = makeAcpThreadLock(threadLocksRef);
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

    const stopSessionInternal = (
      ctx: DevinSessionContext,
      exitKind: "graceful" | "error" = "graceful",
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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
          payload: { exitKind },
        });
      });

    const startSession: DevinAdapterShape["startSession"] = (input) =>
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

          const cwd = input.cwd?.trim() || process.cwd();
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const devinSettings = {
            binaryPath: input.providerOptions?.devin?.binaryPath?.trim() || "devin",
          };
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
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
            ...(childProcessSpawner ? { childProcessSpawner } : {}),
          }).pipe(Effect.provideService(Scope.Scope, sessionScope));

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAcpFullAccessPermissionOptionId(
                    params.options,
                  );
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

                const maybeResolved = yield* Deferred.await(decision).pipe(
                  Effect.timeoutOption(Duration.millis(PENDING_DECISION_TIMEOUT_MS)),
                );
                pendingApprovals.delete(requestId);
                const resolved = Option.getOrElse(maybeResolved, () => "cancel" as const);
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

            yield* acp.handleElicitation((request) =>
              Effect.gen(function* () {
                if (request.mode !== "form") {
                  return { action: { action: "decline" as const } };
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { request, answers });
                yield* publish({
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions: elicitationFormToUserInputQuestions(request) },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: request,
                  },
                });
                const maybeAnswers = yield* Deferred.await(answers).pipe(
                  Effect.timeoutOption(Duration.millis(PENDING_DECISION_TIMEOUT_MS)),
                );
                pendingUserInputs.delete(requestId);
                const resolved = Option.getOrElse(
                  maybeAnswers,
                  () => ({}) as ProviderUserInputAnswers,
                );
                // ponytail: redact elicitation answers in the resolved event; the
                // web UI only uses this to dismiss the pending request (answers
                // are read from the request event). Schema requires an `answers`
                // record, so emit an empty one. Upgrade: add a redacted payload
                // variant to UserInputResolvedPayload when other providers follow.
                yield* publish({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: {} },
                });
                const content = userInputAnswersToElicitationContent(request, resolved);
                return Object.keys(content).length > 0
                  ? { action: { action: "accept" as const, content } }
                  : { action: { action: "cancel" as const } };
              }),
            );

            return yield* acp.start();
          }).pipe(
            Effect.mapError((error: EffectAcpErrors.AcpError) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          // Eagerly populate model cache + variant matrix from initial config
          // options before resolving the selected model, so a probe failure
          // surfaces as a startSession error without leaving consumers seeing
          // a ready session.
          const initialConfigOptions = yield* acp.getConfigOptions;
          const { models: extractedModels, matrix: sessionVariantMatrix } =
            extractDevinModelsFromConfigOptions(initialConfigOptions);

          const requestedModel =
            input.modelSelection?.provider === PROVIDER
              ? normalizeDevinModelSlug(input.modelSelection.model)
              : "";
          // Resolve base + variant options to a full slug.
          const selectedModel = requestedModel
            ? (resolveDevinModelSlug(
                requestedModel,
                input.modelSelection?.options as
                  | {
                      reasoningEffort?: string;
                      fastMode?: boolean;
                      thinking?: boolean;
                      contextWindow?: string;
                    }
                  | undefined,
                sessionVariantMatrix,
              ) ?? requestedModel)
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
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            activePromptFiber: undefined,
            activeTurnFailedToolDetail: undefined,
            lastTurnActivityAt: undefined,
            cachedModels: extractedModels,
            cachedModelsBinaryPath: devinSettings.binaryPath,
            variantMatrix: sessionVariantMatrix,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                ctx.lastTurnActivityAt = Date.now();
                switch (event._tag) {
                  // Modes and commands are fetched on-demand (getModeState / getAvailableCommands);
                  // the notification-level updates are redundant and intentionally not surfaced.
                  case "ModeChanged":
                  case "AvailableCommandsUpdated":
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

          // Detect unexpected ACP process exits (crash, OOM-kill, segfault).
          yield* Effect.gen(function* () {
            const exitCode = yield* acp.exitCode;
            if (ctx.stopped) return;
            yield* Effect.logError(
              `Devin ACP process exited unexpectedly (code=${exitCode}) for thread ${input.threadId}`,
            );
            yield* publish({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                state: "error",
                reason: `Devin CLI process exited unexpectedly (exit code ${exitCode}). Please restart the session.`,
              },
            });
            yield* stopSessionInternal(ctx, "error");
          }).pipe(Effect.forkIn(sessionScope));

          yield* publish({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          if (started.resumeFailed) {
            yield* Effect.logWarning(
              `Devin session resume failed for thread ${input.threadId}, started fresh session ${started.sessionId}`,
            );
            yield* publish({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                state: "ready",
                reason:
                  "Could not resume your previous Devin session. A new session was started — previous context was not carried over.",
              },
            });
          }
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

          // Transfer ownership to the sessions map only after all startup probes
          // succeed, so a probe failure doesn't leave an orphaned session.
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          return session;
        }).pipe(Effect.scoped),
      );

    const failDevinTurnAsTimedOut = (ctx: DevinSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearActiveTurn(ctx, turnId)) {
          return;
        }
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Devin stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        pushTurnCapped(ctx, { id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        const { activeTurnId: _activeTurnId, ...sessionRest } = ctx.session;
        ctx.session = {
          ...sessionRest,
          status: "error",
          updatedAt: yield* nowIso(),
          lastError: detail,
        };
        yield* Effect.logWarning("devin.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* publish({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
          },
        });
        yield* Effect.ignore(ctx.acp.cancel);
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const promptText = input.input?.trim();
          const hasAttachments = input.attachments && input.attachments.length > 0;
          if (!promptText && !hasAttachments) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Devin requires a non-empty prompt or attachments.",
            });
          }
          // Concurrency guard: at most one active prompt per session to avoid
          // flooding the ACP stdio pipe with overlapping RPC calls.
          if (ctx.activeTurnId !== undefined || ctx.activePromptFiber !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Devin already has an active turn. Wait for it to finish or cancel it first.",
            });
          }

          const requestedModel =
            input.modelSelection?.provider === PROVIDER
              ? normalizeDevinModelSlug(input.modelSelection.model)
              : "";
          const turnModel = requestedModel
            ? (resolveDevinModelSlug(
                requestedModel,
                input.modelSelection?.options as
                  | {
                      reasoningEffort?: string;
                      fastMode?: boolean;
                      thinking?: boolean;
                      contextWindow?: string;
                    }
                  | undefined,
                ctx.variantMatrix ?? new Map(),
              ) ?? requestedModel)
            : "";
          const model = turnModel || ctx.session.model;
          // Run mode/model preflight before claiming the active turn so a
          // preflight failure doesn't leave the session stuck with a turnId.
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

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          ctx.activeTurnId = turnId;
          ctx.activeTurnFailedToolDetail = undefined;
          ctx.lastTurnActivityAt = Date.now();

          // Build prompt parts: text (with file attachment context appended) +
          // image attachments as ACP image content blocks, matching Cursor/Grok.
          // deps (fileSystem/serverConfig) are only available in the live path;
          // mock tests don't provide them, so attachments are unsupported in mocks.
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const serverConfig = deps?.serverConfig ?? null;
          const textWithFileAttachments = serverConfig
            ? appendFileAttachmentsPromptBlock({
                text: promptText,
                attachments: input.attachments,
                attachmentsDir: serverConfig.attachmentsDir,
                include: "all-files",
              })
            : promptText;
          if (textWithFileAttachments) {
            promptParts.push({ type: "text", text: textWithFileAttachments });
          }
          if (hasAttachments && input.attachments && serverConfig && deps) {
            for (const attachment of filterProviderPromptImageAttachments(input.attachments)) {
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
              const bytes = yield* deps.fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }
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
                  pushTurnCapped(ctx, { id: turnId, items: [{ prompt: promptParts, error }] });
                  const { activeTurnId: _activeTurnId, ...sessionRest } = ctx.session;
                  ctx.session = {
                    ...sessionRest,
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
                  pushTurnCapped(ctx, { id: turnId, items: [{ prompt: promptParts, result }] });
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
                pushTurnCapped(ctx, {
                  id: turnId,
                  items: [{ prompt: promptParts, interrupted: true }],
                });
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

          yield* forkAcpTurnIdleWatchdog({
            idleTimeoutMs: DEVIN_TURN_IDLE_TIMEOUT_MS,
            checkIntervalMs: DEVIN_TURN_WATCHDOG_INTERVAL_MS,
            scope: ctx.scope,
            isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
            isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
            lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
            touchActivity: () => {
              ctx.lastTurnActivityAt = Date.now();
            },
            onIdleTimeout: (idleMs) => failDevinTurnAsTimedOut(ctx, turnId, idleMs),
          });

          return {
            threadId: input.threadId,
            turnId,
            ...(ctx.session.resumeCursor !== undefined
              ? { resumeCursor: ctx.session.resumeCursor }
              : {}),
          };
        }),
      );

    const adapter: DevinAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsRuntimeModelList: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsRollback: false,
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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
      respondToUserInput: (threadId, requestId, answers) =>
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
          // Reject invalid answers without resolving the deferred so the
          // pending elicitation stays answerable.
          const validation = validateUserInputAnswersForElicitation(pending.request, answers);
          if (!validation.valid) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `Invalid Devin elicitation answers: ${validation.issues.join("; ")}`,
            });
          }
          yield* Deferred.succeed(pending.answers, answers);
        }),
      stopSession: (threadId) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* stopSessionInternal(ctx);
          }),
        ),
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
      // ponytail: ACP schema has no session/revert or thread/rollback RPC; only
      // fork. Gap tracked. Upgrade: if Devin ACP adds rollback, map it here.
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
      compactThread: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* ctx.acp
            .prompt({ prompt: [{ type: "text", text: "/compact" }] })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/prompt", error),
              ),
            );
        }),
      stopAll: () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          yield* Effect.forEach(contexts, (ctx) => stopSessionInternal(ctx), { discard: true });
        }),
      streamEvents: Stream.fromPubSub(events),
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          // ponytail: ACP schema has no subagent/mention/MCP config primitives.
          // Skills/mentions/plugins are not exposed. MCP servers: schema accepts
          // mcpServers in session/new but Synara has no MCP settings surface.
          // Upgrade: wire composer capabilities + turn input mentions when ACP
          // adds agent dispatch; pass mcpServers when Synara adds MCP settings.
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          // Compaction sends /compact as a prompt via compactThread. Import is not yet mapped.
          supportsThreadCompaction: true,
          supportsThreadImport: false,
          // ACP has no session/revert or session/rollback method, and Devin has
          // no revert slash command. Rollback is genuinely unsupported.
          supportsRollback: false,
        } satisfies ProviderComposerCapabilities),
      listModels: (input: ProviderListModelsInput) =>
        Effect.gen(function* () {
          const requestedBinaryPath = input?.binaryPath?.trim() || "devin";
          // Warm path: return cached models from running sessions with matching binary.
          for (const ctx of sessions.values()) {
            if (ctx.stopped) continue;
            if (ctx.cachedModelsBinaryPath !== requestedBinaryPath) continue;
            if (ctx.cachedModels && ctx.cachedModels.length > 0) {
              return {
                models: ctx.cachedModels,
                source: "devin.acp",
                cached: true,
              } as ProviderListModelsResult;
            }
            // Fallback: read config options if cache not yet populated.
            const configOptions = yield* ctx.acp.getConfigOptions;
            const { models: extractedModels, matrix: extractedMatrix } =
              extractDevinModelsFromConfigOptions(configOptions);
            if (extractedModels.length > 0) {
              ctx.cachedModels = extractedModels;
              ctx.cachedModelsBinaryPath = requestedBinaryPath;
              ctx.variantMatrix = extractedMatrix;
              return {
                models: extractedModels,
                source: "devin.acp",
                cached: false,
              } as ProviderListModelsResult;
            }
          }

          // Cold path: no running session with models; attempt discovery.
          const cachedColdModels = readColdDiscoveredModels(
            coldDiscoveredModelsByBinaryPath,
            requestedBinaryPath,
          );
          if (cachedColdModels && cachedColdModels.length > 0) {
            return {
              models: cachedColdModels,
              source: "devin.acp",
              cached: true,
            } as ProviderListModelsResult;
          }

          const binaryPath = requestedBinaryPath;

          const discoveryEffect = Effect.gen(function* () {
            const discoveryThreadId = ThreadId.makeUnsafe("devin-model-discovery");
            const devinSettings = { binaryPath };
            const runtime = yield* makeRuntime({
              devinSettings,
              cwd: input.cwd?.trim() || process.cwd(),
              threadId: discoveryThreadId,
              ...(childProcessSpawner ? { childProcessSpawner } : {}),
            });

            yield* runtime.start();

            // Check config options once
            const configOptions = yield* runtime.getConfigOptions;
            const { models: discoveredModels } = extractDevinModelsFromConfigOptions(configOptions);

            if (discoveredModels.length === 0) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail: "Devin ACP model discovery found no models in config options.",
              });
            }

            return {
              models: discoveredModels,
              source: "devin.acp",
              cached: false,
            } as ProviderListModelsResult;
          }).pipe(
            Effect.scoped,
            Effect.timeoutOption(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "model/list",
                      detail: "Timed out while discovering Devin models via ACP.",
                    }),
                  ),
                onSome: (result) => Effect.succeed(result),
              }),
            ),
          );

          const result = yield* discoveryEffect.pipe(
            Effect.tap((discovered) =>
              Effect.sync(() =>
                storeColdDiscoveredModels(
                  coldDiscoveredModelsByBinaryPath,
                  binaryPath,
                  discovered.models,
                ),
              ),
            ),
            Effect.catch(() =>
              Effect.succeed({
                models: DEVIN_FALLBACK_MODELS,
                source: "devin.fallback",
                cached: true,
              } as ProviderListModelsResult),
            ),
          );

          return result;
        }),
      listCommands: (input) =>
        Effect.gen(function* () {
          // A supplied threadId is a strict scope: never fall back to another
          // session's commands, which could leak workspace-specific names.
          if (input.threadId) {
            const ctx = sessions.get(ThreadId.makeUnsafe(input.threadId));
            if (ctx && !ctx.stopped) {
              const commands = yield* ctx.acp.getAvailableCommands;
              return { commands, source: "devin.acp", cached: false };
            }
            return { commands: [], source: "devin.acp", cached: false };
          }
          // Without a threadId, only return commands from sessions sharing the same cwd
          // to avoid leaking workspace-specific commands across projects.
          const cwd = input.cwd?.trim();
          if (!cwd) {
            return { commands: [], source: "devin.acp", cached: false };
          }
          for (const candidate of sessions.values()) {
            if (candidate.stopped) continue;
            if (candidate.session.cwd !== cwd) continue;
            const commands = yield* candidate.acp.getAvailableCommands;
            if (commands.length > 0) {
              return { commands, source: "devin.acp", cached: false };
            }
          }
          return { commands: [], source: "devin.acp", cached: false };
        }),
    };

    // Clean up all active sessions when the layer is torn down.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(Effect.tap(() => PubSub.shutdown(events))),
    );

    return adapter;
  });
}

export function makeDevinAdapterLive(
  options: DevinAdapterMockRuntimeOptions,
): Layer.Layer<DevinAdapter>;
export function makeDevinAdapterLive(
  options?: DevinAdapterLiveOptions,
): Layer.Layer<
  DevinAdapter,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | ServerConfig
>;
export function makeDevinAdapterLive(options?: DevinAdapterLiveOptions) {
  return Layer.effect(
    DevinAdapter,
    options?.makeRuntime
      ? makeProviderAdapter(options, undefined)
      : Effect.gen(function* () {
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fileSystem = yield* FileSystem.FileSystem;
          const serverConfig = yield* Effect.service(ServerConfig);
          return yield* makeProviderAdapter(options, childProcessSpawner, {
            fileSystem,
            serverConfig,
          });
        }),
  );
}

export const DevinAdapterLive = makeDevinAdapterLive();
