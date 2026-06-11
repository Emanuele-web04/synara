// Purpose: Pure event/builder/mapper helpers for projecting OpenCode/Kilo runtime activity.
// Layer: pure functions — no Effect, no session-context mutation.
// Exports: timestamp/event-base builders, permission/tool mappers, text-merge helpers, snapshot builders.

import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderKind,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type { Part, QuestionRequest, Todo } from "@opencode-ai/sdk/v2";

import { openCodeQuestionId } from "../opencodeRuntime.ts";
import { trimNonEmptyString } from "./OpenCodeAdapter.models.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";

type OpenCodeCompatibleProvider = Extract<ProviderKind, "opencode" | "kilo">;

export function nowIso(): string {
  return new Date().toISOString();
}

function asRuntimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

export function buildProviderEventBase(input: {
  readonly provider: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event" | "kilo.sdk.event";
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: input.provider,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: asRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: input.runtimeEventSource,
            payload: input.raw,
          },
        }
      : {}),
  };
}

export function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

export function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

export function openCodeSnapshotKey(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function openCodeMessageSnapshotFromEntry(entry: {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly time?: {
      readonly created?: number;
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}): OpenCodeMessageSnapshot | undefined {
  if (entry.info.role !== "user" && entry.info.role !== "assistant") {
    return undefined;
  }
  return {
    info: {
      ...entry.info,
      role: entry.info.role,
    },
    parts: entry.parts,
  };
}

export function openCodeMessageSnapshotsFromResponse(
  entries: ReadonlyArray<{
    readonly info: {
      readonly id: string;
      readonly role: string;
      readonly time?: {
        readonly created?: number;
        readonly completed?: number;
      };
      readonly finish?: string;
    };
    readonly parts: ReadonlyArray<Part>;
  }>,
): ReadonlyArray<OpenCodeMessageSnapshot> {
  return entries.flatMap((entry) => {
    const snapshot = openCodeMessageSnapshotFromEntry(entry);
    return snapshot ? [snapshot] : [];
  });
}

export function isFinalAssistantMessageSnapshot(snapshot: OpenCodeMessageSnapshot): boolean {
  return (
    snapshot.info.role === "assistant" &&
    typeof snapshot.info.time?.completed === "number" &&
    snapshot.info.finish !== "tool-calls"
  );
}

export function normalizeQuestionRequest(
  request: QuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

export function normalizeOpenCodeTodoStatus(
  value: unknown,
): "pending" | "inProgress" | "completed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress") {
    return "inProgress";
  }
  return "pending";
}

export function normalizeOpenCodeTodoTasks(todos: ReadonlyArray<Todo>): {
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const tasks = todos
    .map((todo) => {
      const task = todo.content.trim();
      if (task.length === 0) {
        return null;
      }
      return {
        task,
        status: normalizeOpenCodeTodoStatus(todo.status),
      };
    })
    .filter(
      (
        task,
      ): task is {
        readonly task: string;
        readonly status: "pending" | "inProgress" | "completed";
      } => task !== null,
    );

  return tasks.length > 0 ? { tasks } : null;
}

export function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

export function shouldProjectOpenCodeTextPart(part: Part): boolean {
  // Kilo uses synthetic/ignored text parts for local UI progress such as snapshot setup.
  return part.type !== "text" || (!part.synthetic && !part.ignored);
}

export function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
      return shouldProjectOpenCodeTextPart(part) ? part.text : undefined;
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

export function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

export function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function resolveLatestAssistantText(
  previousText: string | undefined,
  nextText: string,
): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): { readonly latestText: string; readonly deltaToEmit: string } {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): { readonly nextText: string; readonly deltaToEmit: string } {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

export function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

export function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message =
    data && "message" in data
      ? data.message
      : "message" in error
        ? error.message
        : "error" in error
          ? error.error
          : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

export function isOpenCodeContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("name" in error && error.name === "ContextOverflowError") {
    return true;
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : undefined;
  return (
    typeof message === "string" &&
    /context|token/i.test(message) &&
    /overflow|too large|maximum context|context length|size limit/i.test(message)
  );
}

export function isoFromOpenCodeTimestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

export function openCodeToolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((item) =>
      item && typeof item === "object" && "type" in item && item.type === "text"
        ? [String((item as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function isOpenCodeTerminalStepFinish(value: unknown): boolean {
  const finish = trimNonEmptyString(value)?.toLowerCase().replace(/_/gu, "-");
  if (!finish) {
    return false;
  }
  return !["tool-call", "tool-calls", "function-call", "continue", "unknown"].includes(finish);
}

export function isOpenCodeToolCallFinish(value: unknown): boolean {
  const finish = trimNonEmptyString(value)?.toLowerCase().replace(/_/gu, "-");
  return finish === "tool-call" || finish === "tool-calls" || finish === "function-call";
}

export function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "openCodeSessionId" in resumeCursor &&
    typeof resumeCursor.openCodeSessionId === "string" &&
    resumeCursor.openCodeSessionId.trim().length > 0
  ) {
    return resumeCursor.openCodeSessionId.trim();
  }
  return undefined;
}

export function buildOpenCodeThreadSnapshot(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<OpenCodeMessageSnapshot>;
  readonly cwd?: string | null;
}) {
  return {
    threadId: input.threadId,
    turns: input.messages.map((entry) => ({
      id: TurnId.makeUnsafe(entry.info.id),
      items: [entry],
    })),
    cwd: input.cwd ?? null,
  };
}
