// Purpose: Event-handler cluster for the ProviderCommandReactor — the process* handlers for
//   each ProviderIntentEvent, queued-turn draining, message-edit resend orchestration, runtime
//   lifecycle actions, and the safe domain-event / queue-drain dispatchers.
// Layer: dependency-parameterized Effect helpers; built once per reactor via makeReactorHandlers(deps).
// Exports: ReactorHandlersDeps, ReactorHandlers, makeReactorHandlers.

import { ThreadId, TurnId } from "@t3tools/contracts";
import { Cache, Cause, Effect, Option } from "effect";
import { resolveTailUserMessageEditTarget } from "@t3tools/shared/conversationEdit";

import { ExecutionRuntimeService } from "../../executionRuntime/Services/ExecutionRuntimeService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  editResendTurnStartKey,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  resolveSubagentProviderThreadId,
  serverCommandId,
  stalePendingRequestDetail,
  turnStartKeyForEvent,
} from "./ProviderCommandReactor.helpers.ts";
import { DEFAULT_RUNTIME_MODE } from "./ProviderCommandReactor.config.ts";
import type {
  ProviderIntentEvent,
  ProviderQueueDrainEvent,
} from "./ProviderCommandReactor.types.ts";
import type { ReactorCoreDeps, ReactorSession } from "./ProviderCommandReactor.session.ts";
import type { ReactorDispatch } from "./ProviderCommandReactor.dispatch.ts";

export interface ReactorHandlersDeps extends ReactorCoreDeps {
  readonly session: ReactorSession;
  readonly dispatch: ReactorDispatch;
  readonly handledTurnStartKeys: Cache.Cache<string, true>;
  readonly queuedTurnStartsByThread: Map<
    string,
    Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
  >;
  readonly editResendTurnStartKeys: Set<string>;
  readonly drainingQueuedTurns: Set<string>;
}

export type ReactorHandlers = ReturnType<typeof makeReactorHandlers>;

export function makeReactorHandlers(deps: ReactorHandlersDeps) {
  const {
    orchestrationEngine,
    providerService,
    executionRuntimeService,
    threadProviderOptions,
    threadModelSelections,
    recentlyEnsuredSessionThreads,
    queuedTurnStartsByThread,
    editResendTurnStartKeys,
    drainingQueuedTurns,
    handledTurnStartKeys,
    session,
    dispatch,
  } = deps;
  const {
    resolveThread,
    resolveProviderSessionThread,
    appendProviderFailureActivity,
    setThreadSession,
    setThreadSessionError,
    ensureSessionForThread,
  } = session;
  const {
    enqueueQueuedTurnStart,
    dequeueQueuedTurnStart,
    removeQueuedTurnStart,
    hasQueuedTurnStart,
    clearEditResendTurnStartKeysForThread,
    removedTurnIdsFromMessage,
    rollbackProviderConversationForEdit,
    restoreWorkspaceBeforeEditReplay,
    dispatchTurnForThread,
    maybeGenerateAndRenameWorktreeBranchForFirstTurn,
    maybeGenerateAndRenameThreadTitleForFirstTurn,
  } = dispatch;

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  // Promote the next queued message only after the active provider turn settles.
  const drainQueuedTurnsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (drainingQueuedTurns.has(threadId)) {
      return;
    }
    drainingQueuedTurns.add(threadId);
    try {
      const nextQueuedTurn = yield* dequeueQueuedTurnStart(threadId);
      if (!nextQueuedTurn) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.dispatch-queued",
        commandId: serverCommandId("dispatch-queued-turn"),
        threadId,
        messageId: nextQueuedTurn.messageId,
        ...(nextQueuedTurn.modelSelection !== undefined
          ? { modelSelection: nextQueuedTurn.modelSelection }
          : {}),
        ...(nextQueuedTurn.providerOptions !== undefined
          ? { providerOptions: nextQueuedTurn.providerOptions }
          : {}),
        ...(nextQueuedTurn.reviewTarget !== undefined
          ? { reviewTarget: nextQueuedTurn.reviewTarget }
          : {}),
        ...(nextQueuedTurn.assistantDeliveryMode !== undefined
          ? { assistantDeliveryMode: nextQueuedTurn.assistantDeliveryMode }
          : {}),
        dispatchMode: nextQueuedTurn.dispatchMode,
        runtimeMode: nextQueuedTurn.runtimeMode,
        interactionMode: nextQueuedTurn.interactionMode,
        ...(nextQueuedTurn.sourceProposedPlan !== undefined
          ? { sourceProposedPlan: nextQueuedTurn.sourceProposedPlan }
          : {}),
        createdAt: nextQueuedTurn.createdAt,
      });
    } finally {
      drainingQueuedTurns.delete(threadId);
    }
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
    }).pipe(Effect.forkScoped);
    yield* maybeGenerateAndRenameThreadTitleForFirstTurn({
      threadId: event.payload.threadId,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
    }).pipe(Effect.forkScoped);
    const immediateDispatchMode =
      event.payload.dispatchMode === "steer" &&
      (thread.session?.providerName ?? thread.modelSelection.provider) !== "codex"
        ? "queue"
        : event.payload.dispatchMode;
    const editResendKey = editResendTurnStartKey(event.payload.threadId, event.payload.messageId);

    yield* dispatchTurnForThread({
      threadId: event.payload.threadId,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(message.skills !== undefined ? { skills: message.skills } : {}),
      ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
      ...(event.payload.runtimeMode !== undefined
        ? { runtimeMode: event.payload.runtimeMode }
        : {}),
      ...(event.payload.reviewTarget !== undefined
        ? { reviewTarget: event.payload.reviewTarget }
        : {}),
      interactionMode: event.payload.interactionMode,
      dispatchMode: immediateDispatchMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const detail = Cause.pretty(cause);
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          });
          yield* setThreadSessionError({
            threadId: event.payload.threadId,
            runtimeMode: event.payload.runtimeMode,
            detail,
            createdAt: event.payload.createdAt,
          });
          yield* drainQueuedTurnsForThread(event.payload.threadId);
        }),
      ),
      Effect.ensuring(Effect.sync(() => editResendTurnStartKeys.delete(editResendKey))),
    );
  });

  const processTurnQueued = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>,
  ) {
    yield* enqueueQueuedTurnStart(event.payload);
  });

  const processSessionEnsureRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-ensure-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
      return;
    }

    const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
    const ensureSession = ensureSessionForThread(event.payload.threadId, event.payload.createdAt, {
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : cachedProviderOptions !== undefined
          ? { providerOptions: cachedProviderOptions }
          : {}),
      runtimeMode: event.payload.runtimeMode,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          recentlyEnsuredSessionThreads.set(event.payload.threadId, {
            ensuredAt: Date.now(),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.runtimeMode !== undefined
              ? { runtimeMode: event.payload.runtimeMode }
              : {}),
          });
        }),
      ),
      Effect.catchCause((cause) =>
        setThreadSessionError({
          threadId: event.payload.threadId,
          runtimeMode: event.payload.runtimeMode,
          detail: Cause.pretty(cause),
          createdAt: event.payload.createdAt,
        }),
      ),
    );
    yield* ensureSession;
    if (event.payload.modelSelection !== undefined) {
      threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
    }
    if (event.payload.providerOptions !== undefined) {
      threadProviderOptions.set(event.payload.threadId, event.payload.providerOptions);
    }
  });

  const processQueueDrainEvent = Effect.fnUntraced(function* (event: ProviderQueueDrainEvent) {
    yield* drainQueuedTurnsForThread(event.threadId);
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
    const turnId = event.payload.turnId ?? thread.session?.activeTurnId ?? undefined;
    yield* providerService.interruptTurn({
      threadId: providerThread.id,
      ...(turnId ? { turnId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
    });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: providerThread.id,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToUserInput({
        threadId: providerThread.id,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: isUnknownPendingUserInputRequestError(cause)
              ? stalePendingRequestDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processConversationRollbackRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) {
    if (event.payload.numTurns === 0) {
      const thread = yield* resolveThread(event.payload.threadId);
      yield* orchestrationEngine.dispatch({
        type: "thread.conversation.rollback.complete",
        commandId: serverCommandId("conversation-rollback-complete"),
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        numTurns: event.payload.numTurns,
        removedTurnIds: thread
          ? removedTurnIdsFromMessage(thread.messages, event.payload.messageId)
          : [],
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null
    ) {
      const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
      yield* providerService.interruptTurn({
        threadId: providerThread.id,
        turnId: providerThread.session.activeTurnId,
        ...(providerThreadId ? { providerThreadId } : {}),
      });
    }

    yield* rollbackProviderConversationForEdit({
      threadId: event.payload.threadId,
      numTurns: event.payload.numTurns,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("conversation-rollback-complete"),
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      numTurns: event.payload.numTurns,
      removedTurnIds: thread
        ? removedTurnIdsFromMessage(thread.messages, event.payload.messageId)
        : [],
      createdAt: event.payload.createdAt,
    });
  });

  const processMessageEditResendPayload = Effect.fnUntraced(function* (
    payload: Extract<
      ProviderIntentEvent,
      { type: "thread.message-edit-resend-requested" }
    >["payload"],
    options?: {
      readonly skipProviderRollback?: boolean;
      readonly preserveQueuedTurns?: boolean;
      readonly preserveThreadSession?: boolean;
      readonly activeTurnId?: TurnId | null;
    },
  ) {
    if (options?.preserveQueuedTurns !== true) {
      queuedTurnStartsByThread.delete(payload.threadId);
      yield* clearEditResendTurnStartKeysForThread(payload.threadId);
    } else {
      yield* removeQueuedTurnStart(payload.threadId, payload.messageId);
    }
    const originalThread = yield* resolveThread(payload.threadId);
    const originalMessage = originalThread?.messages.find(
      (message) => message.id === payload.messageId,
    );
    if (!originalThread || !originalMessage || originalMessage.role !== "user") {
      return yield* Effect.fail(
        new Error(`Cannot edit missing user message '${payload.messageId}'.`),
      );
    }
    const editTarget =
      payload.removedTurnIds !== undefined && payload.rollbackTurnCount !== undefined
        ? {
            editable: true as const,
            messageId: payload.messageId,
            messageIndex: originalThread.messages.findIndex(
              (message) => message.id === payload.messageId,
            ),
            mode: payload.rollbackTurnCount > 0 ? ("rollback" as const) : ("active" as const),
            rollbackTurnCount: payload.rollbackTurnCount,
            removedTurnIds: payload.removedTurnIds,
          }
        : resolveTailUserMessageEditTarget({
            messages: originalThread.messages,
            messageId: payload.messageId,
            activeTurnId:
              options?.activeTurnId ??
              (originalThread.session?.status === "running"
                ? (originalThread.session.activeTurnId ?? null)
                : null),
          });
    if (!editTarget.editable) {
      return yield* Effect.fail(
        new Error(
          `Cannot edit non-tail user message '${payload.messageId}': ${editTarget.reason}.`,
        ),
      );
    }
    if (options?.skipProviderRollback !== true && editTarget.rollbackTurnCount > 0) {
      yield* rollbackProviderConversationForEdit({
        threadId: payload.threadId,
        numTurns: editTarget.rollbackTurnCount,
      });
    }
    yield* restoreWorkspaceBeforeEditReplay({
      threadId: payload.threadId,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("message-edit-rollback-complete"),
      threadId: payload.threadId,
      messageId: payload.messageId,
      numTurns: editTarget.rollbackTurnCount,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
      skipAttachmentPrune: true,
      createdAt: payload.createdAt,
    });

    const thread = yield* resolveThread(payload.threadId);
    if (thread && options?.preserveThreadSession !== true) {
      yield* setThreadSession({
        threadId: payload.threadId,
        session: {
          threadId: payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: payload.createdAt,
        },
        createdAt: payload.createdAt,
      });
    }

    editResendTurnStartKeys.add(editResendTurnStartKey(payload.threadId, payload.messageId));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("message-edit-resend-turn-start"),
      threadId: payload.threadId,
      message: {
        messageId: payload.messageId,
        role: "user",
        text: payload.text,
        attachments: originalMessage.attachments ?? [],
        ...(originalMessage.skills !== undefined ? { skills: originalMessage.skills } : {}),
        ...(originalMessage.mentions !== undefined ? { mentions: originalMessage.mentions } : {}),
      },
      ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
      ...(payload.providerOptions !== undefined
        ? { providerOptions: payload.providerOptions }
        : {}),
      ...(payload.assistantDeliveryMode !== undefined
        ? { assistantDeliveryMode: payload.assistantDeliveryMode }
        : {}),
      dispatchMode: "queue",
      runtimeMode: payload.runtimeMode,
      interactionMode: payload.interactionMode,
      createdAt: payload.createdAt,
    });
  });

  const stopActiveProviderRuntimeForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
  }) {
    if (providerService.stopRuntimeSession) {
      yield* providerService.stopRuntimeSession({ threadId: input.threadId });
      return;
    }
    yield* providerService.stopSession({ threadId: input.threadId });
  });

  const processMessageEditResendRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const activeTurnId =
      providerThread?.session?.status === "running"
        ? (providerThread.session.activeTurnId ?? null)
        : null;
    const isQueuedMessageEdit = yield* hasQueuedTurnStart(
      event.payload.threadId,
      event.payload.messageId,
    );
    if (thread && !isQueuedMessageEdit) {
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    }
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null &&
      !isQueuedMessageEdit
    ) {
      // Edits should replay from the last stable cursor, not wait for each
      // provider's interrupt lifecycle to settle.
      yield* stopActiveProviderRuntimeForEdit({ threadId: providerThread.id });
      yield* processMessageEditResendPayload(event.payload, {
        skipProviderRollback: true,
        activeTurnId,
      });
      return;
    }

    yield* processMessageEditResendPayload(event.payload, {
      ...(isQueuedMessageEdit ? { skipProviderRollback: true } : {}),
      preserveQueuedTurns: isQueuedMessageEdit,
      preserveThreadSession: isQueuedMessageEdit,
      activeTurnId,
    });
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    queuedTurnStartsByThread.delete(thread.id);
    yield* clearEditResendTurnStartKeysForThread(thread.id);
    drainingQueuedTurns.delete(thread.id);

    const now = event.payload.createdAt;
    const providerThreadId =
      providerThread !== null
        ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
        : undefined;
    const isChildProviderRuntime =
      providerThread !== null && providerThread.id !== thread.id && providerThreadId !== undefined;

    // Child subagents share the parent provider session, so stop requests need
    // to interrupt the child turn rather than terminate the whole session.
    if (
      isChildProviderRuntime &&
      thread.session &&
      thread.session.status === "running" &&
      thread.session.activeTurnId !== null &&
      providerThread.session &&
      providerThread.session.status !== "stopped"
    ) {
      yield* providerService.interruptTurn({
        threadId: providerThread.id,
        turnId: thread.session.activeTurnId,
        providerThreadId,
      });

      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "interrupted",
          providerName: thread.session.providerName ?? null,
          runtimeMode: thread.session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          // Preserve the active turn until the provider emits the terminal child event.
          activeTurnId: thread.session.activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      return;
    }

    const ownsProviderSession = providerThread !== null && providerThread.id === thread.id;
    if (thread.session && thread.session.status !== "stopped" && ownsProviderSession) {
      yield* providerService.stopSession({ threadId: providerThread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  // Runtime lifecycle actions dispatched from the panel UI. The reactor stays
  // provider-agnostic: it routes by the requested action to ExecutionRuntimeService,
  // which resolves the adapter for the instance's recorded provider.
  const processRuntimeActionRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.runtime-action-requested" }>,
  ) {
    const { threadId, instanceId, action } = event.payload;
    switch (action) {
      case "stop":
        yield* executionRuntimeService.stop(threadId, instanceId);
        return;
      case "destroy":
        yield* executionRuntimeService.destroy(threadId, instanceId);
        return;
      case "snapshot":
        yield* executionRuntimeService.snapshot(threadId, instanceId);
        return;
    }
  });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created": {
          // Honor a `runtimePlan` carried on create/handoff/fork. The reactor
          // stays provider-agnostic: it hands the plan to the execution-runtime
          // service, which validates it (rejecting invalid plans pre-provision)
          // and marks the thread remote. No plan / local / worktree is a no-op,
          // preserving the existing local spawn path exactly.
          if (event.payload.runtimePlan == null) {
            return;
          }
          yield* executionRuntimeService.applyRuntimePlan({
            threadId: event.payload.threadId,
            plan: event.payload.runtimePlan,
          });
          return;
        }
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (event.payload.modelSelection === undefined) {
            return;
          }

          if (
            !thread?.session ||
            thread.session.status === "stopped" ||
            thread.session.activeTurnId !== null
          ) {
            threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
            return;
          }

          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            modelSelection: event.payload.modelSelection,
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
          });
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        }
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
            runtimeMode: event.payload.runtimeMode,
          });
          return;
        }
        case "thread.turn-queued":
          yield* processTurnQueued(event);
          return;
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.conversation-rollback-requested":
          yield* processConversationRollbackRequested(event);
          return;
        case "thread.message-edit-resend-requested":
          yield* processMessageEditResendRequested(event).pipe(
            Effect.catchCause((cause) =>
              setThreadSessionError({
                threadId: event.payload.threadId,
                runtimeMode: event.payload.runtimeMode,
                detail: Cause.pretty(cause),
                createdAt: event.payload.createdAt,
              }),
            ),
          );
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
        case "thread.session-ensure-requested":
          yield* processSessionEnsureRequested(event);
          return;
        case "thread.runtime-action-requested":
          yield* processRuntimeActionRequested(event);
          return;
      }
    });

  return {
    processDomainEvent,
    processQueueDrainEvent,
  };
}
