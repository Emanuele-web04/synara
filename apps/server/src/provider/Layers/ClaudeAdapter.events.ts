// Purpose: Pure event/message mappers, parsers, classifiers, and text helpers for the Claude Agent adapter.
// Layer: pure functions — no Effect, no session-context mutation.
// Exports: answer remappers, command mapper, id/cause helpers, tool classifiers, todo/prompt/message builders, snapshot/result parsers.

import type {
  AgentDefinition,
  PermissionMode,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  getAgentMentionAliases,
  type ProviderListCommandsResult,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { buildClaudeSubagentPrompt } from "@t3tools/shared/agentMentions";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  hasEffortLevel,
  trimOrNull,
} from "@t3tools/shared/model";
import { Cause } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { withProviderPlanModePrompt } from "../planMode.ts";
import { PROVIDER } from "./ClaudeAdapter.config.ts";
import type {
  ClaudeResumeState,
  ClaudeTextStreamKind,
  ClaudeToolResultStreamKind,
} from "./ClaudeAdapter.types.ts";

export function coerceClaudeAnswerValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return "";
}

// Claude's AskUserQuestion SDK expects answers keyed by question text; the web UI submits stable ids.
export function remapAnswersToClaudeQuestionText(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string> {
  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    remapped[key] = coerceClaudeAnswerValue(value);
  }

  for (const question of questions) {
    if (Object.hasOwn(remapped, question.question)) {
      continue;
    }

    if (Object.hasOwn(remapped, question.id)) {
      remapped[question.question] = remapped[question.id]!;
      delete remapped[question.id];
    }
  }

  return remapped;
}

export function mapSupportedCommands(commands: SlashCommand[]): ProviderListCommandsResult {
  return {
    commands: commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description || undefined,
    })),
    source: "claudeAgent",
    cached: false,
  };
}

export function neverResolvingUserMessageStream(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
      };
    },
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

export function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

export function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized.includes("todo")) {
    return "plan";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function normalizeClaudeTodoStatus(value: unknown): "pending" | "inProgress" | "completed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress") {
    return "inProgress";
  }
  return "pending";
}

export function normalizeClaudeTodoTasks(input: Record<string, unknown>): {
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const todos = Array.isArray(input.todos) ? input.todos : null;
  if (!todos) {
    return null;
  }

  const tasks = todos
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const todo = entry as Record<string, unknown>;
      const status = normalizeClaudeTodoStatus(todo.status);
      const content = trimOrNull(typeof todo.content === "string" ? todo.content : null);
      const activeForm = trimOrNull(typeof todo.activeForm === "string" ? todo.activeForm : null);
      const task = status === "inProgress" ? (activeForm ?? content) : (content ?? activeForm);
      if (!task) {
        return null;
      }
      return {
        task,
        status,
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

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function buildClaudeSdkSubagents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (const alias of getAgentMentionAliases("claudeAgent")) {
    if (alias.kind !== "claude-subagent" || agents[alias.agentName]) {
      continue;
    }

    agents[alias.agentName] = {
      description: alias.description,
      prompt: alias.prompt,
      ...(alias.tools ? { tools: [...alias.tools] } : {}),
      ...(alias.disallowedTools ? { disallowedTools: [...alias.disallowedTools] } : {}),
      ...(alias.model ? { model: alias.model } : {}),
    };
  }

  return agents;
}

export function buildPromptText(input: ProviderSendTurnInput): string {
  const basePrompt = buildClaudeSubagentPrompt(input.input?.trim() ?? "").prompt;
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const requestedEffort = trimOrNull(rawEffort);
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getModelCapabilities("claudeAgent", claudeModel);
  const promptEffort =
    requestedEffort === "ultrathink" && caps.promptInjectedEffortLevels.includes("ultrathink")
      ? "ultrathink"
      : requestedEffort && hasEffortLevel(caps, requestedEffort)
        ? requestedEffort
        : null;
  return withProviderPlanModePrompt({
    text: applyClaudePromptEffortPrefix(basePrompt, promptEffort),
    interactionMode: input.interactionMode,
  });
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  } as unknown as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    const sanitizedText =
      candidate.type === "text" && typeof candidate.text === "string"
        ? sanitizeClaudeDisplayText(candidate.text)
        : "";
    if (candidate.type === "text" && sanitizedText.length > 0) {
      fragments.push(sanitizedText);
    }
  }

  return fragments;
}

export function sanitizeClaudeDisplayText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const filteredLines = lines.filter((line) => {
    const normalized = line.trim().toLowerCase();
    return !(
      normalized.startsWith("[ede_diagnostic]") &&
      normalized.includes("result_type=") &&
      normalized.includes("stop_reason=")
    );
  });

  if (
    filteredLines.length === 0 &&
    lines.some((line) => line.trim().toLowerCase().startsWith("[ede_diagnostic]"))
  ) {
    return "";
  }

  return filteredLines.join("\n");
}

export function normalizeClaudeUserVisibleErrorMessage(
  text: string | undefined,
  status: ProviderRuntimeTurnStatus,
): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }

  const sanitized = sanitizeClaudeDisplayText(text).trim();
  if (sanitized.length === 0) {
    return undefined;
  }

  if (sanitized === "User interrupted response.") {
    return status === "interrupted" ? "Claude runtime interrupted." : undefined;
  }

  if (/^[\]})"'`.,;:!?_-]+$/.test(sanitized)) {
    return status === "interrupted" ? "Claude runtime interrupted." : "Claude turn failed.";
  }

  return sanitized;
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string"
    ? sanitizeClaudeDisplayText(candidate.text)
    : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeClaudeDisplayText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return sanitizeClaudeDisplayText(record.text);
  }

  return extractTextContent(record.content);
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}
