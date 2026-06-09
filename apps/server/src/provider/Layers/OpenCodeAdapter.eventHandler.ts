// Purpose: Subscribed-event dispatcher and snapshot/event-pump helpers for the OpenCode/Kilo adapter (handleSubscribedEvent + message-snapshot replay, Kilo idle watchdog, SSE event pump).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeOpenCodeEventHandler(deps).
// Exports: OpenCodeEventHandlerDeps, OpenCodeEventHandler, makeOpenCodeEventHandler.

import { type ProviderRuntimeEvent, type ThreadId, type TurnId } from "@t3tools/contracts";
import { Cause, Effect, Exit, Ref, Scope, Stream } from "effect";
import type { Part } from "@opencode-ai/sdk/v2";

import {
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  openCodeQuestionId,
  runOpenCodeSdk,
} from "../opencodeRuntime.ts";
import {
  asFiniteNonNegativeNumber,
  buildOpenCodeTokenUsageKey,
  normalizeOpenCodeTokenUsage,
} from "./OpenCodeAdapter.token.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isFinalAssistantMessageSnapshot,
  isOpenCodeContextOverflowError,
  isOpenCodeTerminalStepFinish,
  isOpenCodeToolCallFinish,
  isoFromOpenCodeTimestamp,
  mapPermissionDecision,
  mapPermissionToRequestType,
  mergeOpenCodeAssistantText,
  normalizeOpenCodeTodoTasks,
  normalizeQuestionRequest,
  nowIso,
  openCodeMessageSnapshotsFromResponse,
  openCodeSnapshotKey,
  openCodeToolContentText,
  resolveTextStreamKind,
  sessionErrorMessage,
  shouldProjectOpenCodeTextPart,
  textFromPart,
  toToolLifecycleItemType,
} from "./OpenCodeAdapter.events.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";
import type { OpenCodeEmitters } from "./OpenCodeAdapter.emitters.ts";
import type { OpenCodeTurnHelpers } from "./OpenCodeAdapter.turn.ts";
import {
  appendTurnItem,
  applyPendingTextDeltaToPart,
  bufferPendingTextDelta,
  clearActiveTurnState,
  detailFromToolPart,
  isOpenCodeTurnProviderActivityEvent,
  markOpenCodeTurnCompletionActivity,
  markOpenCodeTurnProviderActivity,
  messageRoleForPart,
  type OpenCodeEmitDeps,
  type OpenCodeSessionContext,
  type OpenCodeSubscribedEvent,
  openCodeNextTextItemId,
  rememberOpenCodeMessageSnapshot,
  shouldHandleSubscribedEvent,
  toolStateCreatedAt,
  trackActiveTurnAssistantFinish,
  updateProviderSession,
} from "./OpenCodeAdapter.runtime.ts";

export interface OpenCodeEventHandlerDeps extends OpenCodeEmitDeps {
  readonly emitters: OpenCodeEmitters;
  readonly turn: OpenCodeTurnHelpers;
  readonly writeNativeEventBestEffort: (
    threadId: ThreadId,
    event: {
      readonly observedAt: string;
      readonly event: Record<string, unknown>;
    },
  ) => Effect.Effect<void>;
}

export interface OpenCodeEventHandler {
  readonly handleSubscribedEvent: (
    context: OpenCodeSessionContext,
    event: OpenCodeSubscribedEvent,
  ) => Effect.Effect<void>;
  readonly loadCurrentMessageSnapshots: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<ReadonlyArray<OpenCodeMessageSnapshot>, OpenCodeRuntimeError>;
  readonly rememberCurrentMessageSnapshots: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<Set<string>, OpenCodeRuntimeError>;
  readonly startKiloTurnSnapshotWatchdog: (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    baselineMessageIds: ReadonlySet<string>,
  ) => Effect.Effect<void>;
  readonly startEventPump: (context: OpenCodeSessionContext) => Effect.Effect<void>;
}

export function makeOpenCodeEventHandler(deps: OpenCodeEventHandlerDeps): OpenCodeEventHandler {
  const {
    provider,
    adapterConfig,
    emit,
    buildEventBase,
    emitters,
    turn,
    writeNativeEventBestEffort,
  } = deps;
  const {
    emitContextCompactionProgress,
    emitContextCompacted,
    emitUnexpectedExit,
    emitAssistantTextDelta,
  } = emitters;
  const { completeOpenCodeTurn, deferPrematureIdleCompletion } = turn;

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
          const normalizedUsage = normalizeOpenCodeTokenUsage(assistantMessage.tokens, maxTokens);
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
          context.partSnapshotKeyById.set(event.properties.partID, openCodeSnapshotKey(nextPart));
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
              ...("provider" in event.properties ? { provider: event.properties.provider } : {}),
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

  const rememberCurrentMessageSnapshots = Effect.fn("rememberCurrentMessageSnapshots")(function* (
    context: OpenCodeSessionContext,
  ) {
    const snapshots = yield* loadCurrentMessageSnapshots(context);
    for (const snapshot of snapshots) {
      rememberOpenCodeMessageSnapshot(context, snapshot);
    }
    return new Set(snapshots.map((snapshot) => snapshot.info.id));
  });

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

        idlePollsWithFinalMessage = hasFinalAssistantMessage ? idlePollsWithFinalMessage + 1 : 0;
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

  const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
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

  return {
    handleSubscribedEvent,
    loadCurrentMessageSnapshots,
    rememberCurrentMessageSnapshots,
    startKiloTurnSnapshotWatchdog,
    startEventPump,
  };
}
