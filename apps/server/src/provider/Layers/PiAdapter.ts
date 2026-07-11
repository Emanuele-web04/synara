import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

import type {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  AgentSession as PiAgentSession,
  AgentSessionEvent,
  CreateAgentSessionRuntimeFactory,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { resetApiProviders } from "@earendil-works/pi-ai";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
} from "@synara/contracts";
import { getModelSelectionStringOptionValue } from "@synara/shared/model";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveProviderSessionInstanceId } from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { classifyPiTurnFailure } from "../piTurnFailure.ts";
import {
  buildProviderProcessEnv,
  MODEL_PROVIDER_API_KEY_ENV_MAPPINGS,
  providerIsolatedHomePath,
} from "../providerProcessEnv.ts";
import { clampUsagePercent, nonNegativeFiniteNumber, positiveFiniteNumber } from "../tokenUsage.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "pi" as const;
export const resolvePiStartInstanceId = resolveProviderSessionInstanceId;
const PI_DOWNSTREAM_ENV_BACKED_PROVIDER_IDS = new Set<string>([
  ...MODEL_PROVIDER_API_KEY_ENV_MAPPINGS.map(({ provider }) => provider),
  "amazon-bedrock",
]);
const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "medium";
const PI_THINKING_OPTIONS: ReadonlyArray<{
  readonly value: ThinkingLevel;
  readonly label: string;
  readonly description: string;
  readonly isDefault?: true;
}> = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning" },
];
const PI_DEFAULT_SUPPORTED_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
]);

type PiModelRegistry = Pick<ModelRegistry, "find" | "getAll" | "getAvailable">;
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
type PiModelRegistrySdk = Pick<PiCodingAgentModule, "AuthStorage" | "ModelRegistry"> &
  Partial<Pick<PiCodingAgentModule, "getShellConfig">>;
type PiAgentRuntime = Awaited<ReturnType<PiCodingAgentModule["createAgentSessionRuntime"]>>;
interface PiModelRegistryContext {
  readonly authStorage: AuthStorage;
  readonly registry: ModelRegistry;
}

let piCodingAgentModulePromise: Promise<PiCodingAgentModule> | undefined;

interface PiSessionContext {
  runtime: PiAgentRuntime;
  modelRegistry: PiModelRegistry;
  session: ProviderSession;
  turns: PiStoredTurn[];
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, PiTrackedToolCall>;
  pendingUserInputs: Map<ApprovalRequestId, PiPendingUserInput>;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
  extensionsEnabled: boolean;
}

export function resolvePiExtensionMode(input: {
  readonly isolatedAccount: boolean;
  readonly hasExtensionEnabledDefault: boolean;
  readonly hasIsolatedMode: boolean;
}): { readonly noExtensions: boolean } {
  if (input.isolatedAccount && input.hasExtensionEnabledDefault) {
    throw new Error(
      "Stop extension-enabled default Pi sessions before starting an isolated Pi account.",
    );
  }
  return { noExtensions: input.isolatedAccount || input.hasIsolatedMode };
}

export function makePiExtensionModeCoordinator(
  getActiveModes: () => {
    readonly hasExtensionEnabledDefault: boolean;
    readonly hasIsolatedMode: boolean;
  },
) {
  let pendingExtensionEnabledOperations = 0;
  let pendingIsolatedModeOperations = 0;
  return {
    reserve(
      isolatedAccount: boolean,
      activeOverride?: {
        readonly hasExtensionEnabledDefault: boolean;
        readonly hasIsolatedMode: boolean;
      },
    ) {
      const active = activeOverride ?? getActiveModes();
      const hasExtensionEnabledDefault =
        pendingExtensionEnabledOperations > 0 || active.hasExtensionEnabledDefault;
      const hasIsolatedMode = pendingIsolatedModeOperations > 0 || active.hasIsolatedMode;
      if (!isolatedAccount && hasExtensionEnabledDefault && hasIsolatedMode) {
        throw new Error(
          "Wait for the Pi account-mode transition to finish before starting default work.",
        );
      }
      const mode = resolvePiExtensionMode({
        isolatedAccount,
        hasExtensionEnabledDefault,
        hasIsolatedMode,
      });
      if (mode.noExtensions) pendingIsolatedModeOperations += 1;
      else pendingExtensionEnabledOperations += 1;
      let released = false;
      return {
        noExtensions: mode.noExtensions,
        release: () => {
          if (released) return;
          released = true;
          if (mode.noExtensions) pendingIsolatedModeOperations -= 1;
          else pendingExtensionEnabledOperations -= 1;
        },
      };
    },
  };
}

interface PiStoredTurn {
  readonly id: TurnId;
  readonly items: unknown[];
  leafId?: string | null;
}

interface PiTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
}

interface PiPendingUserInput {
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

export interface PiUserInputOptionMapping {
  readonly value: string;
  readonly option: UserInputQuestion["options"][number];
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPiThinkingLevel(value: string | null | undefined): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function normalizePiThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
  return isPiThinkingLevel(value) ? value : undefined;
}

// Loads the Pi SDK only when the Pi provider is actually used. The SDK brings in
// a native clipboard module, so importing it during Synara startup can bloat the
// desktop backend before any Pi session exists.
async function loadPiCodingAgentModule(): Promise<PiCodingAgentModule> {
  piCodingAgentModulePromise ??= import("@earendil-works/pi-coding-agent");
  return piCodingAgentModulePromise;
}

function getLocalSupportedThinkingLevels(
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): Set<ThinkingLevel> {
  if (!model.reasoning) {
    return new Set();
  }

  const thinkingLevelMap = model.thinkingLevelMap;
  if (thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0) {
    return new Set(
      PI_THINKING_OPTIONS.filter((option) => {
        const mapped = thinkingLevelMap[option.value as keyof typeof thinkingLevelMap];
        if (mapped === null) {
          return false;
        }
        return mapped !== undefined || PI_DEFAULT_SUPPORTED_THINKING_LEVELS.has(option.value);
      }).map((option) => option.value),
    );
  }

  return new Set(PI_DEFAULT_SUPPORTED_THINKING_LEVELS);
}

// Mirrors Pi SDK clamping so model discovery does not advertise levels that will be ignored.
export function getPiSupportedThinkingOptions(
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): ReadonlyArray<(typeof PI_THINKING_OPTIONS)[number]> {
  if (!model.reasoning) {
    return [];
  }
  const supportedLevels = getLocalSupportedThinkingLevels(model);
  return PI_THINKING_OPTIONS.filter((option) => supportedLevels.has(option.value));
}

function parseModelReference(
  modelId: string | null | undefined,
): { readonly provider?: string; readonly id: string } | undefined {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    const [provider, ...rest] = trimmed.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (trimmed.includes(":")) {
    const [provider, ...rest] = trimmed.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: trimmed };
}

function createProviderModelFallback(
  registry: PiModelRegistry,
  parsed: { readonly provider: string; readonly id: string },
): Model<Api> | undefined {
  const providerDefault = registry.getAll().find((model) => model.provider === parsed.provider);
  if (!providerDefault) {
    return undefined;
  }
  return {
    id: parsed.id,
    name: parsed.id,
    api: providerDefault.api,
    provider: parsed.provider,
    baseUrl: providerDefault.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(providerDefault.compat ? { compat: providerDefault.compat } : {}),
  };
}

function findModelInRegistry(
  registry: PiModelRegistry,
  modelId: string | null | undefined,
): Model<Api> | undefined {
  const parsed = parseModelReference(modelId);
  if (!parsed) {
    return undefined;
  }
  if (parsed.provider) {
    return (
      registry.find(parsed.provider, parsed.id) ??
      createProviderModelFallback(registry, { provider: parsed.provider, id: parsed.id })
    );
  }
  return registry
    .getAll()
    .find((model) => model.id === parsed.id || `${model.provider}/${model.id}` === parsed.id);
}

function extractResumeSessionFile(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function getSessionFile(session: PiAgentSession): string | undefined {
  return session.sessionFile ?? session.sessionManager.getSessionFile();
}

function makeSessionSnapshot(context: PiSessionContext): ProviderSession {
  const resumeCursor = getSessionFile(context.runtime.session);
  return {
    provider: PROVIDER,
    ...(context.session.providerInstanceId !== undefined
      ? { providerInstanceId: context.session.providerInstanceId }
      : {}),
    status: context.stopped ? "closed" : context.activeTurnId ? "running" : "ready",
    runtimeMode: context.session.runtimeMode,
    threadId: context.session.threadId,
    createdAt: context.session.createdAt,
    updatedAt: new Date().toISOString(),
    ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
    ...(context.session.model ? { model: context.session.model } : {}),
    ...(resumeCursor ? { resumeCursor } : {}),
    ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
    ...(context.session.lastError ? { lastError: context.session.lastError } : {}),
  };
}

function normalizeTokenUsage(
  stats: ReturnType<PiAgentSession["getSessionStats"]>,
  contextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalProcessedTokens = stats.tokens.total;
  const contextUsage = stats.contextUsage;
  const contextUsageWindowValue = positiveFiniteNumber(contextUsage?.contextWindow);
  const contextUsageWindow =
    contextUsageWindowValue !== undefined ? Math.floor(contextUsageWindowValue) : undefined;
  const fallbackWindowValue = positiveFiniteNumber(contextWindow);
  const fallbackWindow =
    fallbackWindowValue !== undefined ? Math.floor(fallbackWindowValue) : undefined;
  const maxTokens = contextUsageWindow ?? fallbackWindow;
  const contextUsageTokenValue = nonNegativeFiniteNumber(contextUsage?.tokens);
  const contextUsageTokens =
    contextUsageTokenValue !== undefined ? Math.round(contextUsageTokenValue) : undefined;
  const usedPercent = clampUsagePercent(contextUsage?.percent);
  const usedTokensFromPercent =
    contextUsageTokens === undefined && usedPercent !== undefined && maxTokens !== undefined
      ? Math.round((usedPercent / 100) * maxTokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    usedTokensFromPercent ??
    (contextUsage
      ? 0
      : maxTokens !== undefined
        ? Math.min(totalProcessedTokens, maxTokens)
        : totalProcessedTokens);
  if (
    usedTokens <= 0 &&
    inputTokens <= 0 &&
    cachedInputTokens <= 0 &&
    outputTokens <= 0 &&
    maxTokens === undefined &&
    usedPercent === undefined
  ) {
    return undefined;
  }
  return {
    usedTokens,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
  };
}

function isPiReloadCommand(text: string): boolean {
  return /^\/reload(?:\s|$)/iu.test(text.trim());
}

function classifyPiRuntimeError(
  message: string,
): "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("timeout") ||
    normalized.includes("econn") ||
    normalized.includes("fetch failed")
  ) {
    return "transport_error";
  }
  if (
    normalized.includes("api key") ||
    normalized.includes("auth") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("permission")
  ) {
    return "permission_error";
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("validation") ||
    normalized.includes("not available")
  ) {
    return "validation_error";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("overloaded") ||
    normalized.includes("provider")
  ) {
    return "provider_error";
  }
  return "unknown";
}

function runtimeErrorDetail(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function toolRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function textFromToolResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  const record = toolRecord(result);
  if (!record) {
    return undefined;
  }
  const directText = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (directText) {
    return directText;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content.flatMap((block) => {
    const blockRecord = toolRecord(block);
    return blockRecord?.type === "text" && typeof blockRecord.text === "string"
      ? [blockRecord.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function toolExitCode(result: unknown): number | null | undefined {
  const record = toolRecord(result);
  if (!record) return undefined;
  const exitCode = record.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  const code = record.code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  return null;
}

function toolRawOutput(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  const text = textFromToolResult(result);
  const exitCode = toolExitCode(result);
  if (typeof result === "string") {
    return { stdout: result, content: result };
  }
  if (result === null) {
    return {};
  }
  const record = toolRecord(result);
  if (!record) {
    return text ? { stdout: text, content: text } : undefined;
  }
  return {
    ...record,
    ...(text ? { stdout: text, content: text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function toolPath(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["path", "filePath", "file", "relativePath"]);
}

function toolCommand(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["command", "cmd"]);
}

function toolSearchQuery(toolName: string, args: unknown): string | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (toolName === "grep" || toolName === "find") {
    return firstStringValue(record, ["pattern", "query"]);
  }
  return firstStringValue(record, ["query", "pattern"]);
}

function toolEditEntries(args: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (Array.isArray(record.edits)) {
    return record.edits.flatMap((edit) => {
      const editRecord = toolRecord(edit);
      return editRecord ? [editRecord] : [];
    });
  }
  const oldText = firstStringValue(record, ["oldText", "old_string", "oldString"]);
  const newText = firstStringValue(record, ["newText", "new_string", "newString"]);
  if (oldText !== undefined || newText !== undefined) {
    return [
      {
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      },
    ];
  }
  return undefined;
}

function toolItemType(toolName: string): PiTrackedToolCall["itemType"] {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    case "grep":
    case "find":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function toolTitle(toolName: string, args: unknown): string {
  const command = toolName === "bash" ? toolCommand(args) : undefined;
  if (command) return command;
  const filePath = toolPath(args);
  if (
    filePath &&
    (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls")
  ) {
    return `${toolName} ${filePath}`;
  }
  const query = toolSearchQuery(toolName, args);
  if (query && (toolName === "find" || toolName === "grep")) {
    return `${toolName} ${query}`;
  }
  return toolName;
}

function toolLifecycleData(input: {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  const { toolCallId, toolName, args } = input;
  const rawOutput = toolRawOutput(input.result ?? input.partialResult);
  const path = toolPath(args);
  const query = toolSearchQuery(toolName, args);
  const command = toolCommand(args);
  const edits = toolEditEntries(args);
  const content = toolRecord(args)?.content;
  const outputDetails = toolRecord(rawOutput?.details);
  const unifiedDiff = firstStringValue(outputDetails, ["diff"]);
  const base: Record<string, unknown> = {
    toolCallId,
    callId: toolCallId,
    toolName,
    name: toolName,
    tool: toolName,
    kind: toolName,
    args,
    input: args,
    rawInput: args,
    ...(rawOutput ? { rawOutput } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };

  switch (toolName) {
    case "bash":
      return {
        ...base,
        kind: "execute",
        ...(command ? { command } : {}),
        ...(rawOutput?.exitCode !== undefined ? { exitCode: rawOutput.exitCode } : {}),
      };
    case "read":
      return {
        ...base,
        kind: "read",
        ...(path
          ? {
              path,
              filePath: path,
              files: [{ path }],
              commandActions: [{ type: "read", name: "read", path }],
            }
          : {}),
      };
    case "edit":
      return {
        ...base,
        kind: "edit",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(edits ? { edits: edits.map((edit) => ({ ...edit, ...(path ? { path } : {}) })) } : {}),
        ...(unifiedDiff ? { unifiedDiff } : {}),
      };
    case "write":
      return {
        ...base,
        kind: "write",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(typeof content === "string" ? { content } : {}),
      };
    case "find":
      return {
        ...base,
        kind: "search",
        searchKind: "find",
        ...(query ? { query } : {}),
        ...(path ? { path } : {}),
        ...(query || path
          ? { commandActions: [{ type: "search", name: "find", query, path }] }
          : {}),
      };
    case "grep":
      return {
        ...base,
        kind: "search",
        searchKind: "grep",
        ...(query ? { query } : {}),
        ...(path ? { path } : {}),
        ...(query || path
          ? { commandActions: [{ type: "search", name: "grep", query, path }] }
          : {}),
      };
    case "ls":
      return {
        ...base,
        kind: "listFiles",
        ...(path
          ? {
              path,
              query: path,
              commandActions: [{ type: "listFiles", name: "ls", path }],
            }
          : {}),
      };
    default:
      return base;
  }
}

function mapMessageHistory(session: PiAgentSession): unknown[] {
  const items: unknown[] = [];
  const pendingTools = new Map<string, { toolName: string; args: unknown }>();
  for (const message of session.messages) {
    if (message.role === "user") {
      const text = textFromContent(message.content);
      if (text) items.push({ type: "user_message", text });
      continue;
    }
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          items.push({ type: "assistant_message", text: content.text });
          continue;
        }
        if (content.type === "thinking" && content.thinking) {
          items.push({ type: "reasoning", text: content.thinking });
          continue;
        }
        if (content.type === "toolCall") {
          pendingTools.set(content.id, { toolName: content.name, args: content.arguments });
          items.push({
            type: "tool_call",
            status: "started",
            callId: content.id,
            toolName: content.name,
            itemType: toolItemType(content.name),
            title: toolTitle(content.name, content.arguments),
            args: content.arguments,
            data: toolLifecycleData({
              toolCallId: content.id,
              toolName: content.name,
              args: content.arguments,
            }),
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const pending = pendingTools.get(message.toolCallId);
      pendingTools.delete(message.toolCallId);
      const toolName = pending?.toolName ?? message.toolName;
      const args = pending?.args;
      const result = { content: message.content };
      items.push({
        type: "tool_call",
        status: message.isError ? "failed" : "completed",
        callId: message.toolCallId,
        toolName,
        itemType: toolItemType(toolName),
        title: toolTitle(toolName, args),
        output: textFromContent(message.content),
        isError: message.isError,
        data: toolLifecycleData({
          toolCallId: message.toolCallId,
          toolName,
          args,
          result,
          isError: message.isError,
        }),
      });
    }
  }
  return items;
}

export function makePiStoragePaths(input: {
  readonly agentDir?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly stateDir: string;
  readonly homeDir: string;
  readonly sdkAgentDir: string;
}): { readonly agentDir: string; readonly sessionDir?: string } {
  const boundary =
    input.environment !== undefined ||
    (input.instanceId !== undefined && input.instanceId !== PROVIDER);
  const pathApi = process.platform === "win32" ? path.win32 : path.posix;
  const selectedAbsolutePath = (value: string | undefined) => {
    const selected = trimToUndefined(value);
    return selected && pathApi.isAbsolute(selected) ? selected : undefined;
  };
  const selectedEnvironmentValue = (name: string) =>
    Object.entries(input.environment ?? {}).find(
      ([candidate]) => candidate.toUpperCase() === name,
    )?.[1];
  const selectedHome = selectedAbsolutePath(
    selectedEnvironmentValue("HOME") ?? selectedEnvironmentValue("USERPROFILE"),
  );
  const isolatedHome = providerIsolatedHomePath({
    driver: PROVIDER,
    instanceId: input.instanceId,
    homeDir: input.homeDir,
    isolationRootDir: input.stateDir,
  });
  const expansionHome = boundary ? (selectedHome ?? isolatedHome) : (selectedHome ?? input.homeDir);
  const expandHome = (value: string) =>
    value === "~" || value.startsWith("~/")
      ? path.join(expansionHome, value.slice(value === "~" ? 1 : 2))
      : value;
  const rawConfiguredAgentDir = trimToUndefined(input.agentDir);
  const configuredAgentDir = rawConfiguredAgentDir
    ? rawConfiguredAgentDir === "~" || rawConfiguredAgentDir.startsWith("~/")
      ? expandHome(rawConfiguredAgentDir)
      : !boundary || pathApi.isAbsolute(rawConfiguredAgentDir)
        ? rawConfiguredAgentDir
        : undefined
    : undefined;
  const selectedAgentDir = selectedAbsolutePath(selectedEnvironmentValue("PI_CODING_AGENT_DIR"));
  if (!boundary && !configuredAgentDir && !selectedAgentDir) {
    return { agentDir: input.sdkAgentDir };
  }
  const agentDir =
    configuredAgentDir ??
    selectedAgentDir ??
    path.join(selectedHome ?? isolatedHome, ".pi", "agent");
  const selectedSessionDir = selectedAbsolutePath(
    selectedEnvironmentValue("PI_CODING_AGENT_SESSION_DIR"),
  );
  return {
    agentDir,
    sessionDir: expandHome(selectedSessionDir ?? path.join(agentDir, "sessions")),
  };
}

function readPiRuntimeApiKeyOverrides(
  environment: Readonly<NodeJS.ProcessEnv> | undefined,
): ReadonlyArray<readonly [provider: string, envKey: string, value: string]> {
  if (!environment) {
    return [];
  }
  return MODEL_PROVIDER_API_KEY_ENV_MAPPINGS.flatMap(({ provider, envKeys }) => {
    const envKey = envKeys.find((key) => trimToUndefined(environment[key]) !== undefined);
    if (!envKey) {
      return [];
    }
    const value = trimToUndefined(environment[envKey]);
    return value ? [[provider, envKey, value] as const] : [];
  });
}

export function applyPiRuntimeApiKeysFromEnvironment(
  authStorage: Pick<AuthStorage, "setRuntimeApiKey">,
  environment: Readonly<NodeJS.ProcessEnv> | undefined,
): void {
  for (const [provider, _envKey, value] of readPiRuntimeApiKeyOverrides(environment)) {
    authStorage.setRuntimeApiKey(provider, value);
  }
}

const PI_CONFIG_COMMAND_INHERITED_ENV_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

interface PiInstanceConfigResolver {
  readonly selectedValue: (name: string) => string | undefined;
  readonly resolve: (config: string, cacheCommand?: boolean) => string | undefined;
  readonly resolveOrThrow: (config: string, description: string) => string;
  readonly resolveHeadersOrThrow: (
    headers: Readonly<Record<string, string>> | undefined,
    description: string,
  ) => Record<string, string> | undefined;
}

type PiInstanceAuthResolution =
  | { readonly status: "resolved"; readonly apiKey: string }
  | { readonly status: "missing" }
  | { readonly status: "failedStoredAuth" };

interface PiInstanceResolver extends PiInstanceConfigResolver {
  readonly resolveAuth: (provider: string) => Promise<PiInstanceAuthResolution>;
}

interface PiShellConfig {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
}

interface PiAuthStorageInternals {
  readonly refreshOAuthTokenWithLock?: (
    provider: string,
  ) => Promise<{ readonly apiKey: string; readonly newCredentials: unknown } | null>;
  readonly recordError?: (error: unknown) => void;
}

interface PiProviderRequestConfig {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authHeader?: boolean;
}

interface PiModelRegistryInternals {
  readonly providerRequestConfigs?: ReadonlyMap<string, PiProviderRequestConfig>;
  readonly modelRequestHeaders?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  models?: Array<Model<Api>>;
}

function hasHeader(headers: Readonly<Record<string, unknown>> | undefined, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers ?? {}).some((header) => header.toLowerCase() === normalized);
}

function buildPiSelectedEnvironment(
  environment: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly stateDir: string; readonly homeDir: string },
): NodeJS.ProcessEnv {
  return buildProviderProcessEnv({
    driver: PROVIDER,
    env: {},
    environment,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(paths ? { isolationRootDir: paths.stateDir, homeDir: paths.homeDir } : {}),
  });
}

function isPiConfigCommandEnvironmentKey(name: string): boolean {
  const normalizedName = name.toUpperCase();
  return (
    PI_CONFIG_COMMAND_INHERITED_ENV_KEYS.has(normalizedName) ||
    normalizedName.startsWith("LC_") ||
    normalizedName.startsWith("XDG_")
  );
}

function makePiInstanceConfigResolver(
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  getShellConfig: (() => PiShellConfig) | undefined,
): PiInstanceConfigResolver {
  const inheritedCommandEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => isPiConfigCommandEnvironmentKey(name)),
  );
  const commandEnvironment = buildProviderProcessEnv({
    driver: PROVIDER,
    env: inheritedCommandEnvironment,
    environment: Object.fromEntries(
      Object.entries(selectedEnvironment).filter((entry): entry is [string, string] => {
        return entry[1] !== undefined;
      }),
    ),
  });
  const commandResultCache = new Map<string, string | undefined>();
  const selectedValue = (name: string): string | undefined => {
    const normalizedName = process.platform === "win32" ? name.toUpperCase() : name;
    return selectedEnvironment[normalizedName];
  };
  const executeWithDefaultShell = (command: string): string | undefined => {
    try {
      const output = execSync(command, {
        encoding: "utf8",
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      });
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const executeCommand = (config: string): string | undefined => {
    const command = config.slice(1);
    if (process.platform !== "win32" || !getShellConfig) {
      return executeWithDefaultShell(command);
    }
    try {
      const { shell, args } = getShellConfig();
      const result = spawnSync(shell, [...args, command], {
        encoding: "utf8",
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.error) {
        return (result.error as NodeJS.ErrnoException).code === "ENOENT"
          ? executeWithDefaultShell(command)
          : undefined;
      }
      if (result.status !== 0) {
        return undefined;
      }
      return result.stdout.trim() || undefined;
    } catch {
      return executeWithDefaultShell(command);
    }
  };
  const resolve = (config: string, cacheCommand = false): string | undefined => {
    if (!config.startsWith("!")) {
      return selectedValue(config) || config;
    }
    if (!cacheCommand) {
      return executeCommand(config);
    }
    if (!commandResultCache.has(config)) {
      commandResultCache.set(config, executeCommand(config));
    }
    return commandResultCache.get(config);
  };
  const resolveOrThrow = (config: string, description: string): string => {
    const resolved = resolve(config);
    if (resolved !== undefined) {
      return resolved;
    }
    if (config.startsWith("!")) {
      throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
    }
    throw new Error(`Failed to resolve ${description}`);
  };
  const resolveHeadersOrThrow = (
    headers: Readonly<Record<string, string>> | undefined,
    description: string,
  ): Record<string, string> | undefined => {
    if (!headers) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        resolveOrThrow(value, `${description} header "${name}"`),
      ]),
    );
  };
  return { selectedValue, resolve, resolveOrThrow, resolveHeadersOrThrow };
}

export function isolatePiAuthStorageFromAmbientEnvironment(
  authStorage: AuthStorage,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  getShellConfig?: () => PiShellConfig,
): PiInstanceResolver {
  const configResolver = makePiInstanceConfigResolver(selectedEnvironment, getShellConfig);
  const runtimeOverrides = new Map<string, string>();
  const setRuntimeApiKey = authStorage.setRuntimeApiKey.bind(authStorage);
  const removeRuntimeApiKey = authStorage.removeRuntimeApiKey?.bind(authStorage);
  const hasStoredCredential = authStorage.has.bind(authStorage);
  const getStoredCredential = authStorage.get.bind(authStorage);
  const getOAuthProviders = authStorage.getOAuthProviders.bind(authStorage);
  const internals = authStorage as unknown as PiAuthStorageInternals;

  authStorage.setRuntimeApiKey = (provider, apiKey) => {
    runtimeOverrides.set(provider, apiKey);
    setRuntimeApiKey(provider, apiKey);
  };
  authStorage.removeRuntimeApiKey = (provider) => {
    runtimeOverrides.delete(provider);
    removeRuntimeApiKey?.(provider);
  };
  const resolveAuth = async (provider: string): Promise<PiInstanceAuthResolution> => {
    const runtimeOverride = runtimeOverrides.get(provider);
    if (runtimeOverride) {
      return { status: "resolved", apiKey: runtimeOverride };
    }

    const credential = getStoredCredential(provider);
    if (credential?.type === "api_key") {
      const apiKey = configResolver.resolve(credential.key, true);
      return apiKey ? { status: "resolved", apiKey } : { status: "failedStoredAuth" };
    }
    if (credential?.type !== "oauth") {
      return { status: "missing" };
    }

    const oauthProvider = getOAuthProviders().find((candidate) => candidate.id === provider);
    if (!oauthProvider) {
      return { status: "failedStoredAuth" };
    }
    if (Date.now() < credential.expires) {
      const apiKey = oauthProvider.getApiKey(credential);
      return apiKey ? { status: "resolved", apiKey } : { status: "failedStoredAuth" };
    }

    try {
      const refreshed = await internals.refreshOAuthTokenWithLock?.call(authStorage, provider);
      // A null refresh is terminal for this isolated lookup. Calling Pi's original
      // resolver here would continue into the ambient process.env fallback.
      return refreshed?.apiKey
        ? { status: "resolved", apiKey: refreshed.apiKey }
        : { status: "failedStoredAuth" };
    } catch (error) {
      internals.recordError?.call(authStorage, error);
      authStorage.reload();
      const updatedCredential = getStoredCredential(provider);
      if (updatedCredential?.type === "oauth" && Date.now() < updatedCredential.expires) {
        const apiKey = oauthProvider.getApiKey(updatedCredential);
        return apiKey ? { status: "resolved", apiKey } : { status: "failedStoredAuth" };
      }
      return { status: "failedStoredAuth" };
    }
  };
  authStorage.getApiKey = async (provider) => {
    const resolution = await resolveAuth(provider);
    return resolution.status === "resolved" ? resolution.apiKey : undefined;
  };
  authStorage.hasAuth = (provider) =>
    runtimeOverrides.has(provider) || hasStoredCredential(provider);
  authStorage.getAuthStatus = (provider) => {
    if (hasStoredCredential(provider)) {
      return { configured: true, source: "stored" };
    }
    if (runtimeOverrides.has(provider)) {
      return { configured: false, source: "runtime", label: "--api-key" };
    }
    return { configured: false };
  };

  return { ...configResolver, resolveAuth };
}

function isolatePiModelRegistryFromAmbientEnvironment(
  registry: ModelRegistry,
  authStorage: AuthStorage,
  configResolver: PiInstanceResolver,
): void {
  const internals = registry as unknown as PiModelRegistryInternals;
  const providerRequestConfig = (provider: string) =>
    internals.providerRequestConfigs?.get(provider);
  const modelRequestHeaders = (provider: string, modelId: string) =>
    internals.modelRequestHeaders?.get(`${provider}:${modelId}`);

  registry.getApiKeyAndHeaders = async (model) => {
    try {
      if (model.provider.startsWith("cloudflare-")) {
        model.baseUrl = model.baseUrl.replace(
          /(?:\$\{?|\{)(CLOUDFLARE_(?:ACCOUNT|GATEWAY)_ID)\}?/gu,
          (_match, name: string) => configResolver.selectedValue(name) ?? _match,
        );
        if (/(?:\$\{?|\{)CLOUDFLARE_(?:ACCOUNT|GATEWAY)_ID\}?/u.test(model.baseUrl)) {
          return {
            ok: false,
            error: `Missing isolated Cloudflare routing value for ${model.provider}`,
          };
        }
      }
      if (model.provider === "amazon-bedrock") {
        return {
          ok: false,
          error:
            "Amazon Bedrock is disabled for isolated Pi accounts because the SDK falls back to the ambient AWS credential chain.",
        };
      }
      if (model.provider === "azure-openai-responses") {
        return {
          ok: false,
          error:
            "Azure OpenAI is disabled for isolated Pi accounts because the SDK reads process-level Azure routing.",
        };
      }
      const providerConfig = providerRequestConfig(model.provider);
      const authResolution = await configResolver.resolveAuth(model.provider);
      const storedApiKey = authResolution.status === "resolved" ? authResolution.apiKey : undefined;
      const apiKey =
        storedApiKey ??
        (providerConfig?.apiKey
          ? configResolver.resolveOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);
      if (model.provider === "google-vertex" && (!apiKey || apiKey === "gcp-vertex-credentials")) {
        return {
          ok: false,
          error:
            "Vertex ADC is disabled for isolated Pi accounts; configure a real instance-scoped API key.",
        };
      }
      if (
        !apiKey &&
        (authResolution.status === "failedStoredAuth" ||
          PI_DOWNSTREAM_ENV_BACKED_PROVIDER_IDS.has(model.provider))
      ) {
        return { ok: false, error: `No API key found for "${model.provider}"` };
      }
      const providerHeaders = configResolver.resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const perModelHeaders = configResolver.resolveHeadersOrThrow(
        modelRequestHeaders(model.provider, model.id),
        `model "${model.provider}/${model.id}"`,
      );
      let headers =
        model.headers || providerHeaders || perModelHeaders
          ? { ...model.headers, ...providerHeaders, ...perModelHeaders }
          : undefined;
      const api = (model as { readonly api?: string }).api;
      if (api?.startsWith("openai-")) {
        if (!hasHeader(headers, "OpenAI-Organization")) {
          headers = {
            ...headers,
            "OpenAI-Organization":
              configResolver.selectedValue("OPENAI_ORG_ID") ??
              configResolver.selectedValue("OPENAI_ORGANIZATION") ??
              null,
          } as unknown as Record<string, string>;
        }
        if (!hasHeader(headers, "OpenAI-Project")) {
          headers = {
            ...headers,
            "OpenAI-Project":
              configResolver.selectedValue("OPENAI_PROJECT_ID") ??
              configResolver.selectedValue("OPENAI_PROJECT") ??
              null,
          } as unknown as Record<string, string>;
        }
      }
      if (
        api === "anthropic-messages" &&
        !String(apiKey ?? "").startsWith("sk-ant-oat") &&
        !hasHeader(headers, "Authorization")
      ) {
        const authToken = configResolver.selectedValue("ANTHROPIC_AUTH_TOKEN");
        headers = {
          ...headers,
          Authorization: authToken ? `Bearer ${authToken}` : null,
        } as unknown as Record<string, string>;
      }
      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }
      return {
        ok: true,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  registry.getProviderAuthStatus = (provider) => {
    const authStatus = authStorage.getAuthStatus(provider);
    if (authStatus.source) {
      return authStatus;
    }
    const providerApiKey = providerRequestConfig(provider)?.apiKey;
    if (!providerApiKey) {
      return authStatus;
    }
    if (providerApiKey.startsWith("!")) {
      return { configured: true, source: "models_json_command" };
    }
    if (configResolver.selectedValue(providerApiKey)) {
      return { configured: true, source: "environment", label: providerApiKey };
    }
    return { configured: true, source: "models_json_key" };
  };
  registry.getApiKeyForProvider = async (provider) => {
    const authResolution = await configResolver.resolveAuth(provider);
    if (authResolution.status === "resolved") {
      return authResolution.apiKey;
    }
    const providerApiKey = providerRequestConfig(provider)?.apiKey;
    return providerApiKey ? configResolver.resolve(providerApiKey) : undefined;
  };
}

function piRuntimeEnvironmentFingerprint(
  environment: Readonly<Record<string, string>> | undefined,
  instanceId?: string,
  paths?: { readonly stateDir: string; readonly homeDir: string },
): string {
  if (environment === undefined) {
    return "ambient";
  }
  const normalized = Object.entries(
    buildPiSelectedEnvironment(environment, instanceId, paths),
  ).toSorted(([left], [right]) => left.localeCompare(right));
  return `isolated:${crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16)}`;
}

// Keep discovery registries isolated so extension provider registrations reflect
// the current agent dir + project cwd instead of stale state from prior listings.
export function createPiModelRegistry(
  agentDir: string,
  piSdk: PiModelRegistrySdk,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly stateDir: string; readonly homeDir: string },
): PiModelRegistryContext {
  const authStorage = piSdk.AuthStorage.create(path.join(agentDir, "auth.json"));
  // Pi's SDK can read API keys from process.env. Provider-instance keys must stay
  // scoped to this AuthStorage instead, otherwise unrelated server work can inherit them.
  const hasAccountBoundary =
    environment !== undefined || (instanceId !== undefined && instanceId !== PROVIDER);
  const runtimeEnvironment = hasAccountBoundary
    ? buildPiSelectedEnvironment(environment ?? {}, instanceId, paths)
    : environment;
  let configResolver: PiInstanceResolver | undefined;
  if (hasAccountBoundary) {
    configResolver = isolatePiAuthStorageFromAmbientEnvironment(
      authStorage,
      runtimeEnvironment ?? {},
      piSdk.getShellConfig,
    );
  }
  applyPiRuntimeApiKeysFromEnvironment(authStorage, runtimeEnvironment);
  const registry = piSdk.ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  const registryInternals = registry as unknown as PiModelRegistryInternals;
  if (hasAccountBoundary && registryInternals.models) {
    registryInternals.models = registryInternals.models.map((model) => ({
      ...model,
      ...(model.headers ? { headers: { ...model.headers } } : {}),
      ...(model.compat ? { compat: { ...model.compat } } : {}),
    }));
  }
  if (configResolver) {
    isolatePiModelRegistryFromAmbientEnvironment(registry, authStorage, configResolver);
  }
  return {
    authStorage,
    registry,
  };
}

function extensionDisplayName(extension: {
  readonly path: string;
  readonly sourceInfo?: { readonly source?: string };
}): string {
  const source = trimToUndefined(extension.sourceInfo?.source);
  if (source) return source;
  const extensionPath = trimToUndefined(extension.path);
  return extensionPath ? path.basename(extensionPath).replace(/\.(?:ts|js)$/u, "") : "extension";
}

function makePiUserInputOption(label: string): UserInputQuestion["options"][number] {
  const normalizedLabel = trimToUndefined(label) ?? "Option";
  return { label: normalizedLabel, description: normalizedLabel };
}

export function makePiUserInputOptions(
  labels: ReadonlyArray<string>,
): ReadonlyArray<PiUserInputOptionMapping> {
  const labelCounts = new Map<string, number>();
  return labels.map((label, index) => {
    const baseLabel = trimToUndefined(label) ?? `Option ${index + 1}`;
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    const displayLabel = count === 1 ? baseLabel : `${baseLabel} (${count})`;
    return {
      value: label,
      option: { label: displayLabel, description: baseLabel },
    };
  });
}

function firstPiUserInputAnswer(
  answers: ProviderUserInputAnswers,
  questionId: string,
): string | undefined {
  const answer = answers[questionId];
  if (typeof answer === "string") {
    return trimToUndefined(answer);
  }
  if (Array.isArray(answer)) {
    return trimToUndefined(answer.find((entry) => typeof entry === "string"));
  }
  return undefined;
}

export const PLAIN_PI_EXTENSION_THEME = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
  italic(text: string) {
    return text;
  },
  underline(text: string) {
    return text;
  },
  inverse(text: string) {
    return text;
  },
  strikethrough(text: string) {
    return text;
  },
  getFgAnsi() {
    return "";
  },
  getBgAnsi() {
    return "";
  },
  getColorMode() {
    return "truecolor";
  },
  getThinkingBorderColor() {
    return (text: string) => text;
  },
  getBashModeBorderColor() {
    return (text: string) => text;
  },
} as unknown as ExtensionUIContext["theme"];

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const piExtensionModeCoordinator = makePiExtensionModeCoordinator(() => ({
      hasExtensionEnabledDefault: [...sessions.values()].some(
        (context) => context.extensionsEnabled,
      ),
      hasIsolatedMode: [...sessions.values()].some((context) => !context.extensionsEnabled),
    }));
    const reservePiExtensionMode = (isolatedAccount: boolean, replacingThreadId?: ThreadId) =>
      piExtensionModeCoordinator.reserve(
        isolatedAccount,
        replacingThreadId === undefined
          ? undefined
          : {
              hasExtensionEnabledDefault: [...sessions.entries()].some(
                ([threadId, context]) =>
                  threadId !== replacingThreadId && context.extensionsEnabled,
              ),
              hasIsolatedMode: [...sessions.entries()].some(
                ([threadId, context]) =>
                  threadId !== replacingThreadId && !context.extensionsEnabled,
              ),
            },
      );
    const preparePiDiscoveryMode = (
      environment: Readonly<Record<string, string>> | undefined,
      instanceId: string | undefined,
    ) => {
      const isolated =
        environment !== undefined || (instanceId !== undefined && instanceId !== PROVIDER);
      const reservation = reservePiExtensionMode(isolated);
      if (isolated) {
        resetApiProviders();
        resetOAuthProviders();
      }
      return reservation;
    };
    const withPiDiscoveryReservation = async <A>(
      environment: Readonly<Record<string, string>> | undefined,
      instanceId: string | undefined,
      run: (noExtensions: boolean) => Promise<A>,
    ): Promise<A> => {
      const reservation = preparePiDiscoveryMode(environment, instanceId);
      try {
        return await run(reservation.noExtensions);
      } finally {
        reservation.release();
      }
    };
    const modelRegistryContexts = new Map<string, PiModelRegistryContext>();
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const loadPiSdk = (method: string) =>
      Effect.tryPromise({
        try: () => loadPiCodingAgentModule(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, "Failed to load Pi SDK."),
            cause,
          }),
      });

    const getModelRegistryContext = async (
      agentDir: string,
      environment: Readonly<Record<string, string>> | undefined,
      instanceId: string | undefined,
      piSdk: PiModelRegistrySdk,
    ): Promise<PiModelRegistryContext> => {
      const paths = { stateDir: serverConfig.stateDir, homeDir: serverConfig.homeDir };
      const cacheKey = `${agentDir}:${instanceId ?? PROVIDER}:${piRuntimeEnvironmentFingerprint(environment, instanceId, paths)}`;
      const existing = modelRegistryContexts.get(cacheKey);
      if (existing) return existing;
      const context = createPiModelRegistry(agentDir, piSdk, environment, instanceId, paths);
      modelRegistryContexts.set(cacheKey, context);
      return context;
    };

    const makeEventBase = (
      context: PiSessionContext,
      options?: { readonly includeTurnId?: boolean },
    ) => ({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      ...(context.session.providerInstanceId !== undefined
        ? { providerInstanceId: context.session.providerInstanceId }
        : {}),
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(options?.includeTurnId !== false && context.activeTurnId
        ? { turnId: context.activeTurnId }
        : {}),
    });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runPromise(Queue.offer(runtimeEventQueue, event)).catch(() => undefined);
      if (nativeEventLogger && event.raw) {
        Effect.runPromise(nativeEventLogger.write(event.raw, event.threadId)).catch(
          () => undefined,
        );
      }
    };

    const offerRuntimeError = (
      context: PiSessionContext,
      input: {
        readonly message: string;
        readonly cause?: unknown;
        readonly method: string;
        readonly messageType?: string;
      },
    ) => {
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: false }),
        type: "runtime.error",
        payload: {
          message: input.message,
          class: classifyPiRuntimeError(input.message),
          ...(input.cause !== undefined ? { detail: runtimeErrorDetail(input.cause) } : {}),
        },
        raw: {
          source: "pi.sdk.event",
          method: input.method,
          ...(input.messageType ? { messageType: input.messageType } : {}),
          payload: input.cause ?? { message: input.message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const resolvePiExtensionUserInput = (
      context: PiSessionContext,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) => {
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) return false;
      pending.resolve(answers);
      return true;
    };

    const requestPiExtensionUserInput = (
      context: PiSessionContext,
      input: {
        readonly method: string;
        readonly question: UserInputQuestion;
        readonly opts?: Parameters<ExtensionUIContext["select"]>[2];
        readonly rawPayload?: Record<string, unknown>;
      },
    ): Promise<ProviderUserInputAnswers> => {
      if (context.stopped || input.opts?.signal?.aborted) {
        return Promise.resolve({});
      }

      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);

      return new Promise((resolve) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let abort: () => void = () => undefined;

        const cleanup = () => {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          input.opts?.signal?.removeEventListener("abort", abort);
        };
        const finish = (answers: ProviderUserInputAnswers) => {
          if (settled) return;
          settled = true;
          cleanup();
          context.pendingUserInputs.delete(requestId);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "user-input.resolved",
            requestId: runtimeRequestId,
            payload: { answers },
            raw: {
              source: "pi.sdk.event",
              method: `${input.method}/answered`,
              payload: { requestId, answers },
            },
          } satisfies ProviderRuntimeEvent);
          resolve(answers);
        };
        abort = () => finish({});

        context.pendingUserInputs.set(requestId, { resolve: finish });
        if (typeof input.opts?.timeout === "number" && input.opts.timeout > 0) {
          timeoutId = setTimeout(abort, input.opts.timeout);
        }
        input.opts?.signal?.addEventListener("abort", abort, { once: true });

        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "user-input.requested",
          requestId: runtimeRequestId,
          payload: { questions: [input.question] },
          raw: {
            source: "pi.sdk.event",
            method: input.method,
            payload: input.rawPayload ?? { requestId, question: input.question },
          },
        } satisfies ProviderRuntimeEvent);
      });
    };

    // Bridges the common Pi extension UI primitives onto Synara's existing
    // pending user-input flow; terminal/TUI-only APIs remain no-op by design.
    const makePiExtensionUIContext = (context: PiSessionContext): ExtensionUIContext => {
      const unsupportedWarnings = new Set<string>();
      const statusTexts = new Map<string, string>();
      let workingMessage: string | undefined;
      const warnUnsupported = (method: string) => {
        if (unsupportedWarnings.has(method)) return;
        unsupportedWarnings.add(method);
        offerRuntimeEvent({
          ...makeEventBase(context, { includeTurnId: false }),
          type: "runtime.warning",
          payload: {
            message: `Pi extension UI API '${method}' is not supported in Synara yet.`,
            detail: { method },
          },
          raw: {
            source: "pi.sdk.event",
            method: "extension/ui-unsupported",
            payload: { method },
          },
        } satisfies ProviderRuntimeEvent);
      };
      const emitPluginProgress = (summary: string) => {
        const normalized = trimToUndefined(summary);
        if (!normalized) return;
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "tool.progress",
          payload: { toolName: "Pi plugin", summary: normalized },
          raw: {
            source: "pi.sdk.event",
            method: "extension/ui-progress",
            payload: { summary: normalized },
          },
        } satisfies ProviderRuntimeEvent);
      };

      const uiContext: ExtensionUIContext = {
        async select(title, options, opts) {
          const questionId = "selection";
          const optionMappings = makePiUserInputOptions(options);
          const answers = await requestPiExtensionUserInput(context, {
            method: "extension/ui/select",
            opts,
            question: {
              id: questionId,
              header: trimToUndefined(title) ?? "Pi plugin",
              question: trimToUndefined(title) ?? "Choose an option.",
              options: optionMappings.map((mapping) => mapping.option),
            },
            rawPayload: { title, options },
          });
          const answer = firstPiUserInputAnswer(answers, questionId);
          return optionMappings.find((mapping) => mapping.option.label === answer)?.value;
        },
        async confirm(title, message, opts) {
          const questionId = "confirmation";
          const answers = await requestPiExtensionUserInput(context, {
            method: "extension/ui/confirm",
            opts,
            question: {
              id: questionId,
              header: trimToUndefined(title) ?? "Pi plugin",
              question:
                trimToUndefined(message) ?? trimToUndefined(title) ?? "Confirm this action?",
              options: [makePiUserInputOption("Yes"), makePiUserInputOption("No")],
            },
            rawPayload: { title, message },
          });
          return firstPiUserInputAnswer(answers, questionId) === "Yes";
        },
        async input(title, placeholder, opts) {
          const questionId = "input";
          const answers = await requestPiExtensionUserInput(context, {
            method: "extension/ui/input",
            opts,
            question: {
              id: questionId,
              header: trimToUndefined(title) ?? "Pi plugin",
              question:
                trimToUndefined(placeholder) ?? trimToUndefined(title) ?? "Type a response.",
              options: [],
            },
            rawPayload: { title, placeholder },
          });
          return firstPiUserInputAnswer(answers, questionId);
        },
        notify(message, type) {
          const normalized = trimToUndefined(message);
          if (!normalized) return;
          if (type === "warning" || type === "error") {
            offerRuntimeEvent({
              ...makeEventBase(context),
              type: "runtime.warning",
              payload: { message: normalized, detail: { type: type ?? "info" } },
              raw: {
                source: "pi.sdk.event",
                method: "extension/ui/notify",
                payload: { message: normalized, type },
              },
            } satisfies ProviderRuntimeEvent);
            return;
          }
          emitPluginProgress(normalized);
        },
        onTerminalInput() {
          warnUnsupported("onTerminalInput");
          return () => undefined;
        },
        setStatus(key, text) {
          const normalizedKey = trimToUndefined(key) ?? "status";
          const normalizedText = trimToUndefined(text);
          if (!normalizedText) {
            statusTexts.delete(normalizedKey);
            return;
          }
          if (statusTexts.get(normalizedKey) === normalizedText) return;
          statusTexts.set(normalizedKey, normalizedText);
          emitPluginProgress(`${normalizedKey}: ${normalizedText}`);
        },
        setWorkingMessage(message) {
          const normalizedMessage = trimToUndefined(message);
          if (!normalizedMessage || normalizedMessage === workingMessage) return;
          workingMessage = normalizedMessage;
          emitPluginProgress(normalizedMessage);
        },
        setWorkingVisible() {},
        setWorkingIndicator() {},
        setHiddenThinkingLabel() {},
        setWidget() {
          warnUnsupported("setWidget");
        },
        setFooter() {
          warnUnsupported("setFooter");
        },
        setHeader() {
          warnUnsupported("setHeader");
        },
        setTitle(title) {
          if (title) emitPluginProgress(title);
        },
        async custom() {
          warnUnsupported("custom");
          return undefined as never;
        },
        pasteToEditor() {
          warnUnsupported("pasteToEditor");
        },
        setEditorText() {
          warnUnsupported("setEditorText");
        },
        getEditorText() {
          return "";
        },
        editor(title, prefill) {
          return uiContext.input(title, prefill);
        },
        addAutocompleteProvider() {
          warnUnsupported("addAutocompleteProvider");
        },
        setEditorComponent() {
          warnUnsupported("setEditorComponent");
        },
        getEditorComponent() {
          return undefined;
        },
        theme: PLAIN_PI_EXTENSION_THEME,
        getAllThemes() {
          return [];
        },
        getTheme() {
          return undefined;
        },
        setTheme() {
          return { success: false, error: "Synara does not expose Pi themes." };
        },
        getToolsExpanded() {
          return false;
        },
        setToolsExpanded() {},
      };
      return uiContext;
    };

    const completePromptRejection = (context: PiSessionContext, turnId: TurnId, cause: unknown) => {
      if (context.activeTurnId !== turnId) {
        return;
      }

      const message = toMessage(cause, "Pi turn failed.");
      const failure = classifyPiTurnFailure(message);
      const completionBase = makeEventBase(context);
      if (failure.state === "failed") {
        offerRuntimeError(context, { message, method: "prompt", cause });
      }
      context.activeTurnId = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeToolItems.clear();
      context.session = makeSessionSnapshot(context);
      offerRuntimeEvent({
        ...completionBase,
        type: "turn.completed",
        payload: {
          state: failure.state,
          stopReason: failure.stopReason,
          errorMessage: message,
        },
        raw: { source: "pi.sdk.event", method: "prompt", payload: cause },
      } satisfies ProviderRuntimeEvent);
    };

    const recordItem = (context: PiSessionContext, item: unknown) => {
      const turn = context.activeTurnId
        ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
        : context.turns.at(-1);
      turn?.items.push(item);
    };

    const requireSession = Effect.fn("PiAdapter.requireSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      }
      return context;
    });

    const disposeSessionContext = async (context: PiSessionContext) => {
      context.unsubscribe?.();
      context.unsubscribe = undefined;
      for (const pending of Array.from(context.pendingUserInputs.values())) {
        pending.resolve({});
      }
      context.pendingUserInputs.clear();
      context.stopped = true;
      await context.runtime.dispose();
    };

    const handleMessageUpdate = (
      context: PiSessionContext,
      event: Extract<AgentSessionEvent, { type: "message_update" }>,
    ) => {
      if (event.message.role !== "assistant") return;
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        if (!context.activeAssistantItemId) {
          context.activeAssistantItemId = RuntimeItemId.makeUnsafe(
            `pi-assistant-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
        }
        recordItem(context, { type: "assistant_message", delta: update.delta });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      if (update.type === "thinking_delta") {
        if (!context.activeReasoningItemId) {
          context.activeReasoningItemId = RuntimeItemId.makeUnsafe(
            `pi-reasoning-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "item.started",
            payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
        }
        recordItem(context, { type: "reasoning", delta: update.delta });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
          raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
        } satisfies ProviderRuntimeEvent);
      }
    };

    const handleSessionEvent = (context: PiSessionContext, event: AgentSessionEvent) => {
      switch (event.type) {
        case "agent_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.state.changed",
            payload: { state: "active" },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "turn_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.started",
            payload: {
              ...(context.runtime.session.model
                ? {
                    model: `${context.runtime.session.model.provider}/${context.runtime.session.model.id}`,
                  }
                : {}),
              effort: context.runtime.session.thinkingLevel,
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "message_update":
          handleMessageUpdate(context, event);
          return;
        case "tool_execution_start": {
          const itemId = RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`);
          const tracked: PiTrackedToolCall = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            itemId,
            itemType: toolItemType(event.toolName),
          };
          context.activeToolItems.set(event.toolCallId, tracked);
          const title = toolTitle(event.toolName, event.args);
          recordItem(context, {
            type: "tool_call",
            status: "started",
            toolName: event.toolName,
            args: event.args,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.started",
            payload: {
              itemType: tracked.itemType,
              status: "inProgress",
              title,
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              }),
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "tool_execution_update": {
          const tracked = context.activeToolItems.get(event.toolCallId);
          if (!tracked) return;
          const detail = textFromToolResult(event.partialResult);
          recordItem(context, {
            type: "tool_call",
            status: "updated",
            toolName: event.toolName,
            output: detail,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: tracked.itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.updated",
            payload: {
              itemType: tracked.itemType,
              status: "inProgress",
              title: toolTitle(event.toolName, tracked.args),
              ...(detail ? { detail } : {}),
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: tracked.args,
                partialResult: event.partialResult,
              }),
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "tool_execution_end": {
          const tracked = context.activeToolItems.get(event.toolCallId) ?? {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: undefined,
            itemId: RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`),
            itemType: toolItemType(event.toolName),
          };
          context.activeToolItems.delete(event.toolCallId);
          const detail = textFromToolResult(event.result);
          recordItem(context, {
            type: "tool_call",
            status: event.isError ? "failed" : "completed",
            toolName: event.toolName,
            output: detail,
            result: event.result,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: tracked.itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.completed",
            payload: {
              itemType: tracked.itemType,
              status: event.isError ? "failed" : "completed",
              title: toolTitle(event.toolName, tracked.args),
              ...(detail ? { detail } : {}),
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: tracked.args,
                result: event.result,
                isError: event.isError,
              }),
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "compaction_start": {
          const itemId = RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`);
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId,
            type: "item.updated",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "compaction_end": {
          const itemId = RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`);
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId,
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: event.aborted ? "failed" : "completed",
              title: "Context compacted",
              data: event,
            },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "agent_end": {
          const stats = context.runtime.session.getSessionStats();
          const usage = normalizeTokenUsage(stats, context.runtime.session.model?.contextWindow);
          context.lastKnownTokenUsage = usage;
          const turnId = context.activeTurnId;
          const errorMessage = context.runtime.session.agent.state.errorMessage;
          const failure = errorMessage ? classifyPiTurnFailure(errorMessage) : undefined;
          const leafId = context.runtime.session.sessionManager.getLeafId();
          const turn = turnId
            ? context.turns.find((candidate) => candidate.id === turnId)
            : undefined;
          if (turn) turn.leafId = leafId;
          if (context.activeAssistantItemId) {
            offerRuntimeEvent({
              ...makeEventBase(context),
              itemId: context.activeAssistantItemId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: errorMessage ? "failed" : "completed",
                title: "Assistant",
              },
              raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
            } satisfies ProviderRuntimeEvent);
          }
          if (context.activeReasoningItemId) {
            offerRuntimeEvent({
              ...makeEventBase(context),
              itemId: context.activeReasoningItemId,
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: errorMessage ? "failed" : "completed",
                title: "Reasoning",
              },
              raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
            } satisfies ProviderRuntimeEvent);
          }
          if (usage) {
            offerRuntimeEvent({
              ...makeEventBase(context),
              type: "thread.token-usage.updated",
              payload: { usage },
              raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
            } satisfies ProviderRuntimeEvent);
          }
          if (errorMessage && failure?.state === "failed") {
            offerRuntimeError(context, {
              message: errorMessage,
              method: "prompt",
              messageType: event.type,
              cause: event,
            });
          }
          const completionBase = makeEventBase(context);
          context.activeTurnId = undefined;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          context.activeToolItems.clear();
          context.session = makeSessionSnapshot(context);
          offerRuntimeEvent({
            ...completionBase,
            type: "turn.completed",
            payload:
              errorMessage && failure
                ? {
                    state: failure.state,
                    stopReason: failure.stopReason,
                    errorMessage,
                    usage: stats,
                  }
                : { state: "completed", stopReason: null, usage: stats },
            raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        default:
          return;
      }
    };

    const createSdkRuntime = async (input: {
      sdk: PiCodingAgentModule;
      cwd: string;
      agentDir: string;
      environment?: Readonly<Record<string, string>>;
      instanceId?: string;
      sessionManager: SessionManager;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
      noExtensions?: boolean;
    }) => {
      const { authStorage, registry } = await getModelRegistryContext(
        input.agentDir,
        input.environment,
        input.instanceId,
        input.sdk,
      );
      const createRuntime: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) => {
        const services = await input.sdk.createAgentSessionServices({
          cwd,
          agentDir,
          authStorage,
          modelRegistry: registry,
          ...(input.noExtensions ? { resourceLoaderOptions: { noExtensions: true } } : {}),
        });
        const model = findModelInRegistry(services.modelRegistry, input.modelId);
        if (input.modelId && !model) {
          throw new Error(
            `Pi model '${input.modelId}' is not available. Use a discovered model or a provider-qualified custom model slug like 'openai/gpt-5.5'.`,
          );
        }
        return {
          ...(await input.sdk.createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent ? { sessionStartEvent } : {}),
            ...(model ? { model } : {}),
            thinkingLevel: input.thinkingLevel ?? DEFAULT_PI_THINKING_LEVEL,
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };
      const runtime = await input.sdk.createAgentSessionRuntime(createRuntime, {
        cwd: input.sessionManager.getCwd(),
        agentDir: input.agentDir,
        sessionManager: input.sessionManager,
      });
      return { runtime, modelRegistry: runtime.services.modelRegistry };
    };

    const startSession: PiAdapterShape["startSession"] = (input) => {
      const piOptions = input.providerOptions?.pi;
      const piEnvironment = piOptions?.environment;
      const resolvedProviderInstanceId = resolvePiStartInstanceId(input);
      const isolatedAccount =
        piEnvironment !== undefined ||
        (resolvedProviderInstanceId !== undefined && resolvedProviderInstanceId !== PROVIDER);
      return Effect.acquireUseRelease(
        Effect.try({
          try: () => reservePiExtensionMode(isolatedAccount, input.threadId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
        (modeReservation) =>
          Effect.gen(function* () {
            const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
            const sessionFile = extractResumeSessionFile(input.resumeCursor);
            const modelId = input.modelSelection?.model;
            const thinkingLevel = normalizePiThinkingLevel(
              getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel"),
            );
            const existingContext = sessions.get(input.threadId);
            if (existingContext) {
              yield* Effect.tryPromise({
                try: () => disposeSessionContext(existingContext),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/restart",
                    detail: toMessage(cause, "Failed to dispose previous Pi session."),
                    cause,
                  }),
              });
              sessions.delete(input.threadId);
            }
            if (isolatedAccount) {
              resetApiProviders();
              resetOAuthProviders();
            }
            const piSdk = yield* loadPiSdk("session/start");
            const noExtensions = modeReservation.noExtensions;
            const { runtime, modelRegistry } = yield* Effect.tryPromise({
              try: () => {
                const storagePaths = makePiStoragePaths({
                  agentDir: piOptions?.agentDir,
                  environment: piEnvironment,
                  instanceId: resolvedProviderInstanceId,
                  stateDir: serverConfig.stateDir,
                  homeDir: serverConfig.homeDir,
                  sdkAgentDir: piSdk.getAgentDir(),
                });
                const agentDir = storagePaths.agentDir;
                const sessionManager = sessionFile
                  ? piSdk.SessionManager.open(sessionFile, undefined, cwd)
                  : piSdk.SessionManager.create(cwd, storagePaths.sessionDir);
                return createSdkRuntime({
                  sdk: piSdk,
                  cwd,
                  agentDir,
                  ...(resolvedProviderInstanceId !== undefined
                    ? { instanceId: resolvedProviderInstanceId }
                    : {}),
                  ...(piEnvironment !== undefined ? { environment: piEnvironment } : {}),
                  sessionManager,
                  ...(noExtensions ? { noExtensions: true } : {}),
                  ...(modelId ? { modelId } : {}),
                  ...(thinkingLevel ? { thinkingLevel } : {}),
                });
              },
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: toMessage(cause, "Failed to start Pi session."),
                  cause,
                }),
            });
            const now = new Date().toISOString();
            const model = runtime.session.model
              ? `${runtime.session.model.provider}/${runtime.session.model.id}`
              : modelId;
            const resumeCursor = getSessionFile(runtime.session);
            const session: ProviderSession = {
              provider: PROVIDER,
              ...(resolvedProviderInstanceId !== undefined
                ? { providerInstanceId: resolvedProviderInstanceId }
                : {}),
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd,
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
              ...(model ? { model } : {}),
              ...(resumeCursor ? { resumeCursor } : {}),
            };
            const context: PiSessionContext = {
              runtime,
              modelRegistry,
              session,
              turns: [],
              activeTurnId: undefined,
              activeAssistantItemId: undefined,
              activeReasoningItemId: undefined,
              activeToolItems: new Map(),
              pendingUserInputs: new Map(),
              stopped: false,
              lastKnownTokenUsage: undefined,
              unsubscribe: undefined,
              extensionsEnabled: !noExtensions,
            };
            context.unsubscribe = runtime.session.subscribe((event) =>
              handleSessionEvent(context, event),
            );
            sessions.set(input.threadId, context);
            yield* Effect.tryPromise({
              try: () =>
                runtime.session.bindExtensions({ uiContext: makePiExtensionUIContext(context) }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "extension/bind",
                  detail: toMessage(cause, "Failed to bind Pi extensions."),
                  cause,
                }),
            }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  sessions.delete(input.threadId);
                  yield* Effect.tryPromise({
                    try: () => disposeSessionContext(context),
                    catch: () => error,
                  }).pipe(Effect.catch(() => Effect.void));
                  return yield* Effect.fail(error);
                }),
              ),
            );
            const loadedExtensions = runtime.session.resourceLoader.getExtensions().extensions;
            if (loadedExtensions.length > 0) {
              const extensionNames = loadedExtensions.map(extensionDisplayName);
              offerRuntimeEvent({
                ...makeEventBase(context, { includeTurnId: false }),
                type: "runtime.warning",
                payload: {
                  message:
                    "Pi extensions are loaded with Synara's limited UI bridge. select/confirm/input/notify/status are supported; TUI-only widgets and editor hooks are ignored.",
                  detail: {
                    extensionCount: loadedExtensions.length,
                    extensions: extensionNames,
                  },
                },
                raw: {
                  source: "pi.sdk.event",
                  method: "extension/ui-limited-warning",
                  payload: { extensionCount: loadedExtensions.length, extensions: extensionNames },
                },
              } satisfies ProviderRuntimeEvent);
            }
            offerRuntimeEvent({
              ...makeEventBase(context),
              type: "session.started",
              payload: { message: "Pi session started", resume: session.resumeCursor },
            } satisfies ProviderRuntimeEvent);
            offerRuntimeEvent({
              ...makeEventBase(context),
              type: "thread.started",
              payload: { providerThreadId: runtime.session.sessionId },
            } satisfies ProviderRuntimeEvent);
            const initialUsage = normalizeTokenUsage(
              runtime.session.getSessionStats(),
              runtime.session.model?.contextWindow,
            );
            context.lastKnownTokenUsage = initialUsage;
            if (initialUsage) {
              offerRuntimeEvent({
                ...makeEventBase(context),
                type: "thread.token-usage.updated",
                payload: { usage: initialUsage },
              } satisfies ProviderRuntimeEvent);
            }
            return session;
          }),
        (modeReservation) => Effect.sync(modeReservation.release),
      );
    };

    const buildPromptPayload = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      Effect.gen(function* () {
        const text =
          appendFileAttachmentsPromptBlock({
            text: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          }) ?? "";
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image" || !attachment.mimeType) return undefined;
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "turn/start",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
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
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          { concurrency: 1 },
        );
        return {
          text,
          images: images.filter((image): image is ImageContent => image !== undefined),
        };
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A Pi turn is already active for this thread.",
          });
        }
        if (input.modelSelection) {
          const model = findModelInRegistry(context.modelRegistry, input.modelSelection.model);
          if (!model) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "model/set",
              issue: `Pi model '${input.modelSelection.model}' is not available. Use a discovered model or a provider-qualified custom model slug like 'openai/gpt-5.5'.`,
            });
          }
          yield* Effect.tryPromise({
            try: () => context.runtime.session.setModel(model),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/set",
                detail: toMessage(cause, "Failed to set Pi model."),
                cause,
              }),
          });
          const thinkingLevel = normalizePiThinkingLevel(
            getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel"),
          );
          if (thinkingLevel) {
            context.runtime.session.setThinkingLevel(thinkingLevel);
          }
        }
        const payload = yield* buildPromptPayload(input);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
        context.session = makeSessionSnapshot(context);
        if (payload.images.length === 0 && isPiReloadCommand(payload.text)) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.started",
            payload: {
              ...(context.runtime.session.model
                ? {
                    model: `${context.runtime.session.model.provider}/${context.runtime.session.model.id}`,
                  }
                : {}),
              effort: context.runtime.session.thinkingLevel,
            },
            raw: { source: "pi.sdk.event", method: "reload", payload: { command: payload.text } },
          } satisfies ProviderRuntimeEvent);
          yield* Effect.tryPromise({
            try: () => context.runtime.session.reload(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/reload",
                detail: toMessage(cause, "Failed to reload Pi resources."),
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const message = error.message;
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "turn.completed",
                  payload: { state: "failed", stopReason: "error", errorMessage: message },
                  raw: { source: "pi.sdk.event", method: "reload", payload: error },
                } satisfies ProviderRuntimeEvent);
                offerRuntimeError(context, {
                  message,
                  method: "session/reload",
                  cause: error,
                });
                context.activeTurnId = undefined;
                context.session = makeSessionSnapshot(context);
                return yield* Effect.fail(error);
              }),
            ),
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.completed",
            payload: { state: "completed", stopReason: "reload" },
            raw: { source: "pi.sdk.event", method: "reload", payload: { command: payload.text } },
          } satisfies ProviderRuntimeEvent);
          context.activeTurnId = undefined;
          context.session = makeSessionSnapshot(context);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: getSessionFile(context.runtime.session),
          };
        }
        void context.runtime.session
          .prompt(payload.text, payload.images.length > 0 ? { images: payload.images } : undefined)
          .catch((cause) => {
            completePromptRejection(context, turnId, cause);
          });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.runtime.session),
        };
      });

    const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const payload = yield* buildPromptPayload(input);
        const turnId = context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
        if (!context.activeTurnId) {
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
        }
        if (context.runtime.session.isStreaming) {
          yield* Effect.tryPromise({
            try: () => context.runtime.session.steer(payload.text, payload.images),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: toMessage(cause, "Failed to steer Pi turn."),
                cause,
              }),
          });
        } else {
          void context.runtime.session
            .prompt(
              payload.text,
              payload.images.length > 0 ? { images: payload.images } : undefined,
            )
            .catch((cause) => {
              completePromptRejection(context, turnId, cause);
            });
        }
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.runtime.session),
        };
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.runtime.session.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt Pi turn."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const respondUnsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Pi does not expose Synara approval/user-input requests for thread ${threadId}.`,
        }),
      );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!resolvePiExtensionUserInput(context, requestId, answers)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `Unknown pending Pi user-input request: ${requestId}`,
          });
        }
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => disposeSessionContext(context),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/stop",
                detail: toMessage(cause, "Failed to stop Pi session."),
                cause,
              }),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                context.stopped = true;
                sessions.delete(threadId);
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "thread.state.changed",
                  payload: { state: "closed", detail: { reason: "stopped" } },
                } satisfies ProviderRuntimeEvent);
                offerRuntimeEvent({
                  ...makeEventBase(context),
                  type: "session.exited",
                  payload: { reason: "stopped", exitKind: "graceful" },
                } satisfies ProviderRuntimeEvent);
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map(makeSessionSnapshot));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const snapshotThread = (context: PiSessionContext): ProviderThreadSnapshot => {
      const historyItems = mapMessageHistory(context.runtime.session);
      const activeTurn = context.activeTurnId
        ? context.turns.find((turn) => turn.id === context.activeTurnId)
        : undefined;
      const turns = [
        ...(historyItems.length > 0
          ? [
              {
                id: TurnId.makeUnsafe(`pi-history-${context.runtime.session.sessionId}`),
                items: historyItems,
              },
            ]
          : []),
        ...(activeTurn ? [{ id: activeTurn.id, items: [...activeTurn.items] }] : []),
      ];
      return {
        threadId: context.session.threadId,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        turns:
          turns.length > 0
            ? turns
            : context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    };

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map(snapshotThread));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
        context.turns.splice(nextLength);
        const leafId = context.turns.at(-1)?.leafId;
        if (leafId) {
          context.runtime.session.sessionManager.branch(leafId);
        } else if (nextLength === 0) {
          context.runtime.session.sessionManager.resetLeaf();
        }
        return snapshotThread(context);
      });

    const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.runtime.session.compact(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/compact",
                detail: toMessage(cause, "Failed to compact Pi thread."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    const listModels: NonNullable<PiAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          withPiDiscoveryReservation(input.environment, input.instanceId, async (noExtensions) => {
            const piSdk = await loadPiCodingAgentModule();
            const { agentDir } = makePiStoragePaths({
              agentDir: input.agentDir,
              environment: input.environment,
              instanceId: input.instanceId,
              stateDir: serverConfig.stateDir,
              homeDir: serverConfig.homeDir,
              sdkAgentDir: piSdk.getAgentDir(),
            });
            const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
            const { authStorage, registry } = createPiModelRegistry(
              agentDir,
              piSdk,
              input.environment,
              input.instanceId,
              { stateDir: serverConfig.stateDir, homeDir: serverConfig.homeDir },
            );
            const services = await piSdk.createAgentSessionServices({
              cwd,
              agentDir,
              authStorage,
              modelRegistry: registry,
              ...(noExtensions ? { resourceLoaderOptions: { noExtensions: true } } : {}),
            });
            const extensionCount = services.resourceLoader.getExtensions().extensions.length;
            const models = services.modelRegistry.getAvailable().map((model) => {
              const supportedThinkingOptions = getPiSupportedThinkingOptions(model);
              return {
                slug: `${model.provider}/${model.id}`,
                name: model.name,
                upstreamProviderId: model.provider,
                upstreamProviderName: services.modelRegistry.getProviderDisplayName(model.provider),
                ...(supportedThinkingOptions.length > 0
                  ? {
                      supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
                        value: option.value,
                        label: option.label,
                        description: option.description,
                      })),
                      ...(supportedThinkingOptions.some(
                        (option) => option.value === DEFAULT_PI_THINKING_LEVEL,
                      )
                        ? { defaultReasoningEffort: DEFAULT_PI_THINKING_LEVEL }
                        : {}),
                    }
                  : {}),
              };
            });
            return {
              models,
              source: extensionCount > 0 ? "pi.sdk+extensions" : "pi.sdk",
              cached: false,
            } satisfies ProviderListModelsResult;
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list Pi models."),
            cause,
          }),
      });

    const listSkills: NonNullable<PiAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          withPiDiscoveryReservation(input.environment, input.instanceId, async (noExtensions) => {
            const active = input.threadId
              ? sessions.get(ThreadId.makeUnsafe(input.threadId))
              : undefined;
            const loader = active?.runtime.session.resourceLoader;
            if (active && input.forceReload) {
              if (noExtensions && active.extensionsEnabled) {
                throw new Error(
                  "Extension reload is disabled while an isolated Pi account is active.",
                );
              }
              await active.runtime.session.reload();
            }
            let services:
              | Awaited<ReturnType<PiCodingAgentModule["createAgentSessionServices"]>>
              | undefined;
            if (!loader) {
              const piSdk = await loadPiCodingAgentModule();
              const { agentDir } = makePiStoragePaths({
                agentDir: input.agentDir,
                environment: input.environment,
                instanceId: input.instanceId,
                stateDir: serverConfig.stateDir,
                homeDir: serverConfig.homeDir,
                sdkAgentDir: piSdk.getAgentDir(),
              });
              const { authStorage, registry } = createPiModelRegistry(
                agentDir,
                piSdk,
                input.environment,
                input.instanceId,
                { stateDir: serverConfig.stateDir, homeDir: serverConfig.homeDir },
              );
              services = await piSdk.createAgentSessionServices({
                cwd: input.cwd,
                agentDir,
                authStorage,
                modelRegistry: registry,
                ...(noExtensions ? { resourceLoaderOptions: { noExtensions: true } } : {}),
              });
            }
            if (services && input.forceReload) {
              await services.resourceLoader.reload();
            }
            const resourceLoader = loader ?? services?.resourceLoader;
            if (!resourceLoader) {
              throw new Error("Failed to create Pi resource loader.");
            }
            const result = resourceLoader.getSkills();
            return {
              skills: result.skills.map((skill) => {
                const description = trimToUndefined(skill.description);
                const scope = trimToUndefined(skill.sourceInfo.source);
                return {
                  name: skill.name,
                  ...(description ? { description } : {}),
                  path: skill.filePath,
                  enabled: !skill.disableModelInvocation,
                  ...(scope ? { scope } : {}),
                };
              }),
              source: "pi.sdk",
              cached: false,
            } satisfies ProviderListSkillsResult;
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: toMessage(cause, "Failed to list Pi skills."),
            cause,
          }),
      });

    const listCommands: NonNullable<PiAdapterShape["listCommands"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          withPiDiscoveryReservation(input.environment, input.instanceId, async (noExtensions) => {
            const active = input.threadId
              ? sessions.get(ThreadId.makeUnsafe(input.threadId))
              : undefined;
            const session = active?.runtime.session;
            const reloadCommand = {
              name: "reload",
              description: "Reload Pi extensions, skills, prompts, themes, tools, and settings",
            };
            if (session) {
              if (input.forceReload) {
                await session.reload();
              }
              const extensionCommands = session.extensionRunner
                .getRegisteredCommands()
                .map((command) => ({
                  name: command.invocationName,
                  description: trimToUndefined(command.description) ?? "Extension command",
                }));
              const promptCommands = session.promptTemplates.map((template) => ({
                name: template.name,
                description: trimToUndefined(template.description) ?? "Prompt template",
              }));
              const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
                name: `skill:${skill.name}`,
                description: trimToUndefined(skill.description) ?? "Skill",
              }));
              return {
                commands: [
                  reloadCommand,
                  ...extensionCommands,
                  ...promptCommands,
                  ...skillCommands,
                ],
                source: "pi.sdk",
                cached: false,
              } satisfies ProviderListCommandsResult;
            }
            const piSdk = await loadPiCodingAgentModule();
            const { agentDir } = makePiStoragePaths({
              agentDir: input.agentDir,
              environment: input.environment,
              instanceId: input.instanceId,
              stateDir: serverConfig.stateDir,
              homeDir: serverConfig.homeDir,
              sdkAgentDir: piSdk.getAgentDir(),
            });
            const { authStorage, registry } = createPiModelRegistry(
              agentDir,
              piSdk,
              input.environment,
              input.instanceId,
              { stateDir: serverConfig.stateDir, homeDir: serverConfig.homeDir },
            );
            const services = await piSdk.createAgentSessionServices({
              cwd: input.cwd,
              agentDir,
              authStorage,
              modelRegistry: registry,
              ...(noExtensions ? { resourceLoaderOptions: { noExtensions: true } } : {}),
            });
            if (input.forceReload) {
              await services.resourceLoader.reload();
            }
            const promptCommands = services.resourceLoader.getPrompts().prompts.map((template) => ({
              name: template.name,
              description: trimToUndefined(template.description) ?? "Prompt template",
            }));
            const skillCommands = services.resourceLoader.getSkills().skills.map((skill) => ({
              name: `skill:${skill.name}`,
              description: trimToUndefined(skill.description) ?? "Skill",
            }));
            return {
              commands: [reloadCommand, ...promptCommands, ...skillCommands],
              source: "pi.sdk",
              cached: false,
            } satisfies ProviderListCommandsResult;
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "command/list",
            detail: toMessage(cause, "Failed to list Pi commands."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<PiAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.andThen(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest: (threadId) => respondUnsupported(threadId, "request/respond"),
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listSkills,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
