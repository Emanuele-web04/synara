import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ProviderKind,
  type ProviderComposerCapabilities,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import type {
  Agent,
  AssistantMessage,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Todo,
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
  KILO_CLI_SPEC,
  type OpenCodeCliModelDescriptor,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeInventory,
  OPENCODE_CLI_SPEC,
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

type OpenCodeCompatibleProvider = Extract<ProviderKind, "opencode" | "kilo">;

interface OpenCodeCompatibleAdapterConfig {
  readonly provider: OpenCodeCompatibleProvider;
  readonly displayName: string;
  readonly defaultBinaryPath: string;
  readonly providerOptionsKey: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event" | "kilo.sdk.event";
  readonly turnIdPrefix: string;
  readonly cliModelSource: string;
  readonly fallbackModelSource: string;
  readonly defaultAgent: string;
  readonly planAgent: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
}

const OPENCODE_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "opencode",
  displayName: "OpenCode",
  defaultBinaryPath: "opencode",
  providerOptionsKey: "opencode",
  runtimeEventSource: "opencode.sdk.event",
  turnIdPrefix: "opencode-turn",
  cliModelSource: "opencode-cli",
  fallbackModelSource: "opencode",
  defaultAgent: "build",
  planAgent: "plan",
  cliSpec: OPENCODE_CLI_SPEC,
};

const KILO_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "kilo",
  displayName: "Kilo",
  defaultBinaryPath: "kilo",
  providerOptionsKey: "kilo",
  runtimeEventSource: "kilo.sdk.event",
  turnIdPrefix: "kilo-turn",
  cliModelSource: "kilo-cli",
  fallbackModelSource: "kilo",
  defaultAgent: "code",
  planAgent: "plan",
  cliSpec: KILO_CLI_SPEC,
};

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
  activeInteractionMode: "default" | "plan" | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

interface OpenCodeMessageSnapshot {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly time?: {
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtime?: OpenCodeRuntimeShape;
  readonly adapterConfig?: OpenCodeCompatibleAdapterConfig;
}

function nowIso(): string {
  return new Date().toISOString();
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

function asRuntimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

function buildProviderEventBase(input: {
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

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
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

function mapPermissionToRequestType(
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

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
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

function openCodeSnapshotKey(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
    if (part.type === "text" && part.time?.end !== undefined) {
      context.completedAssistantPartIds.add(part.id);
    }
  }
}

function openCodeMessageSnapshotFromEntry(entry: {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly time?: {
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

function openCodeMessageSnapshotsFromResponse(
  entries: ReadonlyArray<{
    readonly info: {
      readonly id: string;
      readonly role: string;
      readonly time?: {
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

function isFinalAssistantMessageSnapshot(snapshot: OpenCodeMessageSnapshot): boolean {
  return (
    snapshot.info.role === "assistant" &&
    typeof snapshot.info.time?.completed === "number" &&
    snapshot.info.finish !== "tool-calls"
  );
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

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
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

function normalizeOpenCodeTodoStatus(value: unknown): "pending" | "inProgress" | "completed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress") {
    return "inProgress";
  }
  return "pending";
}

function normalizeOpenCodeTodoTasks(todos: ReadonlyArray<Todo>): {
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

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): { readonly latestText: string; readonly deltaToEmit: string } {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): { readonly nextText: string; readonly deltaToEmit: string } {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
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

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
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

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function isOpenCodeContextOverflowError(error: unknown): boolean {
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
  context.activeInteractionMode = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.latestTurnCostUsd = undefined;
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
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

type OpenCodeModelInventory = {
  readonly providerList: {
    readonly connected: ReadonlyArray<string>;
    readonly all: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly source?: string;
      readonly env?: ReadonlyArray<string>;
      readonly options?: Record<string, unknown>;
      readonly models: Record<
        string,
        {
          readonly id: string;
          readonly name: string;
          readonly options?: Record<string, unknown>;
          readonly capabilities?: {
            readonly reasoning?: boolean;
          };
          readonly limit?: {
            readonly context?: number;
            readonly output?: number;
          };
          readonly variants?: Record<string, Record<string, unknown>>;
          readonly isFree?: boolean;
        }
      >;
    }>;
  };
  readonly consoleState?: {
    readonly consoleManagedProviders: ReadonlyArray<string>;
  } | null;
};

type OpenCodeInventoryProvider = OpenCodeModelInventory["providerList"]["all"][number];
type OpenCodeModelDescriptor = ProviderListModelsResult["models"][number];

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

type OpenCodeAssistantTokens = AssistantMessage["tokens"];

interface NormalizedOpenCodeTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function readOpenCodeTokens(tokens: unknown): NormalizedOpenCodeTokens | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const tokenRecord = tokens as Partial<OpenCodeAssistantTokens>;
  const inputTokens = asNonNegativeInteger(tokenRecord.input);
  const outputTokens = asNonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = asNonNegativeInteger(tokenRecord.reasoning);
  const cacheReadTokens = asNonNegativeInteger(tokenRecord.cache?.read);
  const cacheWriteTokens = asNonNegativeInteger(tokenRecord.cache?.write);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function normalizeOpenCodeTokenUsage(
  tokens: unknown,
  maxTokens?: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const normalizedTokens = readOpenCodeTokens(tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const totalProcessedTokens =
    inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }

  const normalizedMaxTokens = asPositiveInteger(maxTokens);
  const usedTokens =
    normalizedMaxTokens !== undefined
      ? Math.min(totalProcessedTokens, normalizedMaxTokens)
      : totalProcessedTokens;

  return {
    usedTokens,
    totalProcessedTokens,
    ...(normalizedMaxTokens !== undefined ? { maxTokens: normalizedMaxTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

function buildOpenCodeTokenUsageKey(input: {
  readonly messageId: string;
  readonly tokens: OpenCodeAssistantTokens;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  const normalizedTokens = readOpenCodeTokens(input.tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  return [
    input.messageId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    asPositiveInteger(input.maxTokens) ?? "",
  ].join(":");
}

function buildOpenCodeModelContextLimitMap(inventory: OpenCodeModelInventory): Map<string, number> {
  const limits = new Map<string, number>();
  for (const provider of inventory.providerList.all) {
    for (const model of Object.values(provider.models)) {
      const contextLimit = asPositiveInteger(model.limit?.context);
      if (contextLimit !== undefined) {
        limits.set(`${provider.id}/${model.id}`, contextLimit);
      }
    }
  }
  return limits;
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

function isOpenCodeManagedProvider(provider: OpenCodeInventoryProvider) {
  const normalizedId = provider.id.trim().toLowerCase();
  const normalizedName = provider.name.trim().toLowerCase();
  const envVars = new Set((provider.env ?? []).map((value) => value.trim().toUpperCase()));

  return (
    envVars.has("OPENCODE_API_KEY") ||
    normalizedId === "opencode" ||
    normalizedId.startsWith("opencode-") ||
    normalizedName.startsWith("opencode")
  );
}

export function resolvePreferredOpenCodeModelProviders(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly credentialProviderIDs?: ReadonlyArray<string>;
}) {
  const { inventory } = input;
  const connected = new Set(inventory.providerList.connected);
  const connectedProviders = inventory.providerList.all.filter((provider) =>
    connected.has(provider.id),
  );
  if (connectedProviders.length === 0) {
    return [];
  }

  const credentialProviders = new Set(input.credentialProviderIDs ?? []);
  const authenticatedConnectedProviders = connectedProviders.filter((provider) =>
    credentialProviders.has(provider.id),
  );

  const consoleManagedProviders = new Set(inventory.consoleState?.consoleManagedProviders ?? []);
  const consoleManagedConnectedProviders = connectedProviders.filter((provider) =>
    consoleManagedProviders.has(provider.id),
  );

  const openCodeManagedConnectedProviders = connectedProviders.filter(isOpenCodeManagedProvider);

  const preferredProviderIDs = new Set(
    [
      ...authenticatedConnectedProviders,
      ...consoleManagedConnectedProviders,
      ...openCodeManagedConnectedProviders,
    ].map((provider) => provider.id),
  );
  if (preferredProviderIDs.size > 0) {
    return connectedProviders.filter((provider) => preferredProviderIDs.has(provider.id));
  }

  const nonEnvironmentConnectedProviders = connectedProviders.filter(
    (provider) => provider.source !== "env",
  );
  if (nonEnvironmentConnectedProviders.length > 0) {
    return nonEnvironmentConnectedProviders;
  }

  return connectedProviders;
}

function compareOpenCodeModelDescriptors(
  left: OpenCodeModelDescriptor,
  right: OpenCodeModelDescriptor,
) {
  const leftProvider =
    left.upstreamProviderName?.trim() || left.upstreamProviderId?.trim() || "\uffff";
  const rightProvider =
    right.upstreamProviderName?.trim() || right.upstreamProviderId?.trim() || "\uffff";
  return (
    leftProvider.localeCompare(rightProvider) ||
    left.name.localeCompare(right.name) ||
    left.slug.localeCompare(right.slug)
  );
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOpenCodeReasoningDescriptors(input: {
  readonly descriptors: ReadonlyArray<{
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly defaultReasoningEffort?: string | undefined;
}) {
  const descriptors = Array.from(
    new Map(
      input.descriptors
        .map((descriptor) => {
          const value = descriptor.value.trim();
          if (value.length === 0) {
            return null;
          }

          const label = trimNonEmptyString(descriptor.label);
          const description = trimNonEmptyString(descriptor.description);
          return [
            value,
            {
              value,
              ...(label ? { label } : {}),
              ...(description ? { description } : {}),
            },
          ] as const;
        })
        .filter((descriptor) => descriptor !== null),
    ).values(),
  );
  const defaultReasoningEffort = trimNonEmptyString(input.defaultReasoningEffort);

  return {
    descriptors,
    defaultReasoningEffort:
      defaultReasoningEffort &&
      descriptors.some((descriptor) => descriptor.value === defaultReasoningEffort)
        ? defaultReasoningEffort
        : undefined,
  };
}

function inferOpenCodeDefaultReasoningEffort(
  providerId: string,
  descriptors: ReadonlyArray<{ readonly value: string }>,
): string | undefined {
  const values = descriptors.map((descriptor) => descriptor.value);
  if (values.length === 1) {
    return values[0];
  }

  const normalizedProviderId = providerId.trim().toLowerCase();
  if (normalizedProviderId === "anthropic" || normalizedProviderId.startsWith("google")) {
    return values.includes("high") ? "high" : undefined;
  }
  if (normalizedProviderId === "openai" || normalizedProviderId === "opencode") {
    return values.includes("medium") ? "medium" : values.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function resolveOpenCodeModelReasoningSupport(
  model: OpenCodeInventoryProvider["models"][string] | undefined,
) {
  if (!model) {
    return {
      descriptors: [] as Array<{
        readonly value: string;
        readonly label?: string;
        readonly description?: string;
      }>,
      defaultReasoningEffort: undefined as string | undefined,
    };
  }

  const descriptors = Object.entries(model.variants ?? {}).flatMap(([variantKey, variant]) => {
    const value = trimNonEmptyString(variantKey);
    if (!value) {
      return [];
    }

    const label = trimNonEmptyString(variant.label);
    const description = trimNonEmptyString(variant.description);
    const hasReasoningValue = Boolean(
      trimNonEmptyString(variant.reasoningEffort) ?? trimNonEmptyString(variant.reasoning_effort),
    );
    return [
      {
        value,
        ...(label || !hasReasoningValue
          ? {
              label:
                label ??
                value.replace(/[-_/]+/g, " ").replace(/\b\w/gu, (char) => char.toUpperCase()),
            }
          : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
  if (descriptors.length > 0) {
    const defaultReasoningEffort =
      trimNonEmptyString(model.options?.reasoningEffort) ??
      trimNonEmptyString(model.options?.reasoning_effort);
    const defaultVariant =
      defaultReasoningEffort && descriptors.some((descriptor) => descriptor.value === defaultReasoningEffort)
        ? defaultReasoningEffort
        : defaultReasoningEffort
          ? Object.entries(model.variants ?? {}).find(([, variant]) => {
              return (
                trimNonEmptyString(variant.reasoningEffort) === defaultReasoningEffort ||
                trimNonEmptyString(variant.reasoning_effort) === defaultReasoningEffort
              );
            })?.[0]
          : undefined;
    return normalizeOpenCodeReasoningDescriptors({
      descriptors,
      defaultReasoningEffort: defaultVariant,
    });
  }

  if (model.capabilities?.reasoning !== true) {
    return {
      descriptors: [] as Array<{
        readonly value: string;
        readonly label?: string;
        readonly description?: string;
      }>,
      defaultReasoningEffort: undefined as string | undefined,
    };
  }

  return {
    descriptors: [] as Array<{
      readonly value: string;
      readonly label?: string;
      readonly description?: string;
    }>,
    defaultReasoningEffort: undefined as string | undefined,
  };
}

function numberToContextWindowValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
}

function resolveOpenCodeContextWindowSupport(
  model: OpenCodeInventoryProvider["models"][string] | undefined,
): {
  readonly contextWindowOptions: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly isDefault?: true;
  }>;
  readonly defaultContextWindow: string | undefined;
} {
  const context = numberToContextWindowValue(model?.limit?.context);
  if (!context) {
    return { contextWindowOptions: [], defaultContextWindow: undefined };
  }
  return {
    contextWindowOptions: [{ value: context, label: context.toUpperCase(), isDefault: true }],
    defaultContextWindow: context,
  };
}

function toOpenCodeModelDescriptor(input: {
  readonly slug: string;
  readonly name: string;
  readonly provider: Pick<OpenCodeInventoryProvider, "id" | "name">;
  readonly model?: OpenCodeInventoryProvider["models"][string];
  readonly cliModel?: Pick<
    OpenCodeCliModelDescriptor,
    | "supportedReasoningEfforts"
    | "defaultReasoningEffort"
    | "contextWindowOptions"
    | "defaultContextWindow"
  >;
}): OpenCodeModelDescriptor | null {
  const name = input.name.trim();
  if (name.length === 0) {
    return null;
  }

  const upstreamProviderName = input.provider.name.trim();
  const contextSupport =
    input.cliModel?.contextWindowOptions && input.cliModel.contextWindowOptions.length > 0
      ? {
          contextWindowOptions: input.cliModel.contextWindowOptions,
          defaultContextWindow: input.cliModel.defaultContextWindow,
        }
      : resolveOpenCodeContextWindowSupport(input.model);
  const reasoningSupport =
    input.cliModel && input.cliModel.supportedReasoningEfforts.length > 0
      ? {
          descriptors: input.cliModel.supportedReasoningEfforts,
          defaultReasoningEffort:
            input.cliModel.defaultReasoningEffort ??
            inferOpenCodeDefaultReasoningEffort(
              input.provider.id,
              input.cliModel.supportedReasoningEfforts,
            ),
        }
      : (() => {
          const resolved = resolveOpenCodeModelReasoningSupport(input.model);
          return {
            descriptors: resolved.descriptors,
            defaultReasoningEffort:
              resolved.defaultReasoningEffort ??
              inferOpenCodeDefaultReasoningEffort(input.provider.id, resolved.descriptors),
          };
        })();
  return {
    slug: input.slug,
    name,
    upstreamProviderId: input.provider.id,
    ...(upstreamProviderName.length > 0 ? { upstreamProviderName } : {}),
    ...(reasoningSupport.descriptors.length > 0
      ? { supportedReasoningEfforts: reasoningSupport.descriptors }
      : {}),
    ...(reasoningSupport.defaultReasoningEffort
      ? { defaultReasoningEffort: reasoningSupport.defaultReasoningEffort }
      : {}),
    ...(contextSupport.contextWindowOptions.length > 0
      ? {
          contextWindowOptions: contextSupport.contextWindowOptions,
          ...(contextSupport.defaultContextWindow
            ? { defaultContextWindow: contextSupport.defaultContextWindow }
            : {}),
        }
      : {}),
  };
}

export function flattenOpenCodeModels(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly credentialProviderIDs?: ReadonlyArray<string>;
  readonly freeOnlyProviderID?: string;
}): ProviderListModelsResult["models"] {
  return resolvePreferredOpenCodeModelProviders(input)
    .flatMap((provider) =>
      Object.values(provider.models).flatMap((model) => {
        if (
          input.freeOnlyProviderID &&
          provider.id === input.freeOnlyProviderID &&
          model.isFree !== true
        ) {
          return [];
        }
        const descriptor = toOpenCodeModelDescriptor({
          slug: `${provider.id}/${model.id}`,
          name: model.name,
          provider,
          model,
        });
        return descriptor ? [descriptor] : [];
      }),
    )
    .toSorted(compareOpenCodeModelDescriptors);
}

function fallbackOpenCodeProviderName(providerId: string): string {
  return providerId
    .split(/[-_/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function mergeOpenCodeCliModelDescriptors(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly models: ReadonlyArray<OpenCodeModelDescriptor>;
  readonly cliModels: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly freeOnlyProviderID?: string;
}): ProviderListModelsResult["models"] {
  const providerById = new Map(
    input.inventory.providerList.all.map((provider) => [provider.id, provider] as const),
  );
  const mergedBySlug = new Map(input.models.map((model) => [model.slug, model] as const));

  for (const cliModel of input.cliModels) {
    if (
      input.freeOnlyProviderID &&
      cliModel.providerID === input.freeOnlyProviderID &&
      cliModel.isFree !== true
    ) {
      continue;
    }
    if (mergedBySlug.has(cliModel.slug)) {
      continue;
    }
    const provider =
      providerById.get(cliModel.providerID) ??
      ({
        id: cliModel.providerID,
        name: fallbackOpenCodeProviderName(cliModel.providerID) || cliModel.providerID,
      } satisfies Pick<OpenCodeInventoryProvider, "id" | "name">);
    const descriptor = toOpenCodeModelDescriptor({
      slug: cliModel.slug,
      name: cliModel.name,
      provider,
      ...(providerById.get(cliModel.providerID)?.models[cliModel.modelID]
        ? { model: providerById.get(cliModel.providerID)!.models[cliModel.modelID] }
        : {}),
      cliModel,
    });
    if (descriptor) {
      mergedBySlug.set(descriptor.slug, descriptor);
    }
  }

  return [...mergedBySlug.values()].toSorted(compareOpenCodeModelDescriptors);
}

function flattenOpenCodeAgents(agents: ReadonlyArray<Agent>): ProviderListAgentsResult["agents"] {
  return agents
    .filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
    .map((agent) => {
      const displayName =
        "displayName" in agent &&
        typeof agent.displayName === "string" &&
        agent.displayName.trim().length > 0
          ? agent.displayName.trim()
          : agent.name
              .split(/[-_/]+/)
              .filter((segment) => segment.length > 0)
              .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
              .join(" ");
      return {
        name: agent.name,
        displayName,
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.modelID}` } : {}),
      };
    })
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

function buildOpenCodeThreadSnapshot(input: {
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
        input: Omit<Parameters<typeof buildProviderEventBase>[0], "provider" | "runtimeEventSource">,
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
        const previousText = context.emittedTextByPartId.get(part.id);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(part.id, latestText);
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
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
          !context.completedAssistantPartIds.has(part.id)
        ) {
          context.completedAssistantPartIds.add(part.id);
          const proposedPlanMarkdown =
            context.activeInteractionMode === "plan"
              ? extractProposedPlanMarkdown(latestText)
              : undefined;
          if (proposedPlanMarkdown && turnId) {
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.id,
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
              itemId: part.id,
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

      const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
        context: OpenCodeSessionContext,
        event: OpenCodeSubscribedEvent,
      ) {
        if (!shouldHandleSubscribedEvent(context, event)) {
          return;
        }

        const turnId = context.activeTurnId;
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
            const streamKind = resolveTextStreamKind(resolvedPart);
            const previousText =
              context.emittedTextByPartId.get(event.properties.partID) ??
              textFromPart(resolvedPart) ??
              "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
            if (deltaToEmit.length === 0) {
              break;
            }
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
              const totalCostUsd = context.latestTurnCostUsd;
              clearActiveTurnState(context);
              updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "completed",
                  ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
                },
              });
            }
            break;
          }

          case "session.idle": {
            if (turnId) {
              const totalCostUsd = context.latestTurnCostUsd;
              clearActiveTurnState(context);
              updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "completed",
                  ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
                },
              });
            }
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

      const replayOpenCodeMessageSnapshots = Effect.fn("replayOpenCodeMessageSnapshots")(
        function* (
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
        },
      );

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
          const binaryPath =
            providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
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
                  (yield* runOpenCodeSdk("session.create", () =>
                    client.session.create({
                      title: `DP Code ${input.threadId}`,
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
                    }),
                  ).pipe(
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
          (context.session.model
            ? { provider, model: context.session.model }
            : undefined);
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
        context.activeInteractionMode = input.interactionMode === "plan" ? "plan" : "default";
        // Always pin DP Code's interaction mode to OpenCode's primary agent.
        // Otherwise a user config with default agent=plan can trap default turns in plan mode.
        context.activeAgent =
          agent ??
          (input.interactionMode === "plan"
            ? adapterConfig.planAgent
            : adapterConfig.defaultAgent);
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

        const baselineMessageIds =
          provider === "kilo"
            ? yield* rememberCurrentMessageSnapshots(context).pipe(
                Effect.catchCause(() => Effect.succeed(new Set<string>())),
              )
            : new Set<string>();

        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync({
            sessionID: context.openCodeSessionId,
            model: parsedModel,
            ...(context.activeAgent ? { agent: context.activeAgent } : {}),
            ...(context.activeVariant ? { variant: context.activeVariant } : {}),
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
          }),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.tapError((requestError) =>
            Effect.gen(function* () {
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: modelSelection?.model ?? context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: input.threadId, turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
            }),
          ),
        );

        if (provider === "kilo") {
          yield* startKiloTurnSnapshotWatchdog(context, turnId, baselineMessageIds);
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
          const binaryPath =
            providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
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
        return withDiscoveryInventory({ binaryPath }, ({ inventory, credentialProviderIDs }) =>
          Effect.gen(function* () {
            const freeOnlyProviderID = adapterConfig.provider === "kilo" ? "kilo" : undefined;
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

export function makeKiloAdapterLive(
  options?: Omit<OpenCodeAdapterLiveOptions, "adapterConfig">,
) {
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
