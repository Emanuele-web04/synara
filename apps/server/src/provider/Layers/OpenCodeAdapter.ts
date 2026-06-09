import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderKind,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Cause, Deferred, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import type {
  AssistantMessage,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { KiloAdapter, type KiloAdapterShape } from "../Services/KiloAdapter.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import type {
  OpenCodeCompatibleAdapterConfig,
  OpenCodeCompatibleProvider,
  OpenCodeMessageSnapshot,
} from "./OpenCodeAdapter.types.ts";
import {
  KILO_ADAPTER_CONFIG,
  OPENCODE_ADAPTER_CONFIG,
  OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS,
  OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS,
  OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS,
} from "./OpenCodeAdapter.config.ts";
import {
  asFiniteNonNegativeNumber,
  asPositiveInteger,
  buildOpenCodeTokenUsageKey,
  normalizeOpenCodeTokenUsage,
} from "./OpenCodeAdapter.token.ts";
import {
  buildOpenCodeModelContextLimitMap,
  compareOpenCodeModelDescriptors,
  flattenOpenCodeAgents,
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  mergeOpenCodeCliModelDescriptors,
  resolvePreferredOpenCodeModelProviders,
  trimNonEmptyString,
} from "./OpenCodeAdapter.models.ts";
import {
  appendOpenCodeAssistantTextDelta,
  buildOpenCodeThreadSnapshot,
  buildProviderEventBase,
  extractResumeSessionId,
  isFinalAssistantMessageSnapshot,
  isOpenCodeContextOverflowError,
  isOpenCodeTerminalStepFinish,
  isOpenCodeToolCallFinish,
  isoFromEpochMs,
  isoFromOpenCodeTimestamp,
  mapPermissionDecision,
  mapPermissionToRequestType,
  mergeOpenCodeAssistantText,
  normalizeOpenCodeTodoTasks,
  normalizeQuestionRequest,
  nowIso,
  openCodeMessageSnapshotFromEntry,
  openCodeMessageSnapshotsFromResponse,
  openCodeSnapshotKey,
  openCodeToolContentText,
  resolveLatestAssistantText,
  resolveTextStreamKind,
  sessionErrorMessage,
  shouldProjectOpenCodeTextPart,
  textFromPart,
  toToolLifecycleItemType,
} from "./OpenCodeAdapter.events.ts";

export {
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.models.ts";
export { normalizeOpenCodeTokenUsage } from "./OpenCodeAdapter.token.ts";

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly pendingTextDeltasByPartId: Map<string, string>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly messageSnapshotKeyById: Map<string, string>;
  readonly partById: Map<string, Part>;
  readonly partSnapshotKeyById: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  readonly modelContextLimitBySlug: Map<string, number>;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastEmittedTokenUsageKey: string | undefined;
  latestTurnCostUsd: number | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnEventSerial: number;
  activeTurnProviderActivitySerial: number;
  activeTurnCompletionActivitySerial: number;
  activeTurnSawToolCallFinish: boolean;
  activeTurnSawFinalAssistant: boolean;
  activeTurnToolCallIdleWatchdogStarted: boolean;
  activeInteractionMode: "default" | "plan" | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtime?: OpenCodeRuntimeShape;
  readonly adapterConfig?: OpenCodeCompatibleAdapterConfig;
  readonly promptAcceptedActivityTimeoutMs?: number;
  readonly promptAcceptedRecoveryDelaysMs?: ReadonlyArray<number>;
  readonly promptSubmissionInlineWaitMs?: number;
}

function toRequestError(
  provider: OpenCodeCompatibleProvider,
  cause: OpenCodeRuntimeError,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });
}

function toProcessError(
  provider: OpenCodeCompatibleProvider,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function rememberOpenCodeMessageSnapshot(
  context: OpenCodeSessionContext,
  snapshot: OpenCodeMessageSnapshot,
): void {
  context.messageRoleById.set(snapshot.info.id, snapshot.info.role);
  context.messageSnapshotKeyById.set(snapshot.info.id, openCodeSnapshotKey(snapshot.info));

  for (const part of snapshot.parts) {
    context.partById.set(part.id, part);
    context.partSnapshotKeyById.set(part.id, openCodeSnapshotKey(part));

    const text = textFromPart(part);
    if (text !== undefined) {
      context.emittedTextByPartId.set(part.id, text);
    }
    if (
      part.type === "text" &&
      shouldProjectOpenCodeTextPart(part) &&
      part.time?.end !== undefined
    ) {
      context.completedAssistantPartIds.add(part.id);
    }
  }
}

function ensureSessionContext(
  provider: OpenCodeCompatibleProvider,
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
    });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider,
      threadId,
    });
  }
  return session;
}

function bufferPendingTextDelta(
  context: OpenCodeSessionContext,
  partId: string,
  delta: string,
): void {
  if (delta.length === 0) {
    return;
  }
  const previousText = context.pendingTextDeltasByPartId.get(partId) ?? "";
  const { nextText } = appendOpenCodeAssistantTextDelta(previousText, delta);
  context.pendingTextDeltasByPartId.set(partId, nextText);
}

function applyPendingTextDeltaToPart(context: OpenCodeSessionContext, part: Part): Part {
  if (part.type !== "text" && part.type !== "reasoning") {
    context.pendingTextDeltasByPartId.delete(part.id);
    return part;
  }

  const pendingDelta = context.pendingTextDeltasByPartId.get(part.id);
  if (!pendingDelta || pendingDelta.length === 0) {
    return part;
  }

  const { nextText } = appendOpenCodeAssistantTextDelta(part.text, pendingDelta);
  context.pendingTextDeltasByPartId.delete(part.id);
  return nextText === part.text ? part : { ...part, text: nextText };
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

function clearActiveTurnState(context: OpenCodeSessionContext): void {
  context.activeTurnId = undefined;
  context.activeTurnEventSerial = 0;
  context.activeTurnProviderActivitySerial = 0;
  context.activeTurnCompletionActivitySerial = 0;
  context.activeTurnSawToolCallFinish = false;
  context.activeTurnSawFinalAssistant = false;
  context.activeTurnToolCallIdleWatchdogStarted = false;
  context.activeInteractionMode = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.latestTurnCostUsd = undefined;
}

function markOpenCodeTurnProviderActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnProviderActivitySerial += 1;
}

function markOpenCodeTurnCompletionActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnCompletionActivitySerial += 1;
}

function openCodeNextTextItemId(turnId: TurnId): string {
  return `${turnId}-next-text`;
}

function isOpenCodeCompletedAssistantMessage(
  entry: OpenCodeMessageSnapshot & { readonly info: Record<string, unknown> },
): boolean {
  if (entry.info.role !== "assistant") {
    return false;
  }
  const finish = trimNonEmptyString(entry.info.finish);
  if (finish !== undefined && !isOpenCodeTerminalStepFinish(finish)) {
    return false;
  }
  const time = entry.info.time;
  if (
    time &&
    typeof time === "object" &&
    !Array.isArray(time) &&
    typeof (time as { completed?: unknown }).completed === "number"
  ) {
    return true;
  }
  return finish !== undefined;
}

function trackActiveTurnAssistantFinish(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  entry: OpenCodeMessageSnapshot & { readonly info: Record<string, unknown> },
): void {
  if (!turnId || context.activeTurnId !== turnId || entry.info.role !== "assistant") {
    return;
  }
  if (isOpenCodeToolCallFinish(entry.info.finish)) {
    context.activeTurnSawToolCallFinish = true;
  }
  if (isOpenCodeCompletedAssistantMessage(entry)) {
    context.activeTurnSawFinalAssistant = true;
    markOpenCodeTurnCompletionActivity(context, turnId);
  }
}

function subscribedEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  if (!("properties" in event)) {
    return undefined;
  }

  const properties = event.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return undefined;
  }

  const sessionId = (properties as { readonly sessionID?: unknown }).sessionID;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function shouldHandleSubscribedEvent(
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
): boolean {
  const sessionId = subscribedEventSessionId(event);
  if (sessionId !== undefined) {
    return sessionId === context.openCodeSessionId;
  }

  return (
    context.activeTurnId !== undefined &&
    (event.type === "session.error" || event.type === "session.idle")
  );
}

function isOpenCodeTurnProviderActivityEvent(
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
): boolean {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.role === "assistant";
    case "message.part.delta": {
      const part = context.partById.get(event.properties.partID);
      return part ? messageRoleForPart(context, part) === "assistant" : false;
    }
    case "message.part.updated":
      return messageRoleForPart(context, event.properties.part) === "assistant";
    case "session.status":
      return event.properties.status.type === "busy" || event.properties.status.type === "retry";
    case "permission.asked":
    case "question.asked":
    case "todo.updated":
    case "session.compacted":
    case "session.error":
    case "session.idle":
      return true;
    default:
      return event.type.startsWith("session.next.");
  }
}

function replaceModelContextLimits(
  context: OpenCodeSessionContext,
  limits: ReadonlyMap<string, number>,
): void {
  context.modelContextLimitBySlug.clear();
  for (const [slug, limit] of limits) {
    context.modelContextLimitBySlug.set(slug, limit);
  }
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }

  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  yield* Scope.close(context.sessionScope, Exit.void);
});

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  const adapterConfig = options?.adapterConfig ?? OPENCODE_ADAPTER_CONFIG;
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const provider = adapterConfig.provider;
      const buildEventBase = (
        input: Omit<
          Parameters<typeof buildProviderEventBase>[0],
          "provider" | "runtimeEventSource"
        >,
      ) =>
        buildProviderEventBase({
          provider,
          runtimeEventSource: adapterConfig.runtimeEventSource,
          ...input,
        });
      const toAdapterRequestError = (cause: OpenCodeRuntimeError) =>
        toRequestError(provider, cause);
      const toAdapterProcessError = (threadId: ThreadId, cause: unknown) =>
        toProcessError(provider, threadId, cause);
      const ensureAdapterSessionContext = (threadId: ThreadId) =>
        ensureSessionContext(provider, sessions, threadId);
      const promptAcceptedActivityTimeoutMs =
        options?.promptAcceptedActivityTimeoutMs ?? OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS;
      const promptAcceptedRecoveryDelaysMs =
        options?.promptAcceptedRecoveryDelaysMs?.filter(
          (delayMs) => Number.isFinite(delayMs) && delayMs > 0,
        ) ?? OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS;
      const promptSubmissionInlineWaitMs =
        options?.promptSubmissionInlineWaitMs ?? OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS;
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          if (managedNativeEventLogger !== undefined) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
      const writeNativeEvent = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

      const emitContextCompactionProgress = Effect.fn("emitContextCompactionProgress")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly detail?: string | undefined;
          readonly raw?: unknown;
          readonly data?: unknown;
        },
      ) {
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "item.updated",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: input.detail ?? "Compacting context",
            ...(input.data !== undefined ? { data: input.data } : {}),
          },
        });
      });

      const emitContextCompacted = Effect.fn("emitContextCompacted")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly raw?: unknown;
        },
      ) {
        updateProviderSession(
          context,
          {
            status: context.activeTurnId ? "running" : "ready",
          },
          { clearLastError: true },
        );
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: { source: provider },
          },
        });
      });

      const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
        context: OpenCodeSessionContext,
        message: string,
      ) {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        yield* emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable: false,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.ignore({ log: true }));
        yield* Scope.close(context.sessionScope, Exit.void);
      });

      const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ) {
        const text = textFromPart(part);
        if (text === undefined) {
          return;
        }
        const nextTextItemId =
          turnId && part.type === "text" ? openCodeNextTextItemId(turnId) : undefined;
        const itemId =
          nextTextItemId && context.emittedTextByPartId.has(nextTextItemId)
            ? nextTextItemId
            : part.id;
        const previousText = context.emittedTextByPartId.get(itemId);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(itemId, latestText);
        if (itemId !== part.id) {
          context.emittedTextByPartId.set(part.id, latestText);
        }
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          markOpenCodeTurnCompletionActivity(context, turnId);
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(itemId)
        ) {
          context.completedAssistantPartIds.add(itemId);
          if (itemId !== part.id) {
            context.completedAssistantPartIds.add(part.id);
          }
          const proposedPlanMarkdown =
            context.activeInteractionMode === "plan"
              ? extractProposedPlanMarkdown(latestText)
              : undefined;
          if (proposedPlanMarkdown && turnId) {
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              }),
              type: "turn.proposed.completed",
              payload: {
                planMarkdown: proposedPlanMarkdown,
              },
            });
          }
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      });

      const emitRecoveredAssistantTextDelta = Effect.fn("emitRecoveredAssistantTextDelta")(
        function* (context: OpenCodeSessionContext, part: Part, turnId: TurnId, raw: unknown) {
          const text = textFromPart(part);
          const nextTextItemId = openCodeNextTextItemId(turnId);
          if (
            text === undefined ||
            part.type !== "text" ||
            !context.emittedTextByPartId.has(nextTextItemId)
          ) {
            yield* emitAssistantTextDelta(context, part, turnId, raw);
            return;
          }

          const previousText = context.emittedTextByPartId.get(nextTextItemId);
          const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
          context.emittedTextByPartId.set(nextTextItemId, latestText);
          context.emittedTextByPartId.set(part.id, latestText);
          context.partById.set(part.id, { ...part, text: latestText });
          if (deltaToEmit.length > 0) {
            markOpenCodeTurnCompletionActivity(context, turnId);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time?.start),
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
          }

          if (part.time?.end !== undefined) {
            if (context.completedAssistantPartIds.has(nextTextItemId)) {
              context.completedAssistantPartIds.add(part.id);
              return;
            }
            context.completedAssistantPartIds.add(nextTextItemId);
            context.completedAssistantPartIds.add(part.id);
            const proposedPlanMarkdown =
              context.activeInteractionMode === "plan"
                ? extractProposedPlanMarkdown(latestText)
                : undefined;
            if (proposedPlanMarkdown) {
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: nextTextItemId,
                  createdAt: isoFromEpochMs(part.time.end),
                  raw,
                }),
                type: "turn.proposed.completed",
                payload: {
                  planMarkdown: proposedPlanMarkdown,
                },
              });
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(latestText.length > 0 ? { detail: latestText } : {}),
              },
            });
          }
        },
      );

      const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly raw: unknown;
          readonly totalCostUsd?: number | undefined;
          readonly errorMessage?: string | undefined;
        },
      ) {
        clearActiveTurnState(context);
        updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "turn.completed",
          payload: input.errorMessage
            ? {
                state: "failed",
                errorMessage: input.errorMessage,
              }
            : {
                state: "completed",
                ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
              },
        });
      });

      const deferPrematureIdleCompletion = Effect.fn("deferPrematureIdleCompletion")(function* (
        context: OpenCodeSessionContext,
        turnId: TurnId,
        raw: unknown,
      ) {
        const idleBeforeAssistantActivity = context.activeTurnCompletionActivitySerial === 0;
        const idleAfterToolCalls =
          context.activeTurnSawToolCallFinish && !context.activeTurnSawFinalAssistant;
        if (!idleBeforeAssistantActivity && !idleAfterToolCalls) {
          return false;
        }
        if (!context.activeTurnToolCallIdleWatchdogStarted) {
          context.activeTurnToolCallIdleWatchdogStarted = true;
          yield* Effect.gen(function* () {
            yield* Effect.sleep(10_000);
            if (
              (yield* Ref.get(context.stopped)) ||
              context.activeTurnId !== turnId ||
              context.activeTurnSawFinalAssistant
            ) {
              return;
            }

            const message = idleAfterToolCalls
              ? `${adapterConfig.displayName} became idle after tool calls without producing a final assistant response.`
              : `${adapterConfig.displayName} became idle before producing an assistant response.`;
            yield* completeOpenCodeTurn(context, {
              turnId,
              raw: {
                source: "dpcode.opencode.idle-after-tool-calls",
                event: raw,
              },
              errorMessage: message,
            });
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: {
                  source: "dpcode.opencode.idle-after-tool-calls",
                  event: raw,
                },
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
              },
            });
          }).pipe(Effect.forkIn(context.sessionScope), Effect.asVoid);
        }
        return true;
      });

      const recoverOpenCodeTurnFromAssistantMessage = Effect.fn(
        "recoverOpenCodeTurnFromAssistantMessage",
      )(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly assistantEntry: OpenCodeMessageSnapshot & {
            readonly info: Record<string, unknown>;
          };
          readonly raw: unknown;
        },
      ) {
        context.messageRoleById.set(input.assistantEntry.info.id, "assistant");
        trackActiveTurnAssistantFinish(context, input.turnId, input.assistantEntry);
        for (const part of input.assistantEntry.parts) {
          context.partById.set(part.id, part);
          yield* emitRecoveredAssistantTextDelta(context, part, input.turnId, input.raw);
        }

        const selectedModel = context.session.model;
        const maxTokens =
          selectedModel !== undefined
            ? context.modelContextLimitBySlug.get(selectedModel)
            : undefined;
        const normalizedUsage = normalizeOpenCodeTokenUsage(
          (input.assistantEntry.info as Partial<AssistantMessage>).tokens,
          maxTokens,
        );
        if (normalizedUsage !== undefined) {
          context.lastKnownTokenUsage = normalizedUsage;
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: input.turnId,
              raw: input.raw,
            }),
            type: "thread.token-usage.updated",
            payload: {
              usage: normalizedUsage,
            },
          });
        }
        const cost = asFiniteNonNegativeNumber(
          (input.assistantEntry.info as Partial<AssistantMessage>).cost,
        );
        context.latestTurnCostUsd = cost;
        yield* completeOpenCodeTurn(context, {
          turnId: input.turnId,
          raw: input.raw,
          totalCostUsd: cost,
        });
        return true;
      });

      const recoverOpenCodeTurnFromMessages = Effect.fn("recoverOpenCodeTurnFromMessages")(
        function* (
          context: OpenCodeSessionContext,
          input: {
            readonly turnId: TurnId;
            readonly excludedMessageIds: ReadonlySet<string>;
          },
        ) {
          const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.succeed(
                null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null,
              ),
            ),
          );
          if (!messagesResponse) {
            return false;
          }

          const assistantEntry = (messagesResponse.data ?? [])
            .flatMap((entry) =>
              entry.info.role === "assistant" && !input.excludedMessageIds.has(entry.info.id)
                ? [
                    {
                      info: entry.info,
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot & {
                      readonly info: Record<string, unknown>;
                    },
                  ]
                : [],
            )
            .findLast(isOpenCodeCompletedAssistantMessage);
          if (!assistantEntry) {
            return false;
          }

          return yield* recoverOpenCodeTurnFromAssistantMessage(context, {
            turnId: input.turnId,
            assistantEntry,
            raw: {
              source: "dpcode.opencode.prompt.recovery",
              message: assistantEntry,
            },
          });
        },
      );

      const captureOpenCodeRecoveryBaseline = Effect.fn("captureOpenCodeRecoveryBaseline")(
        function* (context: OpenCodeSessionContext) {
          const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.succeed(
                null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null,
              ),
            ),
          );
          const baselineIds = new Set<string>();
          for (const id of context.messageRoleById.keys()) {
            baselineIds.add(id);
          }
          for (const entry of messagesResponse?.data ?? []) {
            if (typeof entry.info.id === "string") {
              baselineIds.add(entry.info.id);
            }
          }
          return baselineIds;
        },
      );

      const schedulePromptAcceptedWatchdog = Effect.fn("schedulePromptAcceptedWatchdog")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly providerActivitySerial: number;
          readonly excludedMessageIds: ReadonlySet<string>;
        },
      ) {
        yield* Effect.gen(function* () {
          for (const delayMs of promptAcceptedRecoveryDelaysMs) {
            yield* Effect.sleep(delayMs);
            if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== input.turnId) {
              break;
            }
            const recovered = yield* recoverOpenCodeTurnFromMessages(context, {
              turnId: input.turnId,
              excludedMessageIds: input.excludedMessageIds,
            });
            if (recovered) {
              break;
            }
          }
        }).pipe(
          Effect.flatMap(() => Effect.sleep(promptAcceptedActivityTimeoutMs)),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              if (
                context.activeTurnId !== input.turnId ||
                context.activeTurnProviderActivitySerial !== input.providerActivitySerial
              ) {
                return;
              }

              const message =
                "OpenCode did not produce any activity for this prompt. The session may be stuck; try sending again or restart OpenCode.";
              yield* completeOpenCodeTurn(context, {
                turnId: input.turnId,
                raw: { source: "dpcode.opencode.prompt.watchdog" },
                errorMessage: message,
              });
              updateProviderSession(
                context,
                {
                  status: "error",
                  lastError: message,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: input.turnId,
                  raw: { source: "dpcode.opencode.prompt.watchdog" },
                }),
                type: "runtime.error",
                payload: {
                  message,
                  class: "transport_error",
                },
              });
            }),
          ),
          Effect.forkIn(context.sessionScope),
          Effect.asVoid,
        );
      });

      const submitOpenCodePrompt = Effect.fn("submitOpenCodePrompt")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly promptInput: Parameters<OpencodeClient["session"]["prompt"]>[0];
        },
      ) {
        const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();

        // Keep the documented prompt request off the command path; SSE streams live
        // updates, and the final HTTP response lets us recover if events are missed.
        yield* runOpenCodeSdk("session.prompt", () =>
          context.client.session.prompt(input.promptInput),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return null;
              }
              if (context.activeTurnId !== input.turnId) {
                return null;
              }
              const assistantEntry =
                response.data && response.data.info.role === "assistant"
                  ? ({
                      info: response.data.info,
                      parts: response.data.parts,
                    } satisfies OpenCodeMessageSnapshot & {
                      readonly info: Record<string, unknown>;
                    })
                  : null;
              if (assistantEntry && isOpenCodeCompletedAssistantMessage(assistantEntry)) {
                yield* recoverOpenCodeTurnFromAssistantMessage(context, {
                  turnId: input.turnId,
                  assistantEntry,
                  raw: {
                    source: "dpcode.opencode.prompt.response",
                    message: assistantEntry,
                  },
                });
              }
              return null;
            }),
          ),
          Effect.catch((requestError) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return requestError;
              }
              if (
                context.activeTurnId !== input.turnId ||
                context.activeTurnProviderActivitySerial > 0
              ) {
                return requestError;
              }
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
              return requestError;
            }),
          ),
          Effect.flatMap((result) => Deferred.succeed(settled, result)),
          Effect.forkIn(context.sessionScope),
        );

        const quickResult = yield* Deferred.await(settled).pipe(
          Effect.timeoutOption(promptSubmissionInlineWaitMs),
        );
        if (quickResult._tag === "Some" && quickResult.value) {
          return yield* quickResult.value;
        }
      });

      const submitOpenCodePromptAsync = Effect.fn("submitOpenCodePromptAsync")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly promptInput: Parameters<OpencodeClient["session"]["promptAsync"]>[0];
        },
      ) {
        const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();
        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync(input.promptInput),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.as(null),
          Effect.catch((requestError) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return requestError;
              }
              if (context.activeTurnId !== input.turnId) {
                return requestError;
              }
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
              return requestError;
            }),
          ),
          Effect.flatMap((result) => Deferred.succeed(settled, result)),
          Effect.forkIn(context.sessionScope),
        );

        const quickResult = yield* Deferred.await(settled).pipe(
          Effect.timeoutOption(promptSubmissionInlineWaitMs),
        );
        if (quickResult._tag === "Some" && quickResult.value) {
          return yield* quickResult.value;
        }
      });

      const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
        context: OpenCodeSessionContext,
        event: OpenCodeSubscribedEvent,
      ) {
        if (!shouldHandleSubscribedEvent(context, event)) {
          return;
        }

        const turnId = context.activeTurnId;
        if (turnId) {
          context.activeTurnEventSerial += 1;
          // User-message echoes should not disable prompt recovery; track provider-side
          // activity separately for the "accepted but nothing started" watchdog.
          if (isOpenCodeTurnProviderActivityEvent(context, event)) {
            markOpenCodeTurnProviderActivity(context, turnId);
          }
        }
        yield* writeNativeEventBestEffort(context.session.threadId, {
          observedAt: nowIso(),
          event: {
            provider,
            threadId: context.session.threadId,
            providerThreadId: context.openCodeSessionId,
            type: event.type,
            ...(turnId ? { turnId } : {}),
            payload: event,
          },
        });

        switch (event.type) {
          case "message.updated": {
            context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
            context.messageSnapshotKeyById.set(
              event.properties.info.id,
              openCodeSnapshotKey(event.properties.info),
            );
            if (event.properties.info.role === "assistant") {
              const assistantMessage = event.properties.info;
              trackActiveTurnAssistantFinish(context, turnId, {
                info: {
                  ...assistantMessage,
                  role: "assistant",
                },
                parts: [],
              });
              const selectedModel = context.session.model;
              const maxTokens =
                selectedModel !== undefined
                  ? context.modelContextLimitBySlug.get(selectedModel)
                  : undefined;
              const normalizedUsage = normalizeOpenCodeTokenUsage(
                assistantMessage.tokens,
                maxTokens,
              );
              const usageKey =
                normalizedUsage !== undefined
                  ? buildOpenCodeTokenUsageKey({
                      messageId: assistantMessage.id,
                      tokens: assistantMessage.tokens,
                      maxTokens,
                    })
                  : undefined;
              const cost = asFiniteNonNegativeNumber(assistantMessage.cost);
              if (cost !== undefined) {
                context.latestTurnCostUsd = cost;
              }
              if (
                normalizedUsage !== undefined &&
                usageKey !== undefined &&
                usageKey !== context.lastEmittedTokenUsageKey
              ) {
                context.lastKnownTokenUsage = normalizedUsage;
                context.lastEmittedTokenUsageKey = usageKey;
                yield* emit({
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    raw: event,
                  }),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }

              for (const part of context.partById.values()) {
                if (part.messageID !== event.properties.info.id) {
                  continue;
                }
                const resolvedPart = applyPendingTextDeltaToPart(context, part);
                if (resolvedPart !== part) {
                  context.partById.set(resolvedPart.id, resolvedPart);
                }
                yield* emitAssistantTextDelta(context, resolvedPart, turnId, event);
              }
            }
            break;
          }

          case "message.removed": {
            context.messageRoleById.delete(event.properties.messageID);
            context.messageSnapshotKeyById.delete(event.properties.messageID);
            break;
          }

          case "message.part.delta": {
            const delta = event.properties.delta;
            if (delta.length === 0) {
              break;
            }
            const existingPart = context.partById.get(event.properties.partID);
            if (!existingPart) {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            const resolvedPart = applyPendingTextDeltaToPart(context, existingPart);
            if (resolvedPart !== existingPart) {
              context.partById.set(event.properties.partID, resolvedPart);
            }
            const role = messageRoleForPart(context, resolvedPart);
            if (role !== "assistant") {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            if (!shouldProjectOpenCodeTextPart(resolvedPart)) {
              break;
            }
            const streamKind = resolveTextStreamKind(resolvedPart);
            const previousText =
              context.emittedTextByPartId.get(event.properties.partID) ??
              textFromPart(resolvedPart) ??
              "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
            if (deltaToEmit.length === 0) {
              break;
            }
            markOpenCodeTurnCompletionActivity(context, turnId);
            context.emittedTextByPartId.set(event.properties.partID, nextText);
            if (resolvedPart.type === "text" || resolvedPart.type === "reasoning") {
              const nextPart = {
                ...resolvedPart,
                text: nextText,
              } satisfies Part;
              context.partById.set(event.properties.partID, nextPart);
              context.partSnapshotKeyById.set(
                event.properties.partID,
                openCodeSnapshotKey(nextPart),
              );
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind,
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "message.part.updated": {
            const part = applyPendingTextDeltaToPart(context, event.properties.part);
            context.partById.set(part.id, part);
            context.partSnapshotKeyById.set(part.id, openCodeSnapshotKey(part));
            const messageRole = messageRoleForPart(context, part);

            if (messageRole === "assistant") {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }

            if (part.type === "tool") {
              const itemType = toToolLifecycleItemType(part.tool);
              const title =
                part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
              const detail = detailFromToolPart(part);
              const payload = {
                itemType,
                ...(part.state.status === "error"
                  ? { status: "failed" as const }
                  : part.state.status === "completed"
                    ? { status: "completed" as const }
                    : { status: "inProgress" as const }),
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                data: {
                  tool: part.tool,
                  toolName: part.tool,
                  toolCallId: part.callID,
                  callID: part.callID,
                  ...("input" in part.state ? { input: part.state.input } : {}),
                  state: part.state,
                },
              };
              const runtimeEvent: ProviderRuntimeEvent = {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.callID,
                  createdAt: toolStateCreatedAt(part),
                  raw: event,
                }),
                type:
                  part.state.status === "pending"
                    ? "item.started"
                    : part.state.status === "completed" || part.state.status === "error"
                      ? "item.completed"
                      : "item.updated",
                payload,
              };
              appendTurnItem(context, turnId, part);
              yield* emit(runtimeEvent);
            }

            if (part.type === "compaction") {
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: part.overflow
                  ? "Compacting context after provider context overflow"
                  : "Compacting context",
                data: {
                  auto: part.auto,
                  ...(part.overflow !== undefined ? { overflow: part.overflow } : {}),
                  ...(part.tail_start_id ? { tailStartId: part.tail_start_id } : {}),
                },
              });
            }
            break;
          }

          case "permission.asked": {
            context.pendingPermissions.set(event.properties.id, event.properties);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "request.opened",
              payload: {
                requestType: mapPermissionToRequestType(event.properties.permission),
                detail:
                  event.properties.patterns.length > 0
                    ? event.properties.patterns.join("\n")
                    : event.properties.permission,
                args: event.properties.metadata,
              },
            });
            break;
          }

          case "permission.replied": {
            context.pendingPermissions.delete(event.properties.requestID);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "request.resolved",
              payload: {
                requestType: "unknown",
                decision: mapPermissionDecision(event.properties.reply),
              },
            });
            break;
          }

          case "question.asked": {
            context.pendingQuestions.set(event.properties.id, event.properties);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "user-input.requested",
              payload: {
                questions: normalizeQuestionRequest(event.properties),
              },
            });
            break;
          }

          case "question.replied": {
            const request = context.pendingQuestions.get(event.properties.requestID);
            context.pendingQuestions.delete(event.properties.requestID);
            const answers = Object.fromEntries(
              (request?.questions ?? []).map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            );
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers },
            });
            break;
          }

          case "question.rejected": {
            context.pendingQuestions.delete(event.properties.requestID);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            });
            break;
          }

          case "todo.updated": {
            const tasksPayload = normalizeOpenCodeTodoTasks(event.properties.todos);
            if (!tasksPayload) {
              break;
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              }),
              type: "turn.tasks.updated",
              payload: tasksPayload,
            });
            break;
          }

          case "session.status": {
            if (event.properties.status.type === "busy") {
              updateProviderSession(context, {
                status: "running",
                activeTurnId: turnId,
              });
            }

            if (event.properties.status.type === "retry") {
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "runtime.warning",
                payload: {
                  message: event.properties.status.message,
                  detail: event.properties.status,
                },
              });
              break;
            }

            if (event.properties.status.type === "idle" && turnId) {
              if (yield* deferPrematureIdleCompletion(context, turnId, event)) {
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.idle": {
            if (turnId) {
              if (yield* deferPrematureIdleCompletion(context, turnId, event)) {
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          // Newer OpenCode servers can emit session.next.* events for the active
          // agent loop. Mirror them into Synara's canonical transcript stream.
          case "session.next.text.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(
              previousText,
              event.properties.delta,
            );
            if (deltaToEmit.length === 0) {
              break;
            }
            context.emittedTextByPartId.set(itemId, nextText);
            markOpenCodeTurnCompletionActivity(context, turnId);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "session.next.text.ended": {
            if (!turnId) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const text = event.properties.text;
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
            context.emittedTextByPartId.set(itemId, latestText);
            if (deltaToEmit.length > 0) {
              markOpenCodeTurnCompletionActivity(context, turnId);
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: deltaToEmit,
                },
              });
            }
            if (!context.completedAssistantPartIds.has(itemId)) {
              context.completedAssistantPartIds.add(itemId);
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  ...(latestText.length > 0 ? { detail: latestText } : {}),
                },
              });
            }
            break;
          }

          case "session.next.reasoning.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.properties.delta,
              },
            });
            break;
          }

          case "session.next.reasoning.ended": {
            if (!turnId) {
              break;
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                ...(event.properties.text ? { detail: event.properties.text } : {}),
              },
            });
            break;
          }

          case "session.next.tool.called": {
            if (!turnId) {
              break;
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: toToolLifecycleItemType(event.properties.tool),
                status: "inProgress",
                title: event.properties.tool,
                data: {
                  tool: event.properties.tool,
                  toolName: event.properties.tool,
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  input: event.properties.input,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.tool.progress":
          case "session.next.tool.success": {
            if (!turnId) {
              break;
            }
            const detail = openCodeToolContentText(event.properties.content);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: event.type === "session.next.tool.success" ? "item.completed" : "item.updated",
              payload: {
                itemType: "dynamic_tool_call",
                status: event.type === "session.next.tool.success" ? "completed" : "inProgress",
                ...(detail ? { detail } : {}),
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  structured: event.properties.structured,
                  content: event.properties.content,
                  ...("provider" in event.properties
                    ? { provider: event.properties.provider }
                    : {}),
                },
              },
            });
            break;
          }

          case "session.next.tool.failed": {
            if (!turnId) {
              break;
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "dynamic_tool_call",
                status: "failed",
                detail: event.properties.error.message,
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  error: event.properties.error,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.step.ended": {
            if (!turnId) {
              break;
            }
            const selectedModel = context.session.model;
            const maxTokens =
              selectedModel !== undefined
                ? context.modelContextLimitBySlug.get(selectedModel)
                : undefined;
            const normalizedUsage = normalizeOpenCodeTokenUsage(event.properties.tokens, maxTokens);
            if (normalizedUsage !== undefined) {
              context.lastKnownTokenUsage = normalizedUsage;
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "thread.token-usage.updated",
                payload: {
                  usage: normalizedUsage,
                },
              });
            }
            context.latestTurnCostUsd = asFiniteNonNegativeNumber(event.properties.cost);
            if (isOpenCodeToolCallFinish(event.properties.finish)) {
              context.activeTurnSawToolCallFinish = true;
            }
            if (isOpenCodeTerminalStepFinish(event.properties.finish)) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.next.step.failed": {
            const message = event.properties.error.message || "OpenCode session failed.";
            if (turnId) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                errorMessage: message,
              });
            }
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          case "session.next.retried": {
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "runtime.warning",
              payload: {
                message: event.properties.error.message,
                detail: event.properties,
              },
            });
            break;
          }

          case "session.compacted": {
            yield* emitContextCompacted(context, { turnId, raw: event });
            break;
          }

          case "session.error": {
            const message = sessionErrorMessage(event.properties.error);
            if (isOpenCodeContextOverflowError(event.properties.error)) {
              updateProviderSession(
                context,
                {
                  status: "running",
                },
                { clearLastError: true },
              );
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: message,
                data: {
                  state: "context_overflow",
                },
              });
              break;
            }
            const activeTurnId = context.activeTurnId;
            clearActiveTurnState(context);
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            if (activeTurnId) {
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          default:
            break;
        }
      });

      const loadCurrentMessageSnapshots = Effect.fn("loadCurrentMessageSnapshots")(function* (
        context: OpenCodeSessionContext,
      ) {
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        );
        return openCodeMessageSnapshotsFromResponse(messages.data ?? []);
      });

      const rememberCurrentMessageSnapshots = Effect.fn("rememberCurrentMessageSnapshots")(
        function* (context: OpenCodeSessionContext) {
          const snapshots = yield* loadCurrentMessageSnapshots(context);
          for (const snapshot of snapshots) {
            rememberOpenCodeMessageSnapshot(context, snapshot);
          }
          return new Set(snapshots.map((snapshot) => snapshot.info.id));
        },
      );

      const replayOpenCodeMessageSnapshots = Effect.fn("replayOpenCodeMessageSnapshots")(function* (
        context: OpenCodeSessionContext,
        snapshots: ReadonlyArray<OpenCodeMessageSnapshot>,
        turnId: TurnId,
      ) {
        for (const snapshot of snapshots) {
          const messageKey = openCodeSnapshotKey(snapshot.info);
          if (context.messageSnapshotKeyById.get(snapshot.info.id) !== messageKey) {
            yield* handleSubscribedEvent(context, {
              type: "message.updated",
              properties: {
                sessionID: context.openCodeSessionId,
                info: snapshot.info,
              },
            } as OpenCodeSubscribedEvent);
          }

          for (const part of snapshot.parts) {
            const partKey = openCodeSnapshotKey(part);
            if (context.partSnapshotKeyById.get(part.id) === partKey) {
              continue;
            }
            yield* handleSubscribedEvent(context, {
              type: "message.part.updated",
              properties: {
                sessionID: context.openCodeSessionId,
                part,
              },
            } as OpenCodeSubscribedEvent);
          }
        }

        if (context.activeTurnId !== turnId) {
          return;
        }
      });

      const startKiloTurnSnapshotWatchdog = Effect.fn("startKiloTurnSnapshotWatchdog")(function* (
        context: OpenCodeSessionContext,
        turnId: TurnId,
        baselineMessageIds: ReadonlySet<string>,
      ) {
        yield* Effect.gen(function* () {
          let idlePollsWithFinalMessage = 0;

          while (!(yield* Ref.get(context.stopped)) && context.activeTurnId === turnId) {
            yield* Effect.sleep(500);

            const snapshotsExit = yield* Effect.exit(loadCurrentMessageSnapshots(context));
            let hasFinalAssistantMessage = false;
            if (Exit.isSuccess(snapshotsExit)) {
              yield* replayOpenCodeMessageSnapshots(context, snapshotsExit.value, turnId);
              hasFinalAssistantMessage = snapshotsExit.value.some(
                (snapshot) =>
                  !baselineMessageIds.has(snapshot.info.id) &&
                  isFinalAssistantMessageSnapshot(snapshot),
              );
            }

            const statusExit = yield* Effect.exit(
              runOpenCodeSdk("session.status", () =>
                context.client.session.status({
                  directory: context.directory,
                }),
              ),
            );
            if (!Exit.isSuccess(statusExit)) {
              idlePollsWithFinalMessage = 0;
              continue;
            }

            const status = statusExit.value.data?.[context.openCodeSessionId];
            if (status?.type === "busy" || status?.type === "retry") {
              idlePollsWithFinalMessage = 0;
              continue;
            }

            idlePollsWithFinalMessage = hasFinalAssistantMessage
              ? idlePollsWithFinalMessage + 1
              : 0;
            if (idlePollsWithFinalMessage < 1 || context.activeTurnId !== turnId) {
              continue;
            }

            yield* handleSubscribedEvent(context, {
              type: "session.status",
              properties: {
                sessionID: context.openCodeSessionId,
                status: {
                  type: "idle",
                },
              },
            } as OpenCodeSubscribedEvent);
            return;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            writeNativeEventBestEffort(context.session.threadId, {
              observedAt: nowIso(),
              event: {
                provider,
                threadId: context.session.threadId,
                providerThreadId: context.openCodeSessionId,
                type: "turn.snapshot-watchdog.error",
                turnId,
                detail: openCodeRuntimeErrorDetail(Cause.squash(cause)),
              },
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      });

      const startEventPump = Effect.fn("startEventPump")(function* (
        context: OpenCodeSessionContext,
      ) {
        const eventsAbortController = new AbortController();
        yield* Scope.addFinalizer(
          context.sessionScope,
          Effect.sync(() => eventsAbortController.abort()),
        );

        yield* Effect.flatMap(
          runOpenCodeSdk("event.subscribe", () =>
            context.client.event.subscribe(undefined, {
              signal: eventsAbortController.signal,
            }),
          ),
          (subscription) =>
            Stream.fromAsyncIterable(
              subscription.stream,
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "event.subscribe",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
        ).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
                return;
              }
              if (Exit.isFailure(exit)) {
                yield* emitUnexpectedExit(
                  context,
                  openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
                );
              }
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );

        if (!context.server.external && context.server.exitCode !== null) {
          yield* context.server.exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.gen(function* () {
                if (yield* Ref.get(context.stopped)) {
                  return;
                }
                yield* emitUnexpectedExit(
                  context,
                  `${adapterConfig.displayName} server exited unexpectedly (${code}).`,
                );
              }),
            ),
            Effect.forkIn(context.sessionScope),
          );
        }
      });

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = providerOptions?.serverPassword?.trim();
          const directory = input.cwd ?? serverConfig.cwd;
          const initialParsedModel =
            input.modelSelection?.provider === adapterConfig.provider
              ? parseOpenCodeModelSlug(input.modelSelection.model)
              : null;
          const initialAgent =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.agent
              : undefined;
          const initialVariant =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.variant
              : undefined;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopOpenCodeContext(existing);
            sessions.delete(input.threadId);
          }

          const resumedSessionId = extractResumeSessionId(input.resumeCursor);

          const started = yield* Effect.gen(function* () {
            const sessionScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath,
                  cliSpec: adapterConfig.cliSpec,
                  ...(serverUrl ? { serverUrl } : {}),
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory,
                  cliSpec: adapterConfig.cliSpec,
                  ...(server.external && serverPassword ? { serverPassword } : {}),
                });
                const openCodeSessionId =
                  resumedSessionId ??
                  (yield* runOpenCodeSdk("session.create", () => {
                    const sessionCreateInput = {
                      ...(initialParsedModel
                        ? {
                            model: {
                              providerID: initialParsedModel.providerID,
                              id: initialParsedModel.modelID,
                              ...(initialVariant ? { variant: initialVariant } : {}),
                            },
                          }
                        : {}),
                      ...(initialAgent ? { agent: initialAgent } : {}),
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                      title: `Synara ${input.threadId}`,
                    };
                    return client.session.create(
                      sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
                    );
                  }).pipe(
                    Effect.flatMap((sessionResult) =>
                      sessionResult.data?.id
                        ? Effect.succeed(sessionResult.data.id)
                        : Effect.fail(
                            new OpenCodeRuntimeError({
                              operation: "session.create",
                              detail: `${adapterConfig.displayName} session.create returned no session payload.`,
                            }),
                          ),
                    ),
                  ));

                return { sessionScope, server, client, openCodeSessionId };
              }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
            );
            if (Exit.isFailure(startedExit)) {
              yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
              return yield* toAdapterProcessError(input.threadId, Cause.squash(startedExit.cause));
            }
            return startedExit.value;
          });

          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({
                sessionID: started.openCodeSessionId,
              }),
            ).pipe(Effect.ignore);
            yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
            return raceWinner.session;
          }

          const createdAt = nowIso();
          const modelContextLimitBySlug = yield* openCodeRuntime
            .loadOpenCodeInventory(started.client)
            .pipe(
              Effect.map(buildOpenCodeModelContextLimitMap),
              Effect.catchCause(() => Effect.succeed(new Map<string, number>())),
            );
          const session: ProviderSession = {
            provider,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: { openCodeSessionId: started.openCodeSessionId },
            createdAt,
            updatedAt: createdAt,
          };

          const context: OpenCodeSessionContext = {
            session,
            client: started.client,
            server: started.server,
            directory,
            openCodeSessionId: started.openCodeSessionId,
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
            pendingTextDeltasByPartId: new Map(),
            partById: new Map(),
            partSnapshotKeyById: new Map(),
            emittedTextByPartId: new Map(),
            messageRoleById: new Map(),
            messageSnapshotKeyById: new Map(),
            completedAssistantPartIds: new Set(),
            turns: [],
            modelContextLimitBySlug,
            lastKnownTokenUsage: undefined,
            lastEmittedTokenUsageKey: undefined,
            latestTurnCostUsd: undefined,
            activeTurnId: undefined,
            activeTurnEventSerial: 0,
            activeTurnProviderActivitySerial: 0,
            activeTurnCompletionActivitySerial: 0,
            activeTurnSawToolCallFinish: false,
            activeTurnSawFinalAssistant: false,
            activeTurnToolCallIdleWatchdogStarted: false,
            activeInteractionMode: undefined,
            activeAgent: undefined,
            activeVariant: undefined,
            stopped: yield* Ref.make(false),
            sessionScope: started.sessionScope,
          };
          sessions.set(input.threadId, context);
          yield* startEventPump(context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: resumedSessionId
                ? `${adapterConfig.displayName} session resumed`
                : `${adapterConfig.displayName} session started`,
              resume: { openCodeSessionId: started.openCodeSessionId },
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: started.openCodeSessionId,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureAdapterSessionContext(input.threadId);
        const turnId = TurnId.makeUnsafe(`${adapterConfig.turnIdPrefix}-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model ? { provider, model: context.session.model } : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} model selection must use the 'provider/model' format.`,
          });
        }

        const text = withProviderPlanModePrompt({
          text: input.input?.trim() ?? "",
          interactionMode: input.interactionMode,
        }).trim();
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} turns require text input or at least one attachment.`,
          });
        }

        const agent =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.variant
            : undefined;

        context.activeTurnId = turnId;
        context.activeTurnEventSerial = 0;
        context.activeTurnProviderActivitySerial = 0;
        context.activeTurnCompletionActivitySerial = 0;
        context.activeTurnSawToolCallFinish = false;
        context.activeTurnSawFinalAssistant = false;
        context.activeTurnToolCallIdleWatchdogStarted = false;
        context.activeInteractionMode = input.interactionMode === "plan" ? "plan" : "default";
        // Always pin Synara's interaction mode to OpenCode's primary agent.
        // Otherwise a user config with default agent=plan can trap default turns in plan mode.
        context.activeAgent =
          agent ??
          (input.interactionMode === "plan" ? adapterConfig.planAgent : adapterConfig.defaultAgent);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        if (provider === "kilo") {
          const baselineMessageIds = yield* rememberCurrentMessageSnapshots(context).pipe(
            Effect.catchCause(() => Effect.succeed(new Set<string>())),
          );
          const recoveryBaselineMessageIds = yield* captureOpenCodeRecoveryBaseline(context);
          const providerActivitySerial = context.activeTurnProviderActivitySerial;
          yield* schedulePromptAcceptedWatchdog(context, {
            turnId,
            providerActivitySerial,
            excludedMessageIds: recoveryBaselineMessageIds,
          });
          yield* submitOpenCodePrompt(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              messageID: `msg_${randomUUID()}`,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              noReply: false,
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
            },
          });
          yield* startKiloTurnSnapshotWatchdog(context, turnId, baselineMessageIds);
        } else {
          yield* submitOpenCodePromptAsync(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
            },
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { openCodeSessionId: context.openCodeSessionId },
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureAdapterSessionContext(threadId);
          const activeTurnId = turnId ?? context.activeTurnId;
          yield* runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
          clearActiveTurnState(context);
          updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          if (activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureAdapterSessionContext(threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("permission.reply", () =>
          context.client.permission.reply({
            requestID: requestId,
            reply: toOpenCodePermissionReply(decision),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureAdapterSessionContext(threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("question.reply", () =>
          context.client.question.reply({
            requestID: requestId,
            answers: toOpenCodeQuestionAnswers(request, answers),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          yield* stopOpenCodeContext(context);
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return buildOpenCodeThreadSnapshot({
            threadId,
            messages: (messages.data ?? []).flatMap((entry) =>
              entry.info.role === "user" || entry.info.role === "assistant"
                ? [
                    {
                      info: {
                        id: entry.info.id,
                        role: entry.info.role,
                      },
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot,
                  ]
                : [],
            ),
            cwd: context.directory,
          });
        },
      );

      const readExternalThread: NonNullable<OpenCodeAdapterShape["readExternalThread"]> = (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = input.cwd ?? serverConfig.cwd;
            const server = yield* openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: adapterConfig.defaultBinaryPath,
                cliSpec: adapterConfig.cliSpec,
              })
              .pipe(Effect.mapError(toAdapterRequestError));
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory,
              cliSpec: adapterConfig.cliSpec,
            });
            const session = yield* runOpenCodeSdk("session.get", () =>
              client.session.get({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));
            const messages = yield* runOpenCodeSdk("session.messages", () =>
              client.session.messages({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));

            return buildOpenCodeThreadSnapshot({
              threadId: ThreadId.makeUnsafe(input.externalThreadId),
              messages: (messages.data ?? []).flatMap((entry) =>
                entry.info.role === "user" || entry.info.role === "assistant"
                  ? [
                      {
                        info: {
                          id: entry.info.id,
                          role: entry.info.role,
                        },
                        parts: entry.parts,
                      } satisfies OpenCodeMessageSnapshot,
                    ]
                  : [],
              ),
              cwd: session.data?.directory ?? directory,
            });
          }),
        );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              ...(target ? { messageID: target.info.id } : {}),
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return yield* readThread(threadId);
        },
      );

      const compactThread: NonNullable<OpenCodeAdapterShape["compactThread"]> = (threadId) =>
        Effect.gen(function* () {
          const context = ensureAdapterSessionContext(threadId);
          const parsedModel = parseOpenCodeModelSlug(context.session.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "compactThread",
              issue: `${adapterConfig.displayName} compaction requires a current 'provider/model' selection.`,
            });
          }

          yield* runOpenCodeSdk("session.summarize", () =>
            context.client.session.summarize({
              sessionID: context.openCodeSessionId,
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
        });

      const forkThread: NonNullable<OpenCodeAdapterShape["forkThread"]> = (input) =>
        Effect.gen(function* () {
          const sourceContext = sessions.get(input.sourceThreadId);
          const sourceSessionId =
            sourceContext?.openCodeSessionId ?? extractResumeSessionId(input.sourceResumeCursor);
          if (!sourceSessionId) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "forkThread",
              issue: `${adapterConfig.displayName} native fork requires a resumable source session id.`,
            });
          }

          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = providerOptions?.serverPassword?.trim();
          const directory = input.cwd ?? sourceContext?.directory ?? serverConfig.cwd;

          let client: OpencodeClient;
          if (sourceContext) {
            client = sourceContext.client;
          } else {
            client = yield* Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime
                  .connectToOpenCodeServer({
                    binaryPath,
                    cliSpec: adapterConfig.cliSpec,
                    ...(serverUrl ? { serverUrl } : {}),
                  })
                  .pipe(Effect.mapError(toAdapterRequestError));
                return openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory,
                  cliSpec: adapterConfig.cliSpec,
                  ...(server.external && serverPassword ? { serverPassword } : {}),
                });
              }),
            );
          }

          const forked = yield* runOpenCodeSdk("session.fork", () =>
            client.session.fork({
              sessionID: sourceSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const forkedSessionId = forked.data?.id?.trim();
          if (!forkedSessionId) {
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.fork",
              detail: `${adapterConfig.displayName} session.fork returned no session payload.`,
            });
          }

          const session = yield* startSession({
            threadId: input.threadId,
            provider,
            cwd: directory,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
            resumeCursor: { openCodeSessionId: forkedSessionId },
            runtimeMode: input.runtimeMode,
          });

          return {
            threadId: input.threadId,
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
          };
        });

      const withDiscoveryInventory = <A>(
        input: {
          readonly binaryPath?: string | null;
        },
        fn: (input: {
          readonly client: OpencodeClient;
          readonly inventory: OpenCodeInventory;
          readonly credentialProviderIDs: ReadonlyArray<string>;
        }) => Effect.Effect<A, ProviderAdapterRequestError>,
      ): Effect.Effect<A, ProviderAdapterRequestError> =>
        Effect.gen(function* () {
          const activeContext = [...sessions.values()][0];
          if (activeContext) {
            const inventory = yield* openCodeRuntime
              .loadOpenCodeInventory(activeContext.client)
              .pipe(Effect.mapError(toAdapterRequestError));
            replaceModelContextLimits(activeContext, buildOpenCodeModelContextLimitMap(inventory));
            const credentialProviderIDs = yield* openCodeRuntime.loadOpenCodeCredentialProviderIDs(
              activeContext.client,
              adapterConfig.cliSpec,
            );
            return yield* fn({
              client: activeContext.client,
              inventory,
              credentialProviderIDs,
            });
          }

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* openCodeRuntime
                .connectToOpenCodeServer({
                  binaryPath: input.binaryPath?.trim() || adapterConfig.defaultBinaryPath,
                  cliSpec: adapterConfig.cliSpec,
                })
                .pipe(Effect.mapError(toAdapterRequestError));
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: serverConfig.cwd,
                cliSpec: adapterConfig.cliSpec,
              });
              const inventory = yield* openCodeRuntime
                .loadOpenCodeInventory(client)
                .pipe(Effect.mapError(toAdapterRequestError));
              const credentialProviderIDs =
                yield* openCodeRuntime.loadOpenCodeCredentialProviderIDs(
                  client,
                  adapterConfig.cliSpec,
                );
              return yield* fn({ client, inventory, credentialProviderIDs });
            }),
          );
        });

      const listModels: NonNullable<OpenCodeAdapterShape["listModels"]> = (input) => {
        const binaryPath = input.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
        const freeOnlyProviderID = adapterConfig.provider === "kilo" ? "kilo" : undefined;
        return withDiscoveryInventory({ binaryPath }, ({ inventory, credentialProviderIDs }) =>
          Effect.gen(function* () {
            const preferredProviderIDs = new Set(
              resolvePreferredOpenCodeModelProviders({
                inventory,
                credentialProviderIDs,
              }).map((provider) => provider.id),
            );
            const inventoryModels = flattenOpenCodeModels({
              inventory,
              credentialProviderIDs,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            const cliModels = yield* openCodeRuntime
              .listOpenCodeCliModels({ binaryPath, cliSpec: adapterConfig.cliSpec })
              .pipe(Effect.catch(() => Effect.succeed([])));
            const preferredCliModels = cliModels.filter((model) =>
              preferredProviderIDs.has(model.providerID),
            );
            const models = mergeOpenCodeCliModelDescriptors({
              inventory,
              models: inventoryModels,
              cliModels: preferredCliModels.length > 0 ? preferredCliModels : cliModels,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            yield* Effect.logDebug(`${adapterConfig.displayName} model discovery resolved`, {
              binaryPath,
              connectedProviders: inventory.providerList.connected,
              inventoryModelCount: inventoryModels.length,
              cliModelCount: cliModels.length,
              modelCount: models.length,
              sampleModels: models.slice(0, 12).map((model) => model.slug),
            });
            return {
              models,
              source:
                cliModels.length > 0
                  ? adapterConfig.cliModelSource
                  : adapterConfig.fallbackModelSource,
              cached: false,
            };
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                models: flattenOpenCodeModels({
                  inventory,
                  credentialProviderIDs,
                  ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
                }),
                source: adapterConfig.fallbackModelSource,
                cached: false,
              }),
            ),
          ),
        );
      };

      const listAgents: NonNullable<OpenCodeAdapterShape["listAgents"]> = () =>
        withDiscoveryInventory({}, ({ inventory }) =>
          Effect.succeed({
            agents: flattenOpenCodeAgents(inventory.agents),
            source: adapterConfig.fallbackModelSource,
            cached: false,
          }),
        );

      const getComposerCapabilities: NonNullable<
        OpenCodeAdapterShape["getComposerCapabilities"]
      > = () =>
        Effect.succeed({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
          supportsThreadImport: true,
        } satisfies ProviderComposerCapabilities);

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
        });

      return {
        provider,
        capabilities: {
          sessionModelSwitch: "in-session",
          supportsRuntimeModelList: true,
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
        readExternalThread,
        rollbackThread,
        compactThread,
        forkThread,
        stopAll,
        listModels,
        listAgents,
        getComposerCapabilities,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } as OpenCodeAdapterShape;
    }),
  ).pipe(
    Layer.provide(
      options?.runtime ? Layer.succeed(OpenCodeRuntime, options.runtime) : OpenCodeRuntimeLive,
    ),
    Layer.provide(NodeServices.layer),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();

export function makeKiloAdapterLive(options?: Omit<OpenCodeAdapterLiveOptions, "adapterConfig">) {
  const kiloOpenCodeCompatibleLayer = makeOpenCodeAdapterLive({
    ...options,
    adapterConfig: KILO_ADAPTER_CONFIG,
  });
  return Layer.effect(
    KiloAdapter,
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      return adapter as unknown as KiloAdapterShape;
    }),
  ).pipe(Layer.provide(kiloOpenCodeCompatibleLayer));
}

export const KiloAdapterLive = makeKiloAdapterLive();
