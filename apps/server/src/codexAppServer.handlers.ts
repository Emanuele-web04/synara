// Purpose: JSON-RPC inbound dispatch for a Codex app-server session — stdout-line
//   routing, server-notification/request handling, response settling, collab
//   child-conversation tracking, and tracked-review settlement. Extracted from
//   CodexAppServerManager so the stateful class stays a thin shell over these
//   pure-ish handlers.
// Layer: Free functions over a CodexSessionContext plus a small effectful `deps`
//   surface (emit/write/updateSession). No process spawning, no transport
//   creation, no caches. Depends on the pure protocol/parsers modules and types.
// Exports: CodexHandlerDeps, handleStdoutLine, handleServerNotification,
//   handleServerRequest, handleResponse, settleTrackedReview.
import {
  ApprovalRequestId,
  EventId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
} from "@t3tools/contracts";
import { randomUUID } from "node:crypto";

import {
  classifyCodexStderrLine,
  isIgnorableCodexProcessLine,
  isJsonObjectLine,
  normalizeCodexProcessLine,
  normalizeCodexUserVisibleErrorMessage,
  normalizeProviderThreadId,
  toTurnId,
} from "./codexAppServer.protocol.ts";
import {
  isExitedReviewModeNotification,
  isResponse,
  isServerNotification,
  isServerRequest,
  readArray,
  readBoolean,
  readObject,
  readProviderConversationId,
  readRouteFields,
  readString,
  requestKindForMethod,
} from "./codexAppServer.parsers.ts";
import type {
  CodexSessionContext,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PendingApprovalRequest,
} from "./codexAppServer.types.ts";
import { isNonFatalCodexErrorMessage } from "./codexErrorClassification.ts";

export interface CodexHandlerDeps {
  emitEvent(event: ProviderEvent): void;
  emitErrorEvent(context: CodexSessionContext, method: string, message: string): void;
  writeMessage(context: CodexSessionContext, message: unknown): void;
  updateSession(
    context: CodexSessionContext,
    updates: Partial<CodexSessionContext["session"]>,
  ): void;
}

export function handleStdoutLine(
  deps: CodexHandlerDeps,
  context: CodexSessionContext,
  line: string,
): void {
  if (isIgnorableCodexProcessLine(line)) {
    return;
  }

  // A line whose first non-whitespace char is not `{` is not a JSON-RPC frame:
  // it is codex process/log output. On a remote PTY transport stdout and stderr
  // are merged, so codex's own log lines are interleaved into this inbound
  // stream rather than arriving on the (empty) stderr side channel. Route them
  // through the stderr classifier — emitting `process/stderr` only for
  // ERROR-level codex logs — to restore the local-transport split where such
  // lines were warnings, never a user-visible `protocol/parseError` flood.
  if (!isJsonObjectLine(line)) {
    const classified = classifyCodexStderrLine(line);
    if (classified) {
      deps.emitErrorEvent(context, "process/stderr", classified.message);
    }
    return;
  }

  // Parse the ANSI-stripped line, not the raw one: on the merged PTY stream a
  // real frame can carry non-SGR ANSI (bracketed-paste, OSC) that `JSON.parse`
  // rejects. `isJsonObjectLine` gated on the stripped form, so parsing must use
  // the same normalization or a stripped-but-real frame is silently dropped.
  const normalizedLine = normalizeCodexProcessLine(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch {
    // The frame gate already filtered non-JSON log noise; a line that looks
    // like a JSON object yet fails to parse is a rare malformed frame. Keep it
    // out of the user-visible error channel — log at debug and drop it.
    if (process.env.SYNARA_DEBUG_CODEX_TRANSPORT === "1") {
      console.debug("[codex] dropped unparseable inbound frame", line);
    }
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    deps.emitErrorEvent(
      context,
      "protocol/invalidMessage",
      "Received non-object protocol message.",
    );
    return;
  }

  if (isServerRequest(parsed)) {
    handleServerRequest(deps, context, parsed);
    return;
  }

  if (isServerNotification(parsed)) {
    handleServerNotification(deps, context, parsed);
    return;
  }

  if (isResponse(parsed)) {
    handleResponse(context, parsed);
    return;
  }

  deps.emitErrorEvent(
    context,
    "protocol/unrecognizedMessage",
    "Received protocol message in an unknown shape.",
  );
}

export function handleServerNotification(
  deps: CodexHandlerDeps,
  context: CodexSessionContext,
  notification: JsonRpcNotification,
): void {
  const rawRoute = readRouteFields(notification.params);
  rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
  const childParentTurnId = readChildParentTurnId(context, notification.params);
  const providerThreadId = normalizeProviderThreadId(
    readProviderConversationId(notification.params),
  );
  const providerParentThreadId = readChildParentProviderThreadId(context, notification.params);
  const isChildConversation = childParentTurnId !== undefined;
  if (isChildConversation && shouldSuppressChildConversationNotification(notification.method)) {
    return;
  }
  const textDelta = readNotificationTextDelta(notification);

  deps.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: notification.method,
    ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
    ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
    ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerParentThreadId ? { providerParentThreadId } : {}),
    textDelta,
    payload: notification.params,
  });

  if (notification.method === "thread/started") {
    const startedThreadId = normalizeProviderThreadId(
      readString(readObject(notification.params)?.thread, "id"),
    );
    if (startedThreadId && !isChildConversation) {
      deps.updateSession(context, {
        resumeCursor: { threadId: startedThreadId },
      });
    }
    return;
  }

  if (notification.method === "turn/started") {
    if (isChildConversation) {
      return;
    }
    const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
    if (
      turnId !== undefined &&
      context.session.activeTurnId !== undefined &&
      context.reviewTurnIds.has(context.session.activeTurnId)
    ) {
      context.reviewTurnIds.add(turnId);
      console.log("[codex-review] extending tracked review turn set on turn/started", {
        threadId: context.session.threadId,
        previousTurnId: context.session.activeTurnId,
        nextTurnId: turnId,
      });
    }
    deps.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });
    return;
  }

  if (notification.method === "turn/completed") {
    if (isChildConversation) {
      return;
    }
    context.collabReceiverTurns.clear();
    if (rawRoute.turnId) {
      context.reviewTurnIds.delete(rawRoute.turnId);
    }
    const turn = readObject(notification.params, "turn");
    const status = readString(turn, "status");
    const errorMessageRaw = readString(readObject(turn, "error"), "message");
    const errorMessage =
      errorMessageRaw !== undefined
        ? normalizeCodexUserVisibleErrorMessage(errorMessageRaw)
        : undefined;
    deps.updateSession(context, {
      status: status === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      lastError: errorMessage ?? context.session.lastError,
    });
    return;
  }

  if (notification.method === "turn/aborted") {
    if (isChildConversation) {
      return;
    }
    context.collabReceiverTurns.clear();
    if (rawRoute.turnId) {
      context.reviewTurnIds.delete(rawRoute.turnId);
    }
    deps.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
    return;
  }

  if (isExitedReviewModeNotification(notification)) {
    if (isChildConversation) {
      return;
    }
    const item = readObject(notification.params, "item");
    const reviewTurnId = toTurnId(readString(item, "id")) ?? rawRoute.turnId;
    const reviewTurnTracked =
      reviewTurnId !== undefined ? context.reviewTurnIds.has(reviewTurnId) : false;
    const activeTurnTracked =
      context.session.activeTurnId !== undefined &&
      context.reviewTurnIds.has(context.session.activeTurnId);
    console.log("[codex-review] exitedReviewMode notification", {
      threadId: context.session.threadId,
      reviewTurnId: reviewTurnId ?? null,
      activeTurnId: context.session.activeTurnId ?? null,
      reviewTurnTracked,
      activeTurnTracked,
    });
    if (
      reviewTurnId !== undefined &&
      context.session.activeTurnId !== undefined &&
      reviewTurnId !== context.session.activeTurnId &&
      !reviewTurnTracked &&
      !activeTurnTracked
    ) {
      console.log("[codex-review] exitedReviewMode ignored due to turn mismatch", {
        threadId: context.session.threadId,
        reviewTurnId,
        activeTurnId: context.session.activeTurnId,
      });
      return;
    }
    // `review/start` can emit the final review result via `exitedReviewMode`
    // before the terminal `turn/completed` notification arrives. If that
    // completion never shows up, settle the session here instead of leaving
    // native review stuck in "running" forever.
    console.log("[codex-review] settling review from exitedReviewMode notification", {
      threadId: context.session.threadId,
      reviewTurnId: reviewTurnId ?? null,
    });
    settleTrackedReview(
      deps,
      context,
      reviewTurnId !== undefined
        ? {
            completedTurnId: reviewTurnId,
            reason: "review exited via exitedReviewMode",
          }
        : {
            reason: "review exited via exitedReviewMode",
          },
    );
    return;
  }

  if (notification.method === "error") {
    if (isChildConversation) {
      return;
    }
    const rawMessage = readString(readObject(notification.params)?.error, "message");
    const message =
      rawMessage !== undefined ? normalizeCodexUserVisibleErrorMessage(rawMessage) : undefined;
    const willRetry = readBoolean(notification.params, "willRetry");
    const isNonFatalWarning =
      message !== undefined && !willRetry && isNonFatalCodexErrorMessage(message);

    if (willRetry) {
      deps.updateSession(context, {
        status: "running",
      });
      return;
    }

    if (isNonFatalWarning) {
      return;
    }

    deps.updateSession(context, {
      status: "error",
      lastError: message ?? context.session.lastError,
    });
  }
}

function readNotificationTextDelta(notification: JsonRpcNotification): string | undefined {
  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return readString(notification.params, "delta");
    default:
      return undefined;
  }
}

export function handleServerRequest(
  deps: CodexHandlerDeps,
  context: CodexSessionContext,
  request: JsonRpcRequest,
): void {
  const rawRoute = readRouteFields(request.params);
  const childParentTurnId = readChildParentTurnId(context, request.params);
  const providerThreadId = normalizeProviderThreadId(readProviderConversationId(request.params));
  const providerParentThreadId = readChildParentProviderThreadId(context, request.params);
  const requestKind = requestKindForMethod(request.method);
  let requestId: ApprovalRequestId | undefined;
  if (requestKind) {
    requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    const pendingRequest: PendingApprovalRequest = {
      requestId,
      jsonRpcId: request.id,
      method:
        requestKind === "command"
          ? "item/commandExecution/requestApproval"
          : requestKind === "file-read"
            ? "item/fileRead/requestApproval"
            : "item/fileChange/requestApproval",
      requestKind,
      threadId: context.session.threadId,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    };
    if (context.sessionApprovalOverride) {
      resolveApprovalRequest(deps, context, pendingRequest, "acceptForSession");
      return;
    }
    context.pendingApprovals.set(requestId, pendingRequest);
  }

  if (request.method === "item/tool/requestUserInput") {
    requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    context.pendingUserInputs.set(requestId, {
      requestId,
      jsonRpcId: request.id,
      threadId: context.session.threadId,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    });
  }

  deps.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "request",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: request.method,
    ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
    ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
    ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerParentThreadId ? { providerParentThreadId } : {}),
    requestId,
    requestKind,
    payload: request.params,
  });

  if (requestKind) {
    return;
  }

  if (request.method === "item/tool/requestUserInput") {
    return;
  }

  deps.writeMessage(context, {
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported server request: ${request.method}`,
    },
  });
}

export function handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
  const key = String(response.id);
  const pending = context.pending.get(key);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  context.pending.delete(key);

  if (response.error?.message) {
    pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
    return;
  }

  pending.resolve(response.result);
}

export function resolveApprovalRequest(
  deps: CodexHandlerDeps,
  context: CodexSessionContext,
  pendingRequest: PendingApprovalRequest,
  decision: ProviderApprovalDecision,
): void {
  deps.writeMessage(context, {
    id: pendingRequest.jsonRpcId,
    result: {
      decision,
    },
  });
  deps.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: "item/requestApproval/decision",
    turnId: pendingRequest.turnId,
    itemId: pendingRequest.itemId,
    requestId: pendingRequest.requestId,
    requestKind: pendingRequest.requestKind,
    payload: {
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      decision,
    },
  });
}

export function settleTrackedReview(
  deps: CodexHandlerDeps,
  context: CodexSessionContext,
  input: {
    readonly completedTurnId?: TurnId;
    readonly reason: string;
  },
): void {
  const terminalTurnId =
    context.session.activeTurnId !== undefined &&
    context.reviewTurnIds.has(context.session.activeTurnId)
      ? context.session.activeTurnId
      : input.completedTurnId !== undefined && context.reviewTurnIds.has(input.completedTurnId)
        ? input.completedTurnId
        : context.reviewTurnIds.values().next().value;

  deps.updateSession(context, {
    status: "ready",
    activeTurnId: undefined,
    lastError: undefined,
  });

  context.reviewTurnIds.clear();

  if (!terminalTurnId) {
    return;
  }

  deps.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: "turn/completed",
    turnId: terminalTurnId,
    message: input.reason,
    payload: {
      turn: {
        id: terminalTurnId,
        status: "completed",
      },
    },
  });
}

function readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
  const providerConversationId = readProviderConversationId(params);
  if (!providerConversationId) {
    return undefined;
  }
  return context.collabReceiverTurns.get(providerConversationId);
}

function readChildParentProviderThreadId(
  context: CodexSessionContext,
  params: unknown,
): string | undefined {
  const providerConversationId = readProviderConversationId(params);
  if (!providerConversationId) {
    return undefined;
  }
  return context.collabReceiverParents.get(providerConversationId);
}

function rememberCollabReceiverTurns(
  context: CodexSessionContext,
  params: unknown,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }
  const payload = readObject(params);
  const item = readObject(payload, "item") ?? payload;
  const itemType = readString(item, "type") ?? readString(item, "kind");
  if (itemType !== "collabAgentToolCall") {
    return;
  }
  const parentProviderThreadId = normalizeProviderThreadId(readProviderConversationId(params));

  const receiverThreadIds =
    readArray(item, "receiverThreadIds")
      ?.map((value) => (typeof value === "string" ? value : null))
      .filter((value): value is string => value !== null) ?? [];
  for (const receiverThreadId of receiverThreadIds) {
    context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
    if (parentProviderThreadId) {
      context.collabReceiverParents.set(receiverThreadId, parentProviderThreadId);
    }
  }
}

function shouldSuppressChildConversationNotification(method: string): boolean {
  // Intentionally do NOT suppress `turn/plan/updated` or `item/plan/delta` here,
  // even for child conversations. These are the events that let the active plan
  // card advance ("1 out of 5" → "2 out of 5" ...) and render streaming plan text;
  // suppressing them freezes the plan UI at its initial all-pending snapshot.
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/aborted"
  );
}
