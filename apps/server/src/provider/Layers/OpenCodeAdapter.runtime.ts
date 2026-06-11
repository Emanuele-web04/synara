// Purpose: Shared runtime context/deps types and pure context helpers for the OpenCode/Kilo adapter's extracted modules.
// Layer: types + pure (non-Effect) helpers and the shared OpenCodeEmitDeps shape; no Layer wiring.
// Exports: OpenCodeSubscribedEvent, OpenCodeTurnSnapshot, OpenCodeSessionContext, OpenCodeAdapterLiveOptions, OpenCodeEmitDeps, plus context helpers (resolveTurnSnapshot, appendTurnItem, rememberOpenCodeMessageSnapshot, ensureSessionContext, buffer/apply text deltas, role/detail helpers, updateProviderSession, clearActiveTurnState, mark* activity, openCodeNextTextItemId, isOpenCodeCompletedAssistantMessage, trackActiveTurnAssistantFinish, subscribed-event guards, replaceModelContextLimits, toRequestError, toProcessError, stopOpenCodeContext).

import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Ref, Scope } from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import {
  type OpenCodeRuntimeShape,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import type {
  OpenCodeCompatibleAdapterConfig,
  OpenCodeCompatibleProvider,
  OpenCodeMessageSnapshot,
} from "./OpenCodeAdapter.types.ts";
import {
  appendOpenCodeAssistantTextDelta,
  buildProviderEventBase,
  isOpenCodeTerminalStepFinish,
  isOpenCodeToolCallFinish,
  isoFromEpochMs,
  nowIso,
  openCodeSnapshotKey,
  shouldProjectOpenCodeTextPart,
  textFromPart,
} from "./OpenCodeAdapter.events.ts";
import { trimNonEmptyString } from "./OpenCodeAdapter.models.ts";

export type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

export interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface OpenCodeSessionContext {
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

/**
 * Factory-scoped primitives the extracted emitter/turn/prompt/event modules used
 * to close over. The adapter factory builds this once and passes it to the
 * `make*` helpers so call sites stay equivalent.
 */
export interface OpenCodeEmitDeps {
  readonly provider: OpenCodeCompatibleProvider;
  readonly adapterConfig: OpenCodeCompatibleAdapterConfig;
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly buildEventBase: (
    input: Omit<Parameters<typeof buildProviderEventBase>[0], "provider" | "runtimeEventSource">,
  ) => ReturnType<typeof buildProviderEventBase>;
  readonly sessions: Map<ThreadId, OpenCodeSessionContext>;
}

export function toRequestError(
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

export function toProcessError(
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

export function resolveTurnSnapshot(
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

export function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

export function rememberOpenCodeMessageSnapshot(
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

export function ensureSessionContext(
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

export function bufferPendingTextDelta(
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

export function applyPendingTextDeltaToPart(context: OpenCodeSessionContext, part: Part): Part {
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

export function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

export function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
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

export function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
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

export function updateProviderSession(
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

export function clearActiveTurnState(context: OpenCodeSessionContext): void {
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

export function markOpenCodeTurnProviderActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnProviderActivitySerial += 1;
}

export function markOpenCodeTurnCompletionActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnCompletionActivitySerial += 1;
}

export function openCodeNextTextItemId(turnId: TurnId): string {
  return `${turnId}-next-text`;
}

export function isOpenCodeCompletedAssistantMessage(
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

export function trackActiveTurnAssistantFinish(
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

export function subscribedEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
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

export function shouldHandleSubscribedEvent(
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

export function isOpenCodeTurnProviderActivityEvent(
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

export function replaceModelContextLimits(
  context: OpenCodeSessionContext,
  limits: ReadonlyMap<string, number>,
): void {
  context.modelContextLimitBySlug.clear();
  for (const [slug, limit] of limits) {
    context.modelContextLimitBySlug.set(slug, limit);
  }
}

export const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
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
