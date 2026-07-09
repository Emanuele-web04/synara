/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type AgentInfo,
  type CanUseTool,
  type AgentDefinition,
  ModelUsage,
  NonNullableUsage,
  query,
  type Options as ClaudeQueryOptions,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
  getAgentMentionAliases,
} from "@t3tools/contracts";
import {
  getDefaultContextWindow,
  getEffectiveClaudeCodeEffort,
  hasEffortLevel,
  hasContextWindowOption,
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  resolveApiModelId,
  trimOrNull,
} from "@t3tools/shared/model";
import { buildClaudeSubagentPrompt } from "@t3tools/shared/agentMentions";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Semaphore,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { buildClaudeProcessEnv } from "../claudeProcessEnv.ts";
import { positiveFiniteNumber } from "../tokenUsage.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeAgent" as const;
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly rerouteOriginalApiModelId?: string;
  readonly rerouteFallbackApiModelId?: string;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly interactionMode: "default" | "plan";
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly sawFileChange: boolean;
  nextSyntheticAssistantBlockIndex: number;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

function coerceClaudeAnswerValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return "";
}

// Claude's AskUserQuestion SDK expects answers keyed by question text; the web UI submits stable ids.
function remapAnswersToClaudeQuestionText(
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

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  lastInteractionMode: "default" | "plan" | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  // Original API model id the runtime rerouted away from (safeguard refusal
  // fallback). While set, turns requesting that model stay on the fallback:
  // every flip back re-ingests the entire context as uncached tokens.
  rerouteOriginalApiModelId: string | undefined;
  // Context-size warnings already emitted for this session (once per threshold).
  readonly emittedContextUsageWarnings: Set<string>;
  stopped: boolean;
  // Unrecognized SDK message kinds already surfaced as a runtime warning. Newer
  // Claude SDKs stream high-frequency telemetry (e.g. `thinking_tokens`); de-duping
  // here keeps a single unknown kind from flooding the conversation timeline.
  readonly warnedUnhandledSdkKinds: Set<string>;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly supportedCommands: () => Promise<SlashCommand[]>;
  readonly supportedModels: () => Promise<ModelInfo[]>;
  readonly supportedAgents: () => Promise<AgentInfo[]>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function mapSupportedCommands(commands: SlashCommand[]): ProviderListCommandsResult {
  return {
    commands: commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description || undefined,
    })),
    source: "claudeAgent",
    cached: false,
  };
}

function neverResolvingUserMessageStream(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
      };
    },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

// Claude hook system messages can carry transient session ids; only durable
// conversation messages should advance the resumable provider cursor.
function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

// SIGINT (130) and SIGTERM (143) are graceful stop requests, not crashes. When the
// Claude subprocess receives one from outside our own stop path (an idle reaper, the
// OS, or a parent process tearing the process group down), the SDK stream throws
// "Claude Code process exited with code 143". Treat that as a suspend-and-resume,
// not a hard failure with an error toast. SIGKILL (137) is intentionally excluded:
// it usually signals an OOM/forced kill that is worth surfacing.
const CLAUDE_BENIGN_TERMINATION_EXIT_CODES = new Set([130, 143]);

const CLAUDE_BENIGN_TERMINATION_MESSAGE =
  "Claude runtime stopped and will resume on your next message.";

function isClaudeBenignTerminationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const exitCode = normalized.match(/exited with code (\d+)/)?.[1];
  if (exitCode !== undefined) {
    return CLAUDE_BENIGN_TERMINATION_EXIT_CODES.has(Number.parseInt(exitCode, 10));
  }
  return normalized.includes("signal sigterm") || normalized.includes("signal sigint");
}

function isClaudeBenignTerminationCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some(isClaudeBenignTerminationMessage);
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
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

function hasPendingUserInterrupt(context: ClaudeSessionContext): boolean {
  const activeTurnId = context.turnState?.turnId;
  return activeTurnId !== undefined && context.interruptRequestedTurnId === activeTurnId;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = positiveFiniteNumber(value.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function finiteTokenCountOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function claudePromptTokensFromRawUsage(usage: Record<string, unknown>): number {
  return (
    finiteTokenCountOrZero(usage.input_tokens) +
    finiteTokenCountOrZero(usage.cache_creation_input_tokens) +
    finiteTokenCountOrZero(usage.cache_read_input_tokens)
  );
}

function stripClaudeContextWindowSuffix(apiModelId: string): string {
  return apiModelId.replace(/\[[^\]]+\]$/u, "");
}

// Safeguard reroutes (e.g. Fable 5 refusal -> Opus fallback) stream as an
// untyped system message; match it structurally so SDK type drift stays inert.
interface ClaudeModelRefusalFallback {
  readonly originalModel: string;
  readonly fallbackModel: string;
  readonly content?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readClaudeModelRefusalFallback(message: unknown): ClaudeModelRefusalFallback | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    type?: unknown;
    subtype?: unknown;
    original_model?: unknown;
    fallback_model?: unknown;
    originalModel?: unknown;
    fallbackModel?: unknown;
    content?: unknown;
  };
  if (record.type !== "system" || record.subtype !== "model_refusal_fallback") {
    return undefined;
  }
  // Claude Agent SDK 0.3.x emits snake_case fields. Accept camelCase too so a
  // future typed SDK projection cannot silently disable reroute protection.
  const originalModel =
    readNonEmptyString(record.original_model) ?? readNonEmptyString(record.originalModel);
  const fallbackModel =
    readNonEmptyString(record.fallback_model) ?? readNonEmptyString(record.fallbackModel);
  if (!originalModel || !fallbackModel) {
    return undefined;
  }
  return {
    originalModel,
    fallbackModel,
    ...(typeof record.content === "string" && record.content.trim().length > 0
      ? { content: record.content }
      : {}),
  };
}

function normalizeClaudeTokenUsage(
  value: NonNullableUsage | Record<string, unknown> | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens =
    (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0) +
    (typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0) +
    (typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : 0;
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: usage.tool_uses }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

function mergeClaudeTokenUsageSnapshot(
  previous: ThreadTokenUsageSnapshot,
  accumulated: ThreadTokenUsageSnapshot | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot {
  const maxTokens = positiveFiniteNumber(contextWindow);
  const usedTokens =
    maxTokens !== undefined ? Math.min(previous.usedTokens, maxTokens) : previous.usedTokens;
  const lastUsedTokens =
    previous.lastUsedTokens !== undefined
      ? maxTokens !== undefined
        ? Math.min(previous.lastUsedTokens, maxTokens)
        : previous.lastUsedTokens
      : usedTokens;
  const totalProcessedTokens = Math.max(
    previous.totalProcessedTokens ?? previous.usedTokens,
    accumulated?.totalProcessedTokens ?? accumulated?.usedTokens ?? 0,
    usedTokens,
  );

  return {
    ...previous,
    usedTokens,
    lastUsedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
  };
}

const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

function resolveClaudeApiModelIdForContextWindow(
  apiModelId: string,
  selectedContextWindow: string | null | undefined,
): string {
  const baseApiModelId = stripClaudeContextWindowSuffix(apiModelId);
  const caps = getModelCapabilities("claudeAgent", baseApiModelId);
  return selectedContextWindow === "1m" && hasContextWindowOption(caps, "1m")
    ? `${baseApiModelId}[1m]`
    : baseApiModelId;
}

function resolveClaudeApiModelIdContextWindowMaxTokens(
  apiModelId: string | undefined,
): number | undefined {
  if (!apiModelId) {
    return undefined;
  }
  return resolveSelectedClaudeContextWindowMaxTokens(
    stripClaudeContextWindowSuffix(apiModelId),
    apiModelId.endsWith("[1m]") ? "1m" : undefined,
  );
}

function resolveSelectedClaudeContextWindowMaxTokens(
  model: string | null | undefined,
  selectedContextWindow: string | null | undefined,
): number | undefined {
  const caps = getModelCapabilities("claudeAgent", model);
  const resolvedContextWindow =
    trimOrNull(selectedContextWindow) ?? getDefaultContextWindow(caps) ?? null;
  if (
    !resolvedContextWindow ||
    !hasContextWindowOption(caps, resolvedContextWindow) ||
    !Object.prototype.hasOwnProperty.call(CLAUDE_CONTEXT_WINDOW_MAX_TOKENS, resolvedContextWindow)
  ) {
    return undefined;
  }

  return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS[
    resolvedContextWindow as keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS
  ];
}

function resolveEffectiveClaudeContextWindow(input: {
  reportedContextWindow: number | undefined;
  lastKnownContextWindow: number | undefined;
  currentApiModelId: string | undefined;
}): number | undefined {
  const { reportedContextWindow, lastKnownContextWindow, currentApiModelId } = input;
  const currentSessionUsesOneMillionWindow = currentApiModelId?.endsWith("[1m]") === true;
  if (
    currentSessionUsesOneMillionWindow &&
    lastKnownContextWindow === CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"] &&
    reportedContextWindow !== undefined &&
    reportedContextWindow < lastKnownContextWindow
  ) {
    return lastKnownContextWindow;
  }
  return reportedContextWindow ?? lastKnownContextWindow;
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
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

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    rerouteOriginalApiModelId?: unknown;
    rerouteFallbackApiModelId?: unknown;
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
  const rerouteOriginalApiModelId = readNonEmptyString(cursor.rerouteOriginalApiModelId);
  const rerouteFallbackApiModelId = readNonEmptyString(cursor.rerouteFallbackApiModelId);
  const hasCompleteReroute =
    rerouteOriginalApiModelId !== undefined && rerouteFallbackApiModelId !== undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
    ...(hasCompleteReroute ? { rerouteOriginalApiModelId, rerouteFallbackApiModelId } : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
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

function isReadOnlyToolName(toolName: string): boolean {
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

function classifyRequestType(toolName: string): CanonicalRequestType {
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

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
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

// Tools whose result is surfaced through a dedicated runtime channel — AskUserQuestion
// via the user-input request flow, ExitPlanMode via the proposed-plan flow — must NOT
// also emit a generic tool-call lifecycle item, or the timeline shows a redundant
// "ToolName: {json}" row alongside the real interaction surface.
function isClientSurfacedClaudeTool(toolName: string): boolean {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

// Stable per-call identity stamped on every tool lifecycle event's data so the client
// can collapse started/updated/completed (and dedupe parallel calls) by tool-call id
// instead of relying on row adjacency. Mirrors the shape other adapters emit (Pi/Grok).
function toolLifecycleEventData(
  tool: Pick<ToolInFlight, "itemId" | "toolName" | "input">,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: tool.itemId,
    callId: tool.itemId,
    toolName: tool.toolName,
    input: tool.input,
    ...extra,
  };
}

function normalizeClaudeTodoStatus(value: unknown): "pending" | "inProgress" | "completed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress") {
    return "inProgress";
  }
  return "pending";
}

function normalizeClaudeTodoTasks(input: Record<string, unknown>): {
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

function titleForTool(itemType: CanonicalItemType): string {
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

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;
const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_CONTEXT_WARNING_RATIO = 0.8;
const EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND = [
  "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
  "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
  "Treat the current working directory as the active workspace for the task.",
  "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
].join("\n");

function buildClaudeSdkSubagents(): Record<string, AgentDefinition> {
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

function buildPromptText(input: ProviderSendTurnInput): string {
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

function buildUserMessage(input: {
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

function buildClaudeImageContentBlock(input: {
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

function buildUserMessageEffect(
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
        });
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: dependencies.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to read attachment file."),
              cause,
            }),
        ),
      );

      sdkContent.push(
        buildClaudeImageContentBlock({
          mimeType: attachment.mimeType,
          bytes,
        }),
      );
    }

    const fileBlock = buildFileAttachmentsPromptBlock({
      attachments: input.attachments,
      attachmentsDir: dependencies.attachmentsDir,
      include: "all-files",
    });
    if (fileBlock) {
      sdkContent.push({ type: "text", text: fileBlock });
    }

    return buildUserMessage({ sdkContent });
  });
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
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

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
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

function sanitizeClaudeDisplayText(text: string): string {
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

function normalizeClaudeUserVisibleErrorMessage(
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

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string"
    ? sanitizeClaudeDisplayText(candidate.text)
    : "";
}

function extractTextContent(value: unknown): string {
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

function extractExitPlanModePlan(value: unknown): string | undefined {
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

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
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

function toSessionError(
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

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
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

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
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

function sdkNativeItemId(message: SDKMessage): string | undefined {
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

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const sessionLifecycleLocks = new Map<ThreadId, Semaphore.Semaphore>();
    let cachedModels: ProviderListModelsResult | null = null;
    let cachedAgents: ProviderListAgentsResult | null = null;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const withSessionLifecycleLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      let lock = sessionLifecycleLocks.get(threadId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        sessionLifecycleLocks.set(threadId, lock);
      }
      return lock.withPermits(1)(effect);
    };
    const resolveClaudeSdkEnv = Effect.sync(() =>
      buildClaudeProcessEnv({ env: process.env, homeDir: serverConfig.homeDir }),
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method: sdkNativeMethod(message),
              ...(typeof message.session_id === "string"
                ? { providerThreadId: message.session_id }
                : {}),
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterValidationError
    > =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
          ...(context.rerouteOriginalApiModelId && context.currentApiModelId
            ? {
                rerouteOriginalApiModelId: context.rerouteOriginalApiModelId,
                rerouteFallbackApiModelId: context.currentApiModelId,
              }
            : {}),
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureAssistantTextBlock = (
      context: ClaudeSessionContext,
      blockIndex: number,
      options?: {
        readonly fallbackText?: string;
        readonly streamClosed?: boolean;
      },
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const existing = turnState.assistantTextBlocks.get(blockIndex);
        if (existing && !existing.completionEmitted) {
          if (existing.fallbackText.length === 0 && options?.fallbackText) {
            existing.fallbackText = options.fallbackText;
          }
          if (options?.streamClosed) {
            existing.streamClosed = true;
          }
          return { blockIndex, block: existing };
        }

        const block: AssistantTextBlockState = {
          itemId: yield* Random.nextUUIDv4,
          blockIndex,
          emittedTextDelta: false,
          fallbackText: options?.fallbackText ?? "",
          streamClosed: options?.streamClosed ?? false,
          completionEmitted: false,
        };
        turnState.assistantTextBlocks.set(blockIndex, block);
        turnState.assistantTextBlockOrder.push(block);
        return { blockIndex, block };
      });

    const createSyntheticAssistantTextBlock = (
      context: ClaudeSessionContext,
      fallbackText: string,
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
        turnState.nextSyntheticAssistantBlockIndex -= 1;
        return yield* ensureAssistantTextBlock(context, blockIndex, {
          fallbackText,
          streamClosed: true,
        });
      });

    const completeAssistantTextBlock = (
      context: ClaudeSessionContext,
      block: AssistantTextBlockState,
      options?: {
        readonly force?: boolean;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || block.completionEmitted) {
          return;
        }

        if (!options?.force && !block.streamClosed) {
          return;
        }

        if (!block.emittedTextDelta && block.fallbackText.length > 0) {
          const deltaStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: deltaStamp.eventId,
            provider: PROVIDER,
            createdAt: deltaStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(block.itemId),
            payload: {
              streamKind: "assistant_text",
              delta: block.fallbackText,
            },
            providerRefs: nativeProviderRefs(context),
            ...(options?.rawMethod || options?.rawPayload
              ? {
                  raw: {
                    source: "claude.sdk.message" as const,
                    ...(options.rawMethod ? { method: options.rawMethod } : {}),
                    payload: options?.rawPayload,
                  },
                }
              : {}),
          });
        }

        block.completionEmitted = true;
        if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
          turnState.assistantTextBlocks.delete(block.blockIndex);
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          itemId: asRuntimeItemId(block.itemId),
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
          },
          providerRefs: nativeProviderRefs(context),
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      });

    const backfillAssistantTextBlocksFromSnapshot = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const snapshotTextBlocks = extractAssistantTextBlocks(message);
        if (snapshotTextBlocks.length === 0) {
          return;
        }

        const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
          blockIndex: block.blockIndex,
          block,
        }));

        for (const [position, text] of snapshotTextBlocks.entries()) {
          const existingEntry = orderedBlocks[position];
          const entry =
            existingEntry ??
            (yield* createSyntheticAssistantTextBlock(context, text).pipe(
              Effect.map((created) => {
                if (!created) {
                  return undefined;
                }
                orderedBlocks.push(created);
                return created;
              }),
            ));
          if (!entry) {
            continue;
          }

          if (entry.block.fallbackText.length === 0) {
            entry.block.fallbackText = text;
          }

          if (entry.block.streamClosed && !entry.block.completionEmitted) {
            yield* completeAssistantTextBlock(context, entry.block, {
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }
        }
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        if (!hasDurableClaudeSessionId(message)) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    // Warn once per session per threshold when the per-request prompt size makes
    // usage burn dangerous. Every request processes the full context again; cache
    // behavior changes how those tokens are categorized, not how large the request is.
    const maybeEmitContextUsageWarning = (
      context: ClaudeSessionContext,
      rawUsage: Record<string, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const promptTokens = claudePromptTokensFromRawUsage(rawUsage);
        if (promptTokens <= 0) {
          return;
        }
        const approxThousands = Math.round(promptTokens / 1000);
        if (
          promptTokens > CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS &&
          !context.emittedContextUsageWarnings.has("large-prompt")
        ) {
          context.emittedContextUsageWarnings.add("large-prompt");
          const windowLabel =
            context.lastKnownContextWindow === CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"] ||
            context.currentApiModelId?.endsWith("[1m]") === true
              ? " with the 1M window enabled"
              : "";
          yield* emitRuntimeWarning(
            context,
            `Claude is processing ~${approxThousands}k prompt tokens per request${windowLabel}. Large prompts consume usage limits much faster - consider starting a fresh thread.`,
          );
          return;
        }
        const contextWindow =
          context.lastKnownContextWindow ?? CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
        if (
          promptTokens > contextWindow * CLAUDE_CONTEXT_WARNING_RATIO &&
          !context.emittedContextUsageWarnings.has("near-window")
        ) {
          context.emittedContextUsageWarnings.add("near-window");
          yield* emitRuntimeWarning(
            context,
            `Claude context is above 80% of the ${Math.round(contextWindow / 1000)}k window (~${approxThousands}k tokens per request). Every request re-sends the full history - consider compacting or starting a fresh thread.`,
          );
        }
      });

    // Surfaces each distinct unrecognized SDK message kind at most once per session.
    // Without this, high-frequency telemetry the adapter doesn't model (notably the
    // `thinking_tokens` system subtype streamed on every reasoning tick) turns into a
    // "Runtime warning" timeline entry per message and floods the conversation.
    const warnUnhandledSdkKind = (
      context: ClaudeSessionContext,
      kind: string,
      message: string,
      detail: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.warnedUnhandledSdkKinds.has(kind)) {
          return;
        }
        context.warnedUnhandledSdkKinds.add(kind);
        yield* emitRuntimeWarning(context, message, detail);
      });

    const emitProposedPlanCompleted = (
      context: ClaudeSessionContext,
      input: {
        readonly planMarkdown: string;
        readonly toolUseId?: string | undefined;
        readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const planMarkdown = input.planMarkdown.trim();
        if (!turnState || planMarkdown.length === 0) {
          return;
        }

        const captureKey = exitPlanCaptureKey({
          toolUseId: input.toolUseId,
          planMarkdown,
        });
        if (turnState.capturedProposedPlanKeys.has(captureKey)) {
          return;
        }
        turnState.capturedProposedPlanKeys.add(captureKey);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            planMarkdown,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: input.rawSource,
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    // Normalizes Claude TodoWrite tool calls into the shared runtime task-list event.
    const emitTodoTasksUpdated = (
      context: ClaudeSessionContext,
      input: {
        readonly toolInput: Record<string, unknown>;
        readonly toolUseId?: string | undefined;
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const tasksPayload = normalizeClaudeTodoTasks(input.toolInput);
        if (!tasksPayload) {
          return;
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.tasks.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: tasksPayload,
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
        const effectiveContextWindow = resolveEffectiveClaudeContextWindow({
          reportedContextWindow: resultContextWindow,
          lastKnownContextWindow: context.lastKnownContextWindow,
          currentApiModelId: context.currentApiModelId,
        });
        if (effectiveContextWindow !== undefined) {
          context.lastKnownContextWindow = effectiveContextWindow;
        }

        // The SDK result.usage contains *accumulated* totals across all API calls
        // (input_tokens, cache_read_input_tokens, etc. summed over every request).
        // This does NOT represent the current context window size.
        // Instead, use the last known context-window-accurate usage from task_progress
        // events and treat the accumulated total as totalProcessedTokens.
        const accumulatedSnapshot = normalizeClaudeTokenUsage(
          result?.usage,
          effectiveContextWindow,
        );
        const lastGoodUsage = context.lastKnownTokenUsage;
        const maxTokens = effectiveContextWindow;
        const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
          ? mergeClaudeTokenUsageSnapshot(lastGoodUsage, accumulatedSnapshot, maxTokens)
          : accumulatedSnapshot;

        const turnState = context.turnState;
        if (!turnState) {
          if (usageSnapshot) {
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              payload: {
                usage: usageSnapshot,
              },
              providerRefs: {},
            });
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        for (const [index, tool] of context.inFlightTools.entries()) {
          const toolStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: toolStamp.eventId,
            provider: PROVIDER,
            createdAt: toolStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: status === "completed" ? "completed" : "failed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolLifecycleEventData(tool),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
          if (tool.itemType === "file_change") {
            context.turnState = {
              ...turnState,
              sawFileChange: true,
            };
          }
          context.inFlightTools.delete(index);
        }
        // Clear any remaining stale entries (e.g. from interrupted content blocks)
        context.inFlightTools.clear();

        for (const block of turnState.assistantTextBlockOrder) {
          yield* completeAssistantTextBlock(context, block, {
            force: true,
            rawMethod: "claude/result",
            rawPayload: result ?? { status },
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        if (usageSnapshot) {
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId: usageStamp.eventId,
            provider: PROVIDER,
            createdAt: usageStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              usage: usageSnapshot,
            },
            providerRefs: nativeProviderRefs(context),
          });
        }

        // Feed Claude edits into the same placeholder checkpoint flow used by Codex.
        if (status === "completed" && turnState.sawFileChange) {
          const diffStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.diff.updated",
            eventId: diffStamp.eventId,
            provider: PROVIDER,
            createdAt: diffStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              unifiedDiff: "",
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });

        const updatedAt = yield* nowIso;
        if (context.interruptRequestedTurnId === turnState.turnId) {
          context.interruptRequestedTurnId = undefined;
        }
        context.lastInteractionMode = turnState.interactionMode;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        if (event.type === "content_block_delta") {
          if (
            (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
            context.turnState
          ) {
            const deltaText =
              event.delta.type === "text_delta"
                ? event.delta.text
                : typeof event.delta.thinking === "string"
                  ? event.delta.thinking
                  : "";
            if (deltaText.length === 0) {
              return;
            }
            const streamKind = streamKindFromDeltaType(event.delta.type);
            const assistantBlockEntry =
              event.delta.type === "text_delta"
                ? yield* ensureAssistantTextBlock(context, event.index)
                : context.turnState.assistantTextBlocks.get(event.index)
                  ? {
                      blockIndex: event.index,
                      block: context.turnState.assistantTextBlocks.get(
                        event.index,
                      ) as AssistantTextBlockState,
                    }
                  : undefined;
            if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
              assistantBlockEntry.block.emittedTextDelta = true;
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              ...(assistantBlockEntry?.block
                ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
                : {}),
              payload: {
                streamKind,
                delta: deltaText,
              },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
            return;
          }

          if (event.delta.type === "input_json_delta") {
            const tool = context.inFlightTools.get(event.index);
            if (!tool || typeof event.delta.partial_json !== "string") {
              return;
            }

            const partialInputJson = tool.partialInputJson + event.delta.partial_json;
            const parsedInput = tryParseJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput)
              : tool.detail;
            let nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              ...(parsedInput ? { input: parsedInput } : {}),
              ...(detail ? { detail } : {}),
            };

            const nextFingerprint =
              parsedInput && Object.keys(parsedInput).length > 0
                ? toolInputFingerprint(parsedInput)
                : undefined;
            context.inFlightTools.set(event.index, nextTool);

            if (
              !parsedInput ||
              !nextFingerprint ||
              tool.lastEmittedInputFingerprint === nextFingerprint
            ) {
              return;
            }

            nextTool = {
              ...nextTool,
              lastEmittedInputFingerprint: nextFingerprint,
            };
            context.inFlightTools.set(event.index, nextTool);

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.updated",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              itemId: asRuntimeItemId(nextTool.itemId),
              payload: {
                itemType: nextTool.itemType,
                status: "inProgress",
                title: nextTool.title,
                ...(nextTool.detail ? { detail: nextTool.detail } : {}),
                data: toolLifecycleEventData(nextTool),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta/input_json_delta",
                payload: message,
              },
            });
            if (nextTool.toolName === "TodoWrite") {
              yield* emitTodoTasksUpdated(context, {
                toolInput: nextTool.input,
                toolUseId: nextTool.itemId,
                rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
                rawPayload: message,
              });
            }
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (block.type === "text") {
            yield* ensureAssistantTextBlock(context, index, {
              fallbackText: extractContentBlockText(block),
            });
            return;
          }
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }
          const toolName = block.name;
          // AskUserQuestion / ExitPlanMode are rendered by their own runtime channels;
          // emitting a generic tool item here would duplicate them as a raw row.
          if (isClientSurfacedClaudeTool(toolName)) {
            return;
          }
          const itemType = classifyToolItemType(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);
          const inputFingerprint =
            Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType),
            detail,
            input: toolInput,
            partialInputJson: "",
            ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
          };
          context.inFlightTools.set(index, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolLifecycleEventData(tool),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          if (toolName === "TodoWrite") {
            yield* emitTodoTasksUpdated(context, {
              toolInput,
              toolUseId: tool.itemId,
              rawMethod: "claude/stream_event/content_block_start",
              rawPayload: message,
            });
          }
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            yield* completeAssistantTextBlock(context, assistantBlock, {
              rawMethod: "claude/stream_event/content_block_stop",
              rawPayload: message,
            });
            return;
          }
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
        }
      });

    const handleUserMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "user") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
        }

        for (const toolResult of toolResultBlocksFromUserMessage(message)) {
          const toolEntry = Array.from(context.inFlightTools.entries()).find(
            ([, tool]) => tool.itemId === toolResult.toolUseId,
          );
          if (!toolEntry) {
            continue;
          }

          const [index, tool] = toolEntry;
          const itemStatus = toolResult.isError ? "failed" : "completed";
          const toolData = toolLifecycleEventData(tool, { result: toolResult.block });

          const updatedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: updatedStamp.eventId,
            provider: PROVIDER,
            createdAt: updatedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: toolResult.isError ? "failed" : "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          const streamKind = toolResultStreamKind(tool.itemType);
          if (streamKind && toolResult.text.length > 0 && context.turnState) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind,
                delta: toolResult.text,
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
          }

          const completedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: completedStamp.eventId,
            provider: PROVIDER,
            createdAt: completedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: itemStatus,
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          if (tool.itemType === "file_change" && context.turnState) {
            context.turnState = {
              ...context.turnState,
              sawFileChange: true,
            };
          }
          context.inFlightTools.delete(index);
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        // Auto-start a synthetic turn for assistant messages that arrive without
        // an active turn (e.g., background agent/subagent responses between user prompts).
        if (!context.turnState) {
          const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
          const startedAt = yield* nowIso;
          context.turnState = {
            turnId,
            startedAt,
            interactionMode: "default",
            items: [],
            assistantTextBlocks: new Map(),
            assistantTextBlockOrder: [],
            capturedProposedPlanKeys: new Set(),
            sawFileChange: false,
            nextSyntheticAssistantBlockIndex: -1,
          };
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: startedAt,
          };
          const turnStartedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.started",
            eventId: turnStartedStamp.eventId,
            provider: PROVIDER,
            createdAt: turnStartedStamp.createdAt,
            threadId: context.session.threadId,
            turnId,
            payload: {},
            providerRefs: {
              ...nativeProviderRefs(context),
              providerTurnId: turnId,
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/synthetic-turn-start",
              payload: {},
            },
          });
        }
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            const toolUse = block as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
              continue;
            }
            const planMarkdown = extractExitPlanModePlan(toolUse.input);
            if (!planMarkdown) {
              continue;
            }
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }

          const taggedPlanMarkdown =
            context.turnState?.interactionMode === "plan"
              ? extractProposedPlanMarkdown(extractTextContent(content))
              : undefined;
          if (taggedPlanMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown: taggedPlanMarkdown,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant/proposed-plan-block",
              rawPayload: message,
            });
          }
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          yield* backfillAssistantTextBlocksFromSnapshot(context, message);
        }

        // Capture per-API-call usage from the assistant response for accurate
        // context window tracking. Unlike task_progress (accumulated per-task),
        // this reflects the actual prompt + output size for this single API call.
        const perCallUsage = (message.message as { usage?: unknown } | undefined)?.usage;
        if (perCallUsage) {
          yield* maybeEmitContextUsageWarning(context, perCallUsage as Record<string, unknown>);
          const normalizedPerCallUsage = normalizeClaudeTokenUsage(
            perCallUsage as Record<string, unknown>,
            context.lastKnownContextWindow,
          );
          if (normalizedPerCallUsage) {
            context.lastKnownTokenUsage = normalizedPerCallUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              payload: { usage: normalizedPerCallUsage },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/assistant-usage",
                payload: perCallUsage,
              },
            });
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status =
          hasPendingUserInterrupt(context) && message.subtype === "error_during_execution"
            ? "interrupted"
            : turnStatusFromResult(message);
        const errorMessage =
          message.subtype === "success"
            ? undefined
            : normalizeClaudeUserVisibleErrorMessage(message.errors[0], status);

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        // Benign high-frequency telemetry we intentionally don't project. `thinking_tokens`
        // streams on every reasoning tick while extended thinking is active; `task_updated`
        // is an incremental task patch already covered by task_started/progress/completed.
        // Short-circuit before allocating an event stamp so they can't flood the timeline
        // (or churn allocations) with "Runtime warning" entries.
        if (message.subtype === "thinking_tokens" || message.subtype === "task_updated") {
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        // Safeguard reroute (e.g. Fable 5 refusal -> Opus fallback). Pin the session
        // to the fallback model: forcing the refused model back on the next turn
        // costs two full-context cache misses per bounce.
        const refusalFallback = readClaudeModelRefusalFallback(message);
        if (refusalFallback) {
          context.rerouteOriginalApiModelId ??= refusalFallback.originalModel;
          context.currentApiModelId = refusalFallback.fallbackModel;
          yield* updateResumeCursor(context);
          yield* offerRuntimeEvent({
            ...base,
            type: "model.rerouted",
            payload: {
              fromModel: refusalFallback.originalModel,
              toModel: refusalFallback.fallbackModel,
              reason: refusalFallback.content ?? "Model safeguards rerouted this request.",
            },
          });
          return;
        }

        switch (message.subtype) {
          case "init":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
              },
            });
            return;
          case "task_progress":
            if (message.usage) {
              const normalizedUsage = normalizeClaudeTokenUsage(
                message.usage,
                context.lastKnownContextWindow,
              );
              if (normalizedUsage) {
                context.lastKnownTokenUsage = normalizedUsage;
                const usageStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  ...base,
                  eventId: usageStamp.eventId,
                  createdAt: usageStamp.createdAt,
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
              },
            });
            return;
          case "task_notification":
            if (message.usage) {
              const normalizedUsage = normalizeClaudeTokenUsage(
                message.usage,
                context.lastKnownContextWindow,
              );
              if (normalizedUsage) {
                context.lastKnownTokenUsage = normalizedUsage;
                const usageStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  ...base,
                  eventId: usageStamp.eventId,
                  createdAt: usageStamp.createdAt,
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
              },
            });
            return;
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          default:
            yield* warnUnhandledSdkKind(
              context,
              `system:${message.subtype}`,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            yield* handleUserMessage(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* warnUnhandledSdkKind(
              context,
              `type:${message.type}`,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }

        if (Exit.isFailure(exit)) {
          if (hasPendingUserInterrupt(context) || isClaudeInterruptedCause(exit.cause)) {
            if (context.turnState) {
              yield* completeTurn(
                context,
                "interrupted",
                interruptionMessageFromClaudeCause(exit.cause),
              );
            }
          } else if (isClaudeBenignTerminationCause(exit.cause)) {
            // External SIGTERM/SIGINT: a graceful stop, not a crash. Suspend the turn
            // without an error toast so the session resumes on the next message.
            yield* Effect.logInfo("claude.session.benign_termination", {
              threadId: context.session.threadId,
              detail: messageFromClaudeStreamCause(exit.cause, "Claude runtime terminated."),
            });
            if (context.turnState) {
              yield* completeTurn(context, "interrupted", CLAUDE_BENIGN_TERMINATION_MESSAGE);
            }
          } else {
            const message = messageFromClaudeStreamCause(
              exit.cause,
              "Claude runtime stream failed.",
            );
            yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
            yield* completeTurn(context, "failed", message);
          }
        } else if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
        }

        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
        context.pendingApprovals.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;
        if (streamFiber && streamFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(streamFiber);
        }

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        if (sessions.get(context.session.threadId) === context) {
          sessions.delete(context.session.threadId);
        }
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        /**
         * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
         * runtime event and waiting for the user to respond via `respondToUserInput`.
         */
        const handleAskUserQuestion = (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
        ) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

            // Parse questions from the SDK's AskUserQuestion input.
            const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
            const questions: Array<UserInputQuestion> = rawQuestions.map(
              (q: Record<string, unknown>, idx: number) => ({
                id: typeof q.header === "string" ? q.header : `q-${idx}`,
                header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
                question: typeof q.question === "string" ? q.question : "",
                options: Array.isArray(q.options)
                  ? q.options.map((opt: Record<string, unknown>) => ({
                      label: typeof opt.label === "string" ? opt.label : "",
                      description: typeof opt.description === "string" ? opt.description : "",
                    }))
                  : [],
                multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
              }),
            );

            const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
            let aborted = false;
            const pendingInput: PendingUserInput = {
              questions,
              answers: answersDeferred,
            };

            // Emit user-input.requested so the UI can present the questions.
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { questions },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion",
                payload: { toolName: "AskUserQuestion", input: toolInput },
              },
            });

            pendingUserInputs.set(requestId, pendingInput);

            // Handle abort (e.g. turn interrupted while waiting for user input).
            const onAbort = () => {
              if (!pendingUserInputs.has(requestId)) {
                return;
              }
              aborted = true;
              pendingUserInputs.delete(requestId);
              Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
            };
            callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

            // Block until the user provides answers.
            const answers = remapAnswersToClaudeQuestionText(
              questions,
              yield* Deferred.await(answersDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              ),
            );
            pendingUserInputs.delete(requestId);

            // Emit user-input.resolved so the UI knows the interaction completed.
            const resolvedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.resolved",
              eventId: resolvedStamp.eventId,
              provider: PROVIDER,
              createdAt: resolvedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { answers },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion/resolved",
                payload: { answers },
              },
            });

            if (aborted) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }

            // Return the answers to the SDK in the expected format:
            // { questions: [...], answers: { questionText: selectedLabel } }
            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers,
              },
            } satisfies PermissionResult;
          });

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // Handle AskUserQuestion: surface clarifying questions to the
              // user via the user-input runtime event channel, regardless of
              // runtime mode (plan mode relies on this heavily).
              if (toolName === "AskUserQuestion") {
                return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
              }

              if (toolName === "ExitPlanMode") {
                const planMarkdown = extractExitPlanModePlan(toolInput);
                if (planMarkdown) {
                  yield* emitProposedPlanCompleted(context, {
                    planMarkdown,
                    toolUseId: callbackOptions.toolUseID,
                    rawSource: "claude.sdk.permission",
                    rawMethod: "canUseTool/ExitPlanMode",
                    rawPayload: {
                      toolName,
                      input: toolInput,
                    },
                  });
                }

                return {
                  behavior: "deny",
                  message:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                } satisfies PermissionResult;
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              );
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                createdAt: resolvedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  decision,
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/decision",
                  payload: {
                    decision,
                  },
                },
              });

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const providerOptions = input.providerOptions?.claudeAgent;
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedEffort = trimOrNull(modelSelection?.options?.effort ?? null);
        const requestedContextWindow = trimOrNull(modelSelection?.options?.contextWindow ?? null);
        const caps = getModelCapabilities("claudeAgent", modelSelection?.model);
        const requestedApiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
        const resumeRerouteOriginalApiModelId = resumeState?.rerouteOriginalApiModelId;
        const resumeRerouteFallbackApiModelId = resumeState?.rerouteFallbackApiModelId;
        const resumedRerouteMatchesSelection =
          resumeRerouteOriginalApiModelId !== undefined &&
          resumeRerouteFallbackApiModelId !== undefined &&
          (requestedApiModelId === undefined ||
            stripClaudeContextWindowSuffix(requestedApiModelId) ===
              stripClaudeContextWindowSuffix(resumeRerouteOriginalApiModelId));
        const resumedRerouteOriginalApiModelId = resumedRerouteMatchesSelection
          ? resumeRerouteOriginalApiModelId
          : undefined;
        const resumedRerouteFallbackApiModelId = resumedRerouteMatchesSelection
          ? requestedApiModelId === undefined
            ? resumeRerouteFallbackApiModelId
            : resolveClaudeApiModelIdForContextWindow(
                resumeRerouteFallbackApiModelId,
                requestedContextWindow,
              )
          : undefined;
        const apiModelId = resumedRerouteFallbackApiModelId ?? requestedApiModelId;
        const effort =
          requestedEffort && hasEffortLevel(caps, requestedEffort) ? requestedEffort : null;
        const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
        const thinking =
          typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
            ? modelSelection.options.thinking
            : undefined;
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const ultracode = effort === "ultracode" && hasEffortLevel(caps, "xhigh");
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);
        const settings = {
          // Keep SDK auto-compaction explicit. Its threshold follows the effective
          // context window, so 1M remains an intentional per-thread choice.
          autoCompactEnabled: true,
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
        };
        const claudeSubagents = buildClaudeSdkSubagents();
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          // Keep Claude context-window selection model-driven so session start
          // and in-session switches both use the same API model contract.
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND,
          },
          ...(Object.keys(claudeSubagents).length > 0 ? { agents: claudeSubagents } : {}),
          // Keep the runtime value explicit so Opus 4.7 can pass xhigh through to the SDK.
          ...(effectiveEffort
            ? { effort: effectiveEffort as "low" | "medium" | "high" | "xhigh" | "max" }
            : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          settings,
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          canUseTool,
          env: claudeSdkEnv,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        let installationContext: ClaudeSessionContext | undefined;
        let installationComplete = false;

        return yield* Effect.gen(function* () {
          // Populate model cache in background from first session
          if (!cachedModels) {
            queryRuntime
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {
                /* ignore discovery failures */
              });
          }

          // Populate agent cache in background from first session
          if (!cachedAgents) {
            queryRuntime
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {
                /* ignore discovery failures */
              });
          }

          const session: ProviderSession = {
            threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(threadId ? { threadId } : {}),
            resumeCursor: {
              ...(threadId ? { threadId } : {}),
              ...(sessionId ? { resume: sessionId } : {}),
              ...(resumeState?.resumeSessionAt
                ? { resumeSessionAt: resumeState.resumeSessionAt }
                : {}),
              turnCount: resumeState?.turnCount ?? 0,
              ...(resumedRerouteOriginalApiModelId && resumedRerouteFallbackApiModelId
                ? {
                    rerouteOriginalApiModelId: resumedRerouteOriginalApiModelId,
                    rerouteFallbackApiModelId: resumedRerouteFallbackApiModelId,
                  }
                : {}),
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          const context: ClaudeSessionContext = {
            session,
            promptQueue,
            query: queryRuntime,
            streamFiber: undefined,
            startedAt,
            basePermissionMode: permissionMode,
            lastInteractionMode: undefined,
            currentApiModelId: apiModelId,
            resumeSessionId: sessionId,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            inFlightTools,
            turnState: undefined,
            interruptRequestedTurnId: undefined,
            lastKnownContextWindow: resolveClaudeApiModelIdContextWindowMaxTokens(apiModelId),
            lastKnownTokenUsage: undefined,
            lastAssistantUuid: resumeState?.resumeSessionAt,
            lastThreadStartedId: undefined,
            rerouteOriginalApiModelId: resumedRerouteOriginalApiModelId,
            emittedContextUsageWarnings: new Set(),
            stopped: false,
            warnedUnhandledSdkKinds: new Set(),
          };
          installationContext = context;
          yield* withSessionLifecycleLock(
            threadId,
            Effect.gen(function* () {
              // Create the replacement first so a spawn failure leaves the current
              // session usable, then atomically retire the old runtime before install.
              const existing = sessions.get(threadId);
              if (existing && existing !== context) {
                yield* stopSessionInternal(existing, { emitExitEvent: false });
              }

              yield* Ref.set(contextRef, context);
              sessions.set(threadId, context);

              const sessionStartedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "session.started",
                eventId: sessionStartedStamp.eventId,
                provider: PROVIDER,
                createdAt: sessionStartedStamp.createdAt,
                threadId,
                payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
                providerRefs: {},
              });

              const configuredStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "session.configured",
                eventId: configuredStamp.eventId,
                provider: PROVIDER,
                createdAt: configuredStamp.createdAt,
                threadId,
                payload: {
                  config: {
                    ...(modelSelection?.model ? { model: modelSelection.model } : {}),
                    ...(apiModelId ? { apiModelId } : {}),
                    ...(requestedContextWindow ? { contextWindow: requestedContextWindow } : {}),
                    ...(input.cwd ? { cwd: input.cwd } : {}),
                    ...(effectiveEffort ? { effort: effectiveEffort } : {}),
                    ...(permissionMode ? { permissionMode } : {}),
                    ...(providerOptions?.maxThinkingTokens !== undefined
                      ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                      : {}),
                    ...(fastMode ? { fastMode: true } : {}),
                    ...(ultracode ? { ultracode: true } : {}),
                  },
                },
                providerRefs: {},
              });

              const readyStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "session.state.changed",
                eventId: readyStamp.eventId,
                provider: PROVIDER,
                createdAt: readyStamp.createdAt,
                threadId,
                payload: {
                  state: "ready",
                },
                providerRefs: {},
              });

              if (context.lastKnownContextWindow === CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"]) {
                context.emittedContextUsageWarnings.add("one-million-window");
                yield* emitRuntimeWarning(
                  context,
                  "Claude's 1M context window is enabled for this thread. Auto-compaction follows that larger window, so long conversations can consume usage limits much faster. Switch this thread to 200k if 1M was inherited unintentionally.",
                );
              }

              const streamFiber = Effect.runFork(runSdkStream(context));
              context.streamFiber = streamFiber;
              streamFiber.addObserver((exit) => {
                if (context.stopped) {
                  return;
                }
                if (context.streamFiber === streamFiber) {
                  context.streamFiber = undefined;
                }
                Effect.runFork(handleStreamExit(context, exit));
              });
            }),
          );

          installationComplete = true;
          return {
            ...session,
          };
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (installationComplete) {
                return Effect.void;
              }
              if (installationContext !== undefined) {
                return stopSessionInternal(installationContext, { emitExitEvent: false });
              }
              return Effect.gen(function* () {
                yield* Queue.shutdown(promptQueue);
                const closeExit = yield* Effect.exit(Effect.sync(() => queryRuntime.close()));
                if (Exit.isFailure(closeExit)) {
                  yield* Effect.logWarning("claude.session.failed_install_cleanup", {
                    threadId,
                    cause: Cause.pretty(closeExit.cause),
                  });
                }
              });
            }),
          ),
        );
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedContextWindowMaxTokens = resolveSelectedClaudeContextWindowMaxTokens(
          modelSelection?.model,
          modelSelection?.options?.contextWindow,
        );

        if (context.turnState) {
          // Auto-close a stale synthetic turn (from background agent responses
          // between user prompts) to prevent blocking the user's next turn.
          yield* completeTurn(context, "completed");
        }

        if (modelSelection?.model) {
          const apiModelId = resolveApiModelId(modelSelection);
          const reroutedFrom = context.rerouteOriginalApiModelId;
          const requestsReroutedModel =
            reroutedFrom !== undefined &&
            stripClaudeContextWindowSuffix(apiModelId) ===
              stripClaudeContextWindowSuffix(reroutedFrom);
          if (requestsReroutedModel) {
            // A safeguard reroute pinned this session to the fallback model. The
            // thread selection still names the refused model; switching back would
            // re-ingest the entire context uncached (and likely bounce again), so
            // stay on the fallback until the user picks a different model. Context
            // window changes still apply to the effective fallback model.
            const fallbackApiModelId = context.currentApiModelId;
            if (fallbackApiModelId !== undefined) {
              const effectiveFallbackApiModelId = resolveClaudeApiModelIdForContextWindow(
                fallbackApiModelId,
                modelSelection.options?.contextWindow,
              );
              if (effectiveFallbackApiModelId !== fallbackApiModelId) {
                yield* Effect.tryPromise({
                  try: () => context.query.setModel(effectiveFallbackApiModelId),
                  catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
                });
              }
              context.currentApiModelId = effectiveFallbackApiModelId;
              context.lastKnownContextWindow = resolveClaudeApiModelIdContextWindowMaxTokens(
                effectiveFallbackApiModelId,
              );
              yield* updateResumeCursor(context);
            }
          } else {
            if (apiModelId !== context.currentApiModelId) {
              yield* Effect.tryPromise({
                try: () => context.query.setModel(apiModelId),
                catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
              });
            }
            context.currentApiModelId = apiModelId;
            context.rerouteOriginalApiModelId = undefined;
            if (requestedContextWindowMaxTokens !== undefined) {
              context.lastKnownContextWindow = requestedContextWindowMaxTokens;
            }
            yield* updateResumeCursor(context);
          }
        }

        // Apply interaction mode on every turn so sticky SDK permission state
        // cannot leak plan mode across service/recovery paths that omit it.
        const effectiveInteractionMode = input.interactionMode ?? "default";
        if (effectiveInteractionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        } else if (
          context.basePermissionMode !== undefined ||
          context.lastInteractionMode === "plan"
        ) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          interactionMode: effectiveInteractionMode,
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: context.currentApiModelId
            ? { model: stripClaudeContextWindowSuffix(context.currentApiModelId) }
            : modelSelection?.model
              ? { model: modelSelection.model }
              : {},
          providerRefs: {},
        });

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.turnState) {
          context.interruptRequestedTurnId = context.turnState.turnId;
        }
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      withSessionLifecycleLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          yield* stopSessionInternal(context, {
            emitExitEvent: true,
          });
        }),
      );

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    // Native command discovery cache — avoids spawning a process per query.
    let commandsCache: { result: ProviderListCommandsResult; cwd: string } | null = null;
    let pendingCommandDiscovery: Promise<ProviderListCommandsResult> | null = null;

    async function discoverCommandsViaTemporaryProcess(
      cwd: string,
      env: NodeJS.ProcessEnv,
    ): Promise<ProviderListCommandsResult> {
      // Spawn a lightweight Claude Code process for native command discovery.
      // The SDK's supportedCommands() awaits an internal initialization promise
      // that only resolves when the async generator is iterated (driving the
      // subprocess handshake). We iterate in the background to unblock it.
      const tempQuery = createQuery({
        prompt: neverResolvingUserMessageStream(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          permissionMode: "plan" as PermissionMode,
          persistSession: false,
          env,
        },
      });

      try {
        // Drive the iterator so the subprocess completes its init handshake.
        // This runs in the background; close() in the finally block stops it.
        void (async () => {
          for await (const message of tempQuery) {
            void message;
            /* consume until closed */
          }
        })().catch(() => undefined);

        const commands = await tempQuery.supportedCommands();
        return mapSupportedCommands(commands);
      } finally {
        tempQuery.close();
      }
    }

    const listCommands: NonNullable<ClaudeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        // 1. Try an active session first (cheapest path).
        const context = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : [...sessions.values()].find((s) => !s.stopped);

        if (context && !context.stopped) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            catch: (cause) => toRequestError(context.session.threadId, "listCommands", cause),
          });
          const result = mapSupportedCommands(commands);
          commandsCache = { result, cwd: input.cwd };
          return result;
        }

        // 2. Return from cache if valid and not force-reloading.
        if (commandsCache && commandsCache.cwd === input.cwd && !input.forceReload) {
          return { ...commandsCache.result, cached: true } satisfies ProviderListCommandsResult;
        }

        // 3. Spawn a temporary process for discovery (deduplicating concurrent requests).
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const discoveryPromise =
          pendingCommandDiscovery ?? discoverCommandsViaTemporaryProcess(input.cwd, claudeSdkEnv);
        pendingCommandDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => discoveryPromise,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("discovery"),
              detail: toMessage(cause, "Failed to discover Claude commands."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
        );

        commandsCache = { result, cwd: input.cwd };
        return result;
      });

    const listSkills: NonNullable<ClaudeAdapterShape["listSkills"]> = (
      _input: ProviderListSkillsInput,
    ) =>
      Effect.succeed({
        skills: [],
        source: "unsupported",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    const composerCapabilities: ProviderComposerCapabilities = {
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: false,
      supportsThreadImport: true,
    };

    const getComposerCapabilities: NonNullable<
      ClaudeAdapterShape["getComposerCapabilities"]
    > = () => Effect.succeed(composerCapabilities);

    const listModels: NonNullable<ClaudeAdapterShape["listModels"]> = (_input) =>
      Effect.sync(() => {
        if (cachedModels) {
          return { ...cachedModels, cached: true };
        }
        // Fallback: try to get models from any active session
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            // Trigger async cache population
            context.query
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        // Return empty while waiting for cache
        return { models: [], source: "pending", cached: false };
      });

    const listAgents: NonNullable<ClaudeAdapterShape["listAgents"]> = (_input) =>
      Effect.sync(() => {
        if (cachedAgents) {
          return { ...cachedAgents, cached: true };
        }
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            context.query
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        return { agents: [], source: "pending", cached: false };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listCommands,
      listSkills,
      listModels,
      listAgents,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });
}

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
