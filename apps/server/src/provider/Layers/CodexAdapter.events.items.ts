// Purpose: Pure builders that map raw Codex item/request events into ProviderRuntimeEvent shapes — canonical item/request typing, event-base construction, generated-image handling, and item lifecycle projection.
// Layer: pure functions — no Effect, no session-context mutation.
// Exports: the canonical item/request-type mappers, event-base builders, generated-image mappers, and mapItemLifecycle consumed by the mapToRuntimeEvents dispatcher.

import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  codexGeneratedImageArtifact,
  extractCodexGeneratedImageReference,
  firstStringValue,
  isCodexGeneratedImageItemType,
  sanitizeNestedCodexGeneratedImagePayloads,
} from "../../codexGeneratedImages.ts";
import { isNonFatalCodexErrorMessage } from "../../codexErrorClassification.ts";
import { asArray, asNumber, asObject, asString } from "./CodexAdapter.errors.ts";

// Keep manager-emitted stderr lines visible without escalating them into a fatal thread error.
export function providerErrorMapsToWarning(event: ProviderEvent): boolean {
  return (
    event.kind === "error" &&
    (event.method === "process/stderr" ||
      (event.method === "error" &&
        typeof event.message === "string" &&
        isNonFatalCodexErrorMessage(event.message)))
  );
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (isCodexGeneratedImageItemType(raw)) return "image_generation";
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered") || type.includes("entered review")) return "review_entered";
  if (type.includes("review exited") || type.includes("exited review")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  const result: Record<string, string | ReadonlyArray<string> | null> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      result[questionId] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }

    const nestedAnswers = asArray(asObject(value)?.answers);
    if (nestedAnswers) {
      const normalized = nestedAnswers.filter(
        (entry): entry is string => typeof entry === "string",
      );
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }
  }
  return result;
}

export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asObject(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return Object.assign(
        { id, header, question: prompt, options },
        question.multiSelect === true ? { multiSelect: true } : {},
      );
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

export function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

export function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function codexGeneratedImageThreadId(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const msg = codexEventMessage(payload);
  const nestedEvent = asObject(payload?.event);
  return (
    firstStringValue(msg, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(nestedEvent, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(payload, ["thread_id", "threadId", "threadID", "thread"]) ??
    event.providerThreadId ??
    event.threadId
  );
}

function sanitizeGeneratedImagePayload(event: ProviderEvent, canonicalThreadId: ThreadId): unknown {
  const payload = asObject(event.payload);
  return sanitizeNestedCodexGeneratedImagePayloads({
    value: event.payload ?? {},
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
}

function withSanitizedGeneratedImageRaw(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: sanitizeGeneratedImagePayload(event, canonicalThreadId),
    },
  };
}

function generatedImageEventCandidate(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const item = asObject(payload?.item);
  const nestedEvent = asObject(payload?.event);
  if (item) {
    return item;
  }
  if (msg) {
    return {
      ...msg,
      type: asString(msg.type) ?? "image_generation_end",
    };
  }
  if (nestedEvent) {
    return {
      ...nestedEvent,
      type: asString(nestedEvent.type) ?? "image_generation_end",
    };
  }
  if (payload) {
    return {
      ...payload,
      type: asString(payload.type) ?? "image_generation_end",
    };
  }
  return undefined;
}

export function mapGeneratedImageEndEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent | undefined {
  if (
    event.method !== "codex/event/image_generation_end" &&
    event.method !== "image_generation_end"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  const candidate = generatedImageEventCandidate(event);
  const reference = extractCodexGeneratedImageReference({
    value: candidate,
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
  if (!reference) {
    return undefined;
  }

  const turnId =
    event.turnId ??
    toTurnId(
      firstStringValue(candidate, ["turn_id", "turnId"]) ??
        firstStringValue(payload, ["turn_id", "turnId"]),
    );
  const itemId =
    event.itemId ??
    toProviderItemId(
      firstStringValue(candidate, ["item_id", "itemId", "call_id", "callId", "id"]) ??
        firstStringValue(payload, ["item_id", "itemId", "call_id", "callId", "id"]),
    );
  const base = withSanitizedGeneratedImageRaw(
    {
      ...runtimeEventBase(
        {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        },
        canonicalThreadId,
      ),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    },
    event,
    canonicalThreadId,
  );

  return {
    ...base,
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      detail: reference.path,
      data: codexGeneratedImageArtifact(reference),
    },
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.providerParentThreadId) refs.providerParentThreadId = event.providerParentThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.parentTurnId) refs.parentProviderTurnId = event.parentTurnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }
  const generatedImageReference =
    itemType === "image_generation"
      ? extractCodexGeneratedImageReference({
          value: source,
          threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
        })
      : undefined;
  if (
    lifecycle === "item.completed" &&
    itemType === "image_generation" &&
    !generatedImageReference
  ) {
    return undefined;
  }

  const canonicalItemType =
    lifecycle === "item.completed" && itemType === "review_exited" ? "assistant_message" : itemType;

  const detail = itemDetail(source, payload ?? {});
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...(generatedImageReference
      ? withSanitizedGeneratedImageRaw(
          runtimeEventBase(event, canonicalThreadId),
          event,
          canonicalThreadId,
        )
      : runtimeEventBase(event, canonicalThreadId)),
    type: lifecycle,
    payload: {
      itemType: canonicalItemType,
      ...(status ? { status } : {}),
      ...(itemTitle(canonicalItemType) ? { title: itemTitle(canonicalItemType) } : {}),
      ...(generatedImageReference
        ? { detail: generatedImageReference.path }
        : detail
          ? { detail }
          : {}),
      ...(generatedImageReference
        ? { data: codexGeneratedImageArtifact(generatedImageReference) }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}
