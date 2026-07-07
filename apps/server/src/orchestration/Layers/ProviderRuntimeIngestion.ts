import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@t3tools/shared/subagents";

import {
  generatedImageMarkdown,
  generatedImagePathFromRuntimeEvent,
  isGeneratedImageOnlyMarkdown,
} from "../../codexGeneratedImages.ts";
import { parseCheckpointFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

// FILE: ProviderRuntimeIngestion.ts
// Purpose: Projects provider runtime events into orchestration read-model updates and thread activity.
// Layer: Server orchestration ingestion
// Exports: ProviderRuntimeIngestionLive
// Depends on: ProviderRuntimeEvent contracts, OrchestrationEngine, Projection repositories

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 2_048;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(60);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 1_024;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(60);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 1_024;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(60);
const BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY = 2_048;
const BUFFERED_TOOL_OUTPUT_BY_KEY_TTL = Duration.minutes(60);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_PROPOSED_PLAN_CHARS = 64_000;
const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 24_000;
const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;
const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";
const BUFFERED_TEXT_TRUNCATION_MARKER = "... [truncated]";
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

type ActivityPayload = OrchestrationThreadActivity["payload"];
type ToolOutputStreamKind = "command_output" | "file_change_output";
type BufferedToolOutput = {
  readonly text: string;
  readonly truncated: boolean;
};
type ProviderDiffPlaceholder = {
  readonly checkpointRef: CheckpointRef;
  readonly checkpointTurnCount: number;
  // Immutable snapshot of the turn's diff files. Stored values are only ever read
  // (forwarded to dispatch / re-stored), never mutated in place, so this is a
  // ReadonlyArray — which also lets it accept the readonly `checkpoint.files` from
  // an OrchestrationThread without a defensive copy.
  readonly files: ReadonlyArray<ReturnType<typeof parseCheckpointFilesFromUnifiedDiff>[number]>;
};

/**
 * Promote a cheap thread *shell* into a full {@link OrchestrationThread} by
 * filling the heavy arrays with empties. Only valid for events that do not read
 * those arrays (see {@link eventNeedsHeavyThreadDetail}); the empties are never
 * observed on those code paths.
 */
function threadDetailFromShell(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

/**
 * PERF: ingesting one runtime event used to load the full thread detail, which
 * decodes every message's text. For a long turn that streams a large output
 * (tens of thousands of deltas over a growing transcript) this is quadratic, so
 * the live transcript — and crucially the `turn.completed` event — fall minutes
 * behind the provider even though the turn already finished.
 *
 * The overwhelming majority of events (assistant deltas, tool-call lifecycle,
 * message parts) only ever read thread *shell* fields. Only the handlers for the
 * event types below read the heavy arrays (`thread.messages` /
 * `thread.proposedPlans` / `thread.checkpoints`), so only those pay for the full
 * detail; everything else uses the cheap shell.
 */
function eventNeedsHeavyThreadDetail(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "turn.proposed.completed":
    case "turn.completed":
    case "turn.aborted":
    case "turn.diff.updated":
      return true;
    case "item.completed":
      // assistant_message completion reads thread.messages to decide whether to
      // apply fallback completion text; image_generation completion scans
      // thread.messages to attach the generated-image reference.
      return (
        event.payload.itemType === "assistant_message" ||
        generatedImagePathFromRuntimeEvent(event) !== undefined
      );
    default:
      return false;
  }
}

function parseProviderTurnDiffFiles(unifiedDiff: string) {
  try {
    return parseCheckpointFilesFromUnifiedDiff(unifiedDiff);
  } catch {
    return null;
  }
}

function toActivityPayload(payload: unknown): ActivityPayload {
  return payload as ActivityPayload;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function inferRuntimeModeFromUserInputAnswers(
  answers: Record<string, unknown> | undefined,
): RuntimeMode | null {
  const sandboxMode = typeof answers?.sandbox_mode === "string" ? answers.sandbox_mode : null;
  const approvalPolicy =
    typeof answers?.approval_policy === "string" ? answers.approval_policy : null;

  if (sandboxMode === "danger-full-access") {
    return approvalPolicy === null || approvalPolicy === "never"
      ? "full-access"
      : "approval-required";
  }
  if (sandboxMode === "read-only" || sandboxMode === "workspace-write") {
    return "approval-required";
  }
  if (approvalPolicy === "never") {
    return "full-access";
  }
  if (
    approvalPolicy === "untrusted" ||
    approvalPolicy === "on-failure" ||
    approvalPolicy === "on-request"
  ) {
    return "approval-required";
  }
  return null;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function stringifyJsonLike(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "function" || typeof entry === "symbol") {
        return undefined;
      }
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? "null"
  );
}

function truncateJsonString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 15))}... [truncated]` : value;
}

export function appendCappedBufferedText(existing: string, delta: string, limit: number): string {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return "";
  }
  const next = `${existing}${delta}`;
  if (next.length <= normalizedLimit) {
    return next;
  }
  if (normalizedLimit <= BUFFERED_TEXT_TRUNCATION_MARKER.length) {
    return BUFFERED_TEXT_TRUNCATION_MARKER.slice(0, normalizedLimit);
  }
  return `${next.slice(
    0,
    normalizedLimit - BUFFERED_TEXT_TRUNCATION_MARKER.length,
  )}${BUFFERED_TEXT_TRUNCATION_MARKER}`;
}

function toolOutputStreamKind(event: ProviderRuntimeEvent): ToolOutputStreamKind | undefined {
  if (event.type !== "content.delta") {
    return undefined;
  }
  return event.payload.streamKind === "command_output" ||
    event.payload.streamKind === "file_change_output"
    ? event.payload.streamKind
    : undefined;
}

function toolOutputBufferKey(event: ProviderRuntimeEvent): string | null {
  if (!event.itemId) {
    return null;
  }
  return [event.threadId, event.turnId ?? "no-turn", event.itemId].join(":");
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeBufferedToolOutputData(
  data: unknown,
  bufferedOutput: BufferedToolOutput,
): Record<string, unknown> {
  const baseData = isJsonObject(data) ? data : {};
  const existingRawOutput = isJsonObject(baseData.rawOutput)
    ? baseData.rawOutput
    : typeof baseData.rawOutput === "string" && baseData.rawOutput.trim().length > 0
      ? { output: baseData.rawOutput }
      : {};
  const hasStructuredOutput =
    hasNonEmptyString(existingRawOutput.output) ||
    hasNonEmptyString(existingRawOutput.stdout) ||
    hasNonEmptyString(existingRawOutput.stderr);
  return {
    ...baseData,
    rawOutput: {
      ...existingRawOutput,
      ...(hasStructuredOutput ? {} : { output: bufferedOutput.text }),
      ...(bufferedOutput.truncated ? { truncated: true } : {}),
    },
  };
}

function withBufferedToolOutputData(
  event: ProviderRuntimeEvent,
  bufferedOutput: BufferedToolOutput | undefined,
): ProviderRuntimeEvent {
  if (!bufferedOutput) {
    return event;
  }
  if (event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  if (event.payload.itemType !== "command_execution" && event.payload.itemType !== "file_change") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      data: mergeBufferedToolOutputData(event.payload.data, bufferedOutput),
    },
  } as ProviderRuntimeEvent;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityPayloadKeyRank(key: string): number {
  const ranks: Record<string, number> = {
    itemType: 0,
    status: 1,
    title: 2,
    detail: 3,
    toolName: 4,
    tool: 5,
    toolCallId: 6,
    callID: 7,
    callId: 8,
    command: 9,
    cmd: 10,
    input: 11,
    rawInput: 12,
    arguments: 13,
    args: 14,
    params: 15,
    item: 16,
    result: 17,
    rawOutput: 18,
    output: 19,
    data: 20,
    commandActions: 21,
    files: 22,
    changes: 23,
    path: 24,
    file: 25,
    filePath: 26,
    stdout: 27,
    stderr: 28,
    content: 29,
    totalFiles: 30,
    truncated: 31,
  };
  return ranks[key] ?? 100;
}

function truncateJsonValue(
  value: unknown,
  options: {
    readonly stringLimit: number;
    readonly arrayItems: number;
    readonly objectKeys: number;
    readonly depth: number;
    readonly seen?: WeakSet<object>;
  },
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateJsonString(value, options.stringLimit);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return null;
  }
  const seen = options.seen ?? new WeakSet<object>();
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }
  if (options.depth <= 0) {
    return isJsonObject(value) || Array.isArray(value)
      ? {
          [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        }
      : String(value);
  }
  if (Array.isArray(value)) {
    const retained = value
      .slice(0, options.arrayItems)
      .map((entry) => truncateJsonValue(entry, { ...options, depth: options.depth - 1 }));
    if (value.length > options.arrayItems) {
      retained.push({
        [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        omittedItems: value.length - options.arrayItems,
      });
    }
    return retained;
  }
  if (!isJsonObject(value)) {
    return String(value);
  }

  const entries = Object.entries(value)
    .filter(
      ([, entry]) =>
        entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
    )
    .toSorted((left, right) => {
      const byRank = activityPayloadKeyRank(left[0]) - activityPayloadKeyRank(right[0]);
      return byRank !== 0 ? byRank : left[0].localeCompare(right[0]);
    });
  const retainedEntries = entries.slice(0, options.objectKeys);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of retainedEntries) {
    result[key] = truncateJsonValue(entry, { ...options, depth: options.depth - 1 });
  }
  if (entries.length > options.objectKeys) {
    result[ACTIVITY_DATA_TRUNCATION_MARKER] = true;
    result.omittedKeys = entries.length - options.objectKeys;
  }
  return result;
}

function boundActivityData(value: unknown): unknown {
  const serialized = stringifyJsonLike(value);
  if (serialized.length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return JSON.parse(serialized);
  }

  const withTruncationMetadata = (bounded: unknown): Record<string, unknown> => {
    const metadata = {
      [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
      originalJsonChars: serialized.length,
    };
    return isJsonObject(bounded) ? { ...bounded, ...metadata } : { ...metadata, value: bounded };
  };
  const hardFallback = (): Record<string, unknown> => ({
    [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
    originalJsonChars: serialized.length,
    preview: truncateJsonString(serialized, MAX_ACTIVITY_DATA_STRING_CHARS),
  });

  const compact = truncateJsonValue(value, {
    stringLimit: MAX_ACTIVITY_DATA_STRING_CHARS,
    arrayItems: MAX_ACTIVITY_DATA_ARRAY_ITEMS,
    objectKeys: MAX_ACTIVITY_DATA_OBJECT_KEYS,
    depth: 6,
  });
  const compactWithMetadata = withTruncationMetadata(compact);
  if (stringifyJsonLike(compactWithMetadata).length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return compactWithMetadata;
  }

  const bounded = withTruncationMetadata(
    truncateJsonValue(value, {
      stringLimit: 800,
      arrayItems: 12,
      objectKeys: 32,
      depth: 4,
    }),
  );
  return stringifyJsonLike(bounded).length <= MAX_ACTIVITY_DATA_JSON_CHARS
    ? bounded
    : hardFallback();
}

// Tool payloads power the timeline, but they must stay small enough for snapshots.
function activityDataField(data: unknown): { readonly data?: unknown } {
  return data === undefined ? {} : { data: boundActivityData(data) };
}

// Keep MCP progress payloads available to the web timeline so it can render the specific tool call.
function buildToolProgressActivityPayload(
  event: Extract<ProviderRuntimeEvent, { type: "tool.progress" }>,
): ActivityPayload {
  return toActivityPayload({
    itemType: "mcp_tool_call" as const,
    title: "MCP tool call",
    ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
    data: {
      ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
      ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
      ...(event.payload.summary ? { summary: event.payload.summary } : {}),
      ...(event.payload.elapsedSeconds !== undefined
        ? { elapsedSeconds: event.payload.elapsedSeconds }
        : {}),
    },
  });
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function subagentThreadId(parentThreadId: ThreadId, providerThreadId: string): ThreadId {
  return ThreadId.makeUnsafe(`subagent:${parentThreadId}:${providerThreadId}`);
}

interface SubagentIdentity {
  readonly providerThreadId: string;
  readonly agentId?: string;
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly modelIsRequestedHint?: boolean;
}

function extractCollabPayload(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = runtimePayloadRecord(event);
  return asObject(payload?.data);
}

function extractSubagentIdentity(
  event: ProviderRuntimeEvent,
  providerThreadId: string,
): SubagentIdentity | undefined {
  const collabPayload = extractCollabPayload(event);
  const item = asObject(collabPayload?.item) ?? collabPayload;
  if (!item) {
    return undefined;
  }
  return resolveSubagentIdentityFromDirectory(
    buildSubagentIdentityDirectory(extractSubagentIdentityHints(item)),
    {
      providerThreadId,
    },
  ) as SubagentIdentity | undefined;
}

function subagentThreadTitle(identity: {
  nickname?: string | undefined;
  role?: string | undefined;
  providerThreadId?: string | undefined;
}): string {
  if (identity.nickname && identity.role) {
    return `${identity.nickname} [${identity.role}]`;
  }
  if (identity.nickname) {
    return identity.nickname;
  }
  if (identity.role) {
    return `Subagent [${identity.role}]`;
  }
  return identity.providerThreadId ? `Subagent ${identity.providerThreadId}` : "Subagent";
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "thread.token-usage.updated") {
    return undefined;
  }
  const usage = event.payload.usage;
  const hasTokenUsage = usage.usedTokens > 0;
  const hasPercentUsage =
    typeof usage.usedPercent === "number" && Number.isFinite(usage.usedPercent);
  const hasKnownWindow = typeof usage.maxTokens === "number" && Number.isFinite(usage.maxTokens);
  if (!hasTokenUsage && !hasPercentUsage && !hasKnownWindow) {
    return undefined;
  }
  return toActivityPayload(usage);
}

function asPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface CompactModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

// Claude's SDK reports a per-model token breakdown on the turn result (subagent
// models included). Persist a compact copy on the turn.completed activity so
// token stats can attribute multi-model turns exactly; cache reads/writes fold
// into inputTokens, matching how the adapters build context-window snapshots.
function compactTurnModelUsage(
  modelUsage: Record<string, unknown> | undefined,
): Record<string, CompactModelUsage> | undefined {
  if (!modelUsage) {
    return undefined;
  }
  const compact: Record<string, CompactModelUsage> = {};
  for (const [model, value] of Object.entries(modelUsage)) {
    const usage = asObject(value);
    if (!usage) {
      continue;
    }
    const inputTokens =
      (asPositiveFiniteNumber(usage.inputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheReadInputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheCreationInputTokens) ?? 0);
    const outputTokens = asPositiveFiniteNumber(usage.outputTokens) ?? 0;
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens <= 0) {
      continue;
    }
    compact[model] = { inputTokens, outputTokens, totalTokens };
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

// Convert session-configured Claude window labels into the max-token shape the web meter uses.
function buildConfiguredContextWindowPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "session.configured") {
    return undefined;
  }
  const config = asObject(event.payload.config);
  const configuredContextWindow = asString(config?.contextWindow)?.trim().toLowerCase();
  const maxTokens =
    asPositiveFiniteNumber(config?.contextWindow) ??
    (configuredContextWindow === "1m"
      ? 1_000_000
      : configuredContextWindow === "200k"
        ? 200_000
        : undefined);
  if (maxTokens === undefined) {
    return undefined;
  }
  return toActivityPayload({
    maxTokens,
    ...(configuredContextWindow ? { contextWindow: configuredContextWindow } : {}),
  });
}

function runtimePayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function rawRuntimeEventPayload(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const raw = asObject((event as { raw?: unknown }).raw);
  return asObject(raw?.payload);
}

function runtimeWarningSummary(event: Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>) {
  const nativeType = asString(rawRuntimeEventPayload(event)?.type);
  if (
    (event.provider === "opencode" || event.provider === "kilo") &&
    (nativeType === "session.next.retried" || nativeType === "session.status")
  ) {
    return event.provider === "opencode" ? "OpenCode retrying" : "Kilo retrying";
  }
  return "Runtime warning";
}

// Runtime warning rows should show the user-visible message even when raw detail is structured.
function runtimeWarningPayload(
  event: Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>,
): ActivityPayload {
  const message = truncateDetail(event.payload.message);
  const nativeType = asString(rawRuntimeEventPayload(event)?.type);
  return toActivityPayload({
    message,
    detail: message,
    ...(nativeType ? { nativeEventType: nativeType } : {}),
    ...activityDataField(event.payload.detail),
  });
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const payloadState = asString(runtimePayloadRecord(event)?.state);
  return normalizeRuntimeTurnState(payloadState);
}

function runtimeTurnErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  const payloadErrorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
  return payloadErrorMessage;
}

function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
}

function resolveTerminalTurnId(
  event: ProviderRuntimeEvent,
  activeTurnId: TurnId | null,
): TurnId | undefined {
  const eventTurnId = toTurnId(event.turnId);
  if (eventTurnId !== undefined) {
    return eventTurnId;
  }
  if (activeTurnId !== null && (event.type === "turn.completed" || event.type === "turn.aborted")) {
    // Some stop/interruption notifications omit the turn id even though they
    // still target the active turn currently tracked by the session.
    return activeTurnId;
  }
  return undefined;
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "session.configured": {
      const payload = buildConfiguredContextWindowPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.configured",
          summary: "Context window configured",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: toActivityPayload({
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: toActivityPayload({
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event);
      if (!message) {
        return [];
      }
      const errorClass = asString(runtimePayloadRecord(event)?.class);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Provider runtime error",
          payload: toActivityPayload({
            message: truncateDetail(message, 500),
            ...(errorClass ? { class: errorClass } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: runtimeWarningSummary(event),
          payload: runtimeWarningPayload(event),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.tasks.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.tasks.updated",
          summary: "Tasks updated",
          payload: toActivityPayload({
            tasks: event.payload.tasks,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: toActivityPayload({
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: toActivityPayload({
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted manually",
          payload: toActivityPayload({
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (event.payload.itemType === "context_compaction") {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "context-compaction",
            summary: "Compacting conversation...",
            payload: toActivityPayload({
              itemType: event.payload.itemType,
              status: event.payload.status,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
              ...activityDataField(event.payload.data),
            }),
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: toActivityPayload({
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...activityDataField(event.payload.data),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      // Providers (Grok auto-compaction, Pi compaction_end) close their
      // compaction rows via item.completed; without this branch the earlier
      // "Compacting conversation..." activity never resolves.
      if (event.payload.itemType === "context_compaction") {
        const failed = event.payload.status === "failed";
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: failed ? "error" : "info",
            kind: "context-compaction",
            summary: failed ? "Context compaction failed" : "Context compacted",
            payload: toActivityPayload({
              itemType: event.payload.itemType,
              status: event.payload.status,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
              ...activityDataField(event.payload.data),
            }),
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: toActivityPayload({
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...activityDataField(event.payload.data),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: toActivityPayload({
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...activityDataField(event.payload.data),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.toolName ?? event.payload.summary ?? "MCP tool call",
          payload: buildToolProgressActivityPayload(event),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.completed": {
      const state = runtimeTurnState(event);
      const modelUsage = compactTurnModelUsage(event.payload.modelUsage);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: state === "failed" ? "error" : "info",
          kind: "turn.completed",
          summary: state === "failed" ? "Turn failed" : "Turn completed",
          payload: toActivityPayload({
            state,
            ...(modelUsage ? { modelUsage } : {}),
            ...(typeof event.payload.totalCostUsd === "number"
              ? { totalCostUsd: event.payload.totalCostUsd }
              : {}),
            ...(typeof event.payload.cumulativeCostUsd === "number"
              ? { cumulativeCostUsd: event.payload.cumulativeCostUsd }
              : {}),
            ...(runtimeTurnErrorMessage(event)
              ? { errorMessage: runtimeTurnErrorMessage(event) }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "account.rate-limits.updated": {
      const rawRateLimits = event.payload.rateLimits;
      if (!rawRateLimits || typeof rawRateLimits !== "object") {
        return [];
      }
      const rl = rawRateLimits as Record<string, unknown>;
      if (Object.keys(rl).length === 0) {
        return [];
      }
      const status = rl.status;
      // Normalize resetsAt: Claude SDK sends Unix seconds (number), Codex may send ISO string
      const resetsAtRaw = rl.resetsAt;
      const resetsAt =
        typeof resetsAtRaw === "number"
          ? new Date(resetsAtRaw * 1000).toISOString()
          : typeof resetsAtRaw === "string"
            ? resetsAtRaw
            : undefined;
      // Preserve per-window rate limit breakdown when the provider sends it.
      // Claude SDK may include a `limits` array with per-window entries
      // (e.g. { window: "5h", utilization: 0.06, resetsAt: ... }).
      const rawLimits = Array.isArray(rl.limits) ? rl.limits : undefined;
      const limits = rawLimits
        ?.filter(
          (l): l is Record<string, unknown> =>
            l !== null &&
            typeof l === "object" &&
            typeof (l as Record<string, unknown>).window === "string",
        )
        .map((l) => {
          const lResetsAtRaw = l.resetsAt;
          const lResetsAt =
            typeof lResetsAtRaw === "number"
              ? new Date(lResetsAtRaw * 1000).toISOString()
              : typeof lResetsAtRaw === "string"
                ? lResetsAtRaw
                : undefined;
          const limit = { window: l.window as string } as {
            window: string;
            utilization?: number;
            resetsAt?: string;
          };
          if (typeof l.utilization === "number") {
            limit.utilization = l.utilization;
          }
          if (lResetsAt) {
            limit.resetsAt = lResetsAt;
          }
          return limit;
        });
      const normalizedPayload = {
        provider: event.provider,
        ...rl,
        ...(resetsAt ? { resetsAt } : {}),
        ...(typeof rl.utilization === "number" ? { utilization: rl.utilization } : {}),
        ...(limits && limits.length > 0 ? { limits } : {}),
      };
      const activities: OrchestrationThreadActivity[] = [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "account.rate-limits.updated",
          summary: "Rate limits updated",
          payload: toActivityPayload(normalizedPayload),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
      if (status !== "rejected" && status !== "allowed_warning") {
        return activities;
      }
      return [
        ...activities,
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: (status === "rejected" ? "error" : "info") as "error" | "info",
          kind: "account.rate-limited",
          summary: status === "rejected" ? "Rate limited" : "Approaching rate limit",
          payload: toActivityPayload({
            ...normalizedPayload,
            status,
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });
  const bufferedToolOutputByKey = yield* Cache.make<string, BufferedToolOutput | undefined>({
    capacity: BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_TOOL_OUTPUT_BY_KEY_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  const providerDiffPlaceholdersRef = yield* Ref.make(new Map<string, ProviderDiffPlaceholder>());

  const getThreadDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  // PERF: cheap counterpart to getThreadDetail for events that never read the
  // heavy thread arrays. Loads only the shell projection and promotes it with
  // empty arrays. See eventNeedsHeavyThreadDetail.
  const getThreadShellDetail = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<OrchestrationThread | undefined> {
    const shell = Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
    return shell ? threadDetailFromShell(shell) : undefined;
  });

  const getProjectShell = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId">,
  ): Effect.fn.Return<OrchestrationProjectShell | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* getThreadDetail(threadId);
    if (!thread) {
      return false;
    }
    const project = yield* getProjectShell(thread);
    if (!project) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: [project],
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const supportsLiveTurnDiffPatch = Effect.fnUntraced(function* (
    provider: ProviderRuntimeEvent["provider"],
  ) {
    const capabilities = yield* providerService
      .getCapabilities(provider)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return capabilities?.supportsLiveTurnDiffPatch === true;
  });

  const clearProviderDiffPlaceholder = (threadId: ThreadId, turnId: TurnId) =>
    Ref.update(providerDiffPlaceholdersRef, (placeholders) => {
      const next = new Map(placeholders);
      next.delete(providerTurnKey(threadId, turnId));
      return next;
    });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: appendCappedBufferedText(
            existing?.text ?? "",
            delta,
            MAX_BUFFERED_PROPOSED_PLAN_CHARS,
          ),
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const appendBufferedToolOutput = (key: string, delta: string) =>
    Cache.getOption(bufferedToolOutputByKey, key).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        const existingText = existing?.text ?? "";
        const truncated = existingText.length + delta.length > MAX_BUFFERED_TOOL_OUTPUT_CHARS;
        return Cache.set(bufferedToolOutputByKey, key, {
          text: appendCappedBufferedText(existingText, delta, MAX_BUFFERED_TOOL_OUTPUT_CHARS),
          truncated: existing?.truncated === true || truncated,
        });
      }),
    );

  const getBufferedToolOutput = (key: string) =>
    Cache.getOption(bufferedToolOutputByKey, key).pipe(
      Effect.map((existingEntry) => Option.getOrUndefined(existingEntry)),
    );

  const takeBufferedToolOutput = (key: string) =>
    Cache.getOption(bufferedToolOutputByKey, key).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedToolOutputByKey, key).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const resolveAssistantCompletionMessageId = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (input.turnId) {
        const knownAssistantMessageIds = yield* getAssistantMessageIdsForTurn(
          input.thread.id,
          input.turnId,
        );
        if (input.event.itemId) {
          const eventMessageId = MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
          if (knownAssistantMessageIds.has(eventMessageId)) {
            return eventMessageId;
          }
        }
        if (knownAssistantMessageIds.size === 1) {
          const [onlyMessageId] = knownAssistantMessageIds;
          if (onlyMessageId) {
            return onlyMessageId;
          }
        }
        if (knownAssistantMessageIds.size > 1) {
          const preferredKnownMessage = input.thread.messages
            .filter(
              (message: OrchestrationThread["messages"][number]) =>
                message.role === "assistant" &&
                message.turnId === input.turnId &&
                knownAssistantMessageIds.has(message.id),
            )
            .toSorted(
              (
                left: OrchestrationThread["messages"][number],
                right: OrchestrationThread["messages"][number],
              ) => {
                if (left.streaming !== right.streaming) {
                  return left.streaming ? -1 : 1;
                }
                return (
                  right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
                );
              },
            )[0];
          if (preferredKnownMessage) {
            return preferredKnownMessage.id;
          }
        }
        return input.event.itemId
          ? MessageId.makeUnsafe(`assistant:${input.event.itemId}`)
          : MessageId.makeUnsafe(`assistant:${input.turnId}`);
      }

      if (input.event.itemId) {
        return MessageId.makeUnsafe(`assistant:${input.event.itemId}`);
      }

      return MessageId.makeUnsafe(`assistant:${input.event.eventId}`);
    });

  const flushBufferedAssistantMessageDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      for (const assistantMessageId of assistantMessageIds) {
        yield* flushBufferedAssistantMessageDelta({
          event: input.event,
          threadId: input.threadId,
          messageId: assistantMessageId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
        });
      }
    });

  const finalizeBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      yield* Effect.forEach(
        assistantMessageIds,
        (assistantMessageId) =>
          finalizeAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId: assistantMessageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
            finalDeltaCommandTag: input.finalDeltaCommandTag,
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* clearAssistantMessageIdsForTurn(input.threadId, input.turnId);
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (hasRenderableAssistantText(text)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  const appendGeneratedImageReference = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    imagePath: string;
    turnId?: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const markdown = generatedImageMarkdown(input.imagePath);
      const messages = input.thread.messages;
      const sameItemMessageId = input.event.itemId
        ? MessageId.makeUnsafe(`assistant:${input.event.itemId}`)
        : undefined;
      const sameItemMessage = sameItemMessageId
        ? messages.find(
            (message) => message.role === "assistant" && message.id === sameItemMessageId,
          )
        : undefined;
      const sameImageMessage = messages.find(
        (message) =>
          message.role === "assistant" &&
          (message.text.includes(input.imagePath) || message.text.includes(markdown)),
      );
      const finalTurnMessage = input.turnId
        ? messages
            .filter(
              (message) =>
                message.role === "assistant" &&
                message.turnId === input.turnId &&
                !message.streaming &&
                message.text.trim().length > 0 &&
                !isGeneratedImageOnlyMarkdown(message.text),
            )
            .toSorted(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
            )[0]
        : undefined;
      const existingMessage = sameItemMessage ?? sameImageMessage ?? finalTurnMessage;
      const targetMessageId =
        existingMessage?.id ??
        MessageId.makeUnsafe(`assistant:image:${input.event.itemId ?? input.event.eventId}`);
      const targetMessageText = existingMessage?.text ?? "";
      const targetIsStreaming = existingMessage?.streaming ?? false;
      const alreadyContainsImage =
        targetMessageText.includes(input.imagePath) || targetMessageText.includes(markdown);

      let dispatchedDelta = false;
      if (!alreadyContainsImage) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, "generated-image-delta"),
          threadId: input.thread.id,
          messageId: targetMessageId,
          delta: targetMessageText.trim().length > 0 ? `\n\n${markdown}` : markdown,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
        dispatchedDelta = true;
      }

      // Only finalize when we actually changed the message (delta dispatched, or we
      // just created a brand-new image-only message), or when the existing target was
      // still streaming. Skipping complete on already-finalized targets keeps replays
      // and duplicate provider notifications from emitting redundant message-sent events.
      const shouldComplete = dispatchedDelta || !existingMessage || targetIsStreaming;
      if (shouldComplete) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, "generated-image-complete"),
          threadId: input.thread.id,
          messageId: targetMessageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.activeTurnId;
  });

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fnUntraced(function* (
    sourceThreadId: ThreadId,
    sourcePlanId: OrchestrationProposedPlanId,
    implementationThreadId: ThreadId,
    implementedAt: string,
  ) {
    const sourceThread = yield* getThreadDetail(sourceThreadId);
    const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.makeUnsafe(
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
      ),
      threadId: sourceThread.id,
      proposedPlan: {
        ...sourcePlan,
        implementedAt,
        implementationThreadId,
        updatedAt: implementedAt,
      },
      createdAt: implementedAt,
    });
  });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const now = event.createdAt;
      // Load the full (heavy) detail only when this event's handlers actually read
      // thread.messages / proposedPlans / checkpoints; otherwise use the cheap
      // shell so high-frequency streaming events don't re-decode the whole
      // transcript. See eventNeedsHeavyThreadDetail for the safety rationale.
      const needsHeavyThreadDetail = eventNeedsHeavyThreadDetail(event);
      const parentThread = needsHeavyThreadDetail
        ? yield* getThreadDetail(event.threadId)
        : yield* getThreadShellDetail(event.threadId);
      if (!parentThread) return;

      const ensureSubagentThread = (
        providerThreadId: string,
        identity?: Pick<
          SubagentIdentity,
          "agentId" | "nickname" | "role" | "model" | "modelIsRequestedHint"
        >,
      ) =>
        Effect.gen(function* () {
          const childThreadId = subagentThreadId(parentThread.id, providerThreadId);
          // A single provider event can describe the child both as a collab receiver and
          // as the event's provider thread, so re-read after any earlier dispatch in this handler.
          // Mirror the parent load: only this event's heavy-detail handlers read the
          // child's message/plan/checkpoint arrays, so otherwise use the cheap shell.
          const existingThread = needsHeavyThreadDetail
            ? yield* projectionSnapshotQuery.getThreadDetailById(childThreadId)
            : Option.map(
                yield* projectionSnapshotQuery.getThreadShellById(childThreadId),
                threadDetailFromShell,
              );
          const resolvedModelSelection =
            identity?.model && identity.modelIsRequestedHint !== true
              ? {
                  provider: parentThread.modelSelection.provider,
                  model: identity.model,
                }
              : undefined;

          if (Option.isNone(existingThread)) {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: providerCommandId(event, "subagent-thread-create"),
              threadId: childThreadId,
              projectId: parentThread.projectId,
              title: subagentThreadTitle({
                nickname: identity?.nickname,
                role: identity?.role,
                providerThreadId,
              }),
              modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
              runtimeMode: parentThread.runtimeMode,
              interactionMode: parentThread.interactionMode,
              envMode: parentThread.envMode,
              branch: parentThread.branch,
              worktreePath: parentThread.worktreePath,
              associatedWorktreePath: parentThread.associatedWorktreePath,
              associatedWorktreeBranch: parentThread.associatedWorktreeBranch,
              associatedWorktreeRef: parentThread.associatedWorktreeRef,
              parentThreadId: parentThread.id,
              subagentAgentId: identity?.agentId ?? null,
              subagentNickname: identity?.nickname ?? null,
              subagentRole: identity?.role ?? null,
              createdAt: now,
            });
          } else {
            const existingThreadShell = existingThread.value;
            if (
              identity?.agentId !== undefined ||
              identity?.nickname !== undefined ||
              identity?.role !== undefined ||
              (identity?.model !== undefined && identity.modelIsRequestedHint !== true)
            ) {
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: providerCommandId(event, "subagent-thread-meta-update"),
                threadId: childThreadId,
                ...(identity?.nickname !== undefined || identity?.role !== undefined
                  ? {
                      title: subagentThreadTitle({
                        nickname:
                          identity?.nickname ?? existingThreadShell.subagentNickname ?? undefined,
                        role: identity?.role ?? existingThreadShell.subagentRole ?? undefined,
                        providerThreadId,
                      }),
                    }
                  : {}),
                parentThreadId: parentThread.id,
                ...(resolvedModelSelection !== undefined &&
                existingThreadShell.modelSelection.model !== resolvedModelSelection.model
                  ? { modelSelection: resolvedModelSelection }
                  : {}),
                ...(identity?.agentId !== undefined ? { subagentAgentId: identity.agentId } : {}),
                ...(identity?.nickname !== undefined
                  ? { subagentNickname: identity.nickname }
                  : {}),
                ...(identity?.role !== undefined ? { subagentRole: identity.role } : {}),
              });
            }
          }

          return {
            threadId: childThreadId,
            thread: Option.match(existingThread, {
              onSome: (thread) => thread,
              onNone: () => ({
                ...parentThread,
                id: childThreadId,
                title: subagentThreadTitle({
                  nickname: identity?.nickname,
                  role: identity?.role,
                  providerThreadId,
                }),
                parentThreadId: parentThread.id,
                subagentAgentId: identity?.agentId ?? null,
                subagentNickname: identity?.nickname ?? null,
                subagentRole: identity?.role ?? null,
                modelSelection: resolvedModelSelection ?? parentThread.modelSelection,
                latestTurn: null,
                messages: [],
                proposedPlans: [],
                activities: [],
                checkpoints: [],
                session: null,
                createdAt: now,
                updatedAt: now,
              }),
            }),
          };
        });

      const collabPayload = extractCollabPayload(event);
      const collabItem = asObject(collabPayload?.item) ?? collabPayload;
      const isCollabToolEvent =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "collab_agent_tool_call" &&
        collabItem !== undefined;
      if (isCollabToolEvent && collabItem) {
        const receiverThreadIds = collectSubagentProviderThreadIds(collabItem);
        const identityDirectory = buildSubagentIdentityDirectory(
          extractSubagentIdentityHints(collabItem),
        );
        for (const receiverThreadId of receiverThreadIds) {
          yield* ensureSubagentThread(
            receiverThreadId,
            resolveSubagentIdentityFromDirectory(identityDirectory, {
              providerThreadId: receiverThreadId,
            }) as SubagentIdentity | undefined,
          );
        }
      }

      const providerThreadId = normalizeIdentifier(event.providerRefs?.providerThreadId);
      const providerParentThreadId = normalizeIdentifier(
        event.providerRefs?.providerParentThreadId,
      );
      const isChildThreadEvent =
        providerThreadId !== undefined &&
        providerParentThreadId !== undefined &&
        providerThreadId !== providerParentThreadId;
      const targetThreadResolution =
        isChildThreadEvent && providerThreadId
          ? yield* ensureSubagentThread(
              providerThreadId,
              extractSubagentIdentity(event, providerThreadId),
            )
          : { threadId: parentThread.id, thread: parentThread };
      const thread = targetThreadResolution.thread;
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const eventTurnId = resolveTerminalTurnId(event, activeTurnId);
      const isTerminalTurnEvent = event.type === "turn.completed" || event.type === "turn.aborted";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : isTerminalTurnEvent ||
                event.type === "session.exited" ||
                (event.type === "session.state.changed" &&
                  (event.payload.state === "ready" ||
                    event.payload.state === "stopped" ||
                    event.payload.state === "error"))
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed" ? "error" : "ready";
            case "turn.aborted":
              return "interrupted";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready" || status === "interrupted"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "user-input.resolved") {
        const inferredRuntimeMode = inferRuntimeModeFromUserInputAnswers(event.payload.answers);
        if (inferredRuntimeMode && inferredRuntimeMode !== thread.runtimeMode) {
          yield* orchestrationEngine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: providerCommandId(event, "thread-runtime-mode-set"),
            threadId: thread.id,
            runtimeMode: inferredRuntimeMode,
            createdAt: now,
          });
        }
      }

      const toolOutputKind = toolOutputStreamKind(event);
      const toolOutputKey = toolOutputBufferKey(event);
      if (
        toolOutputKind &&
        toolOutputKey &&
        event.type === "content.delta" &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedToolOutput(toolOutputKey, event.payload.delta);
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* resolveAssistantCompletionMessageId({
          event,
          thread,
          ...(turnId ? { turnId } : {}),
        });
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
          ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
            ? { fallbackText: assistantCompletion.fallbackText }
            : {}),
        });

        if (turnId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      const generatedImagePath = generatedImagePathFromRuntimeEvent(event);
      if (generatedImagePath) {
        const generatedImageTurnId = toTurnId(event.turnId) ?? activeTurnId ?? undefined;
        yield* appendGeneratedImageReference({
          event,
          thread,
          imagePath: generatedImagePath,
          ...(generatedImageTurnId ? { turnId: generatedImageTurnId } : {}),
          createdAt: now,
        });
      }

      if (isTerminalTurnEvent) {
        const finalizedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (finalizedTurnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
            thread.id,
            finalizedTurnId,
          );
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId: finalizedTurnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, finalizedTurnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: thread.proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, finalizedTurnId),
            turnId: finalizedTurnId,
            updatedAt: now,
          });
          yield* clearProviderDiffPlaceholder(thread.id, finalizedTurnId);
        }
      }

      if (event.type === "session.exited") {
        const exitedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (exitedTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: exitedTurnId,
            createdAt: now,
            commandTag: "assistant-complete-session-exit",
            finalDeltaCommandTag: "assistant-delta-session-exit",
          });
          yield* clearProviderDiffPlaceholder(thread.id, exitedTurnId);
        }
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";
        const erroredTurnId = eventTurnId ?? activeTurnId ?? undefined;

        if (erroredTurnId) {
          yield* finalizeBufferedAssistantMessagesForTurn({
            event,
            threadId: thread.id,
            turnId: erroredTurnId,
            createdAt: now,
            commandTag: "assistant-complete-runtime-error",
            finalDeltaCommandTag: "assistant-delta-runtime-error",
          });
          yield* clearProviderDiffPlaceholder(thread.id, erroredTurnId);
        }

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId && (yield* isGitRepoForThread(thread.id))) {
          const existingCheckpoint = thread.checkpoints.find((c) => c.turnId === turnId);
          const placeholderKey = providerTurnKey(thread.id, turnId);
          const trackedPlaceholder = (yield* Ref.get(providerDiffPlaceholdersRef)).get(
            placeholderKey,
          );
          const existingProviderPlaceholder =
            existingCheckpoint?.checkpointRef.startsWith("provider-diff:") === true
              ? {
                  checkpointRef: existingCheckpoint.checkpointRef,
                  checkpointTurnCount: existingCheckpoint.checkpointTurnCount,
                  files: existingCheckpoint.files,
                }
              : null;
          // Only provider-diff placeholders are live-updated. A real checkpoint from
          // CheckpointReactor is the terminal turn diff and must stay authoritative.
          if (existingCheckpoint && !existingProviderPlaceholder) {
            yield* clearProviderDiffPlaceholder(thread.id, turnId);
          } else {
            const canParseLiveDiffPatch = yield* supportsLiveTurnDiffPatch(event.provider);
            const livePlaceholder = trackedPlaceholder ?? existingProviderPlaceholder;
            const maxTurnCount = thread.checkpoints.reduce(
              (max, c) => Math.max(max, c.checkpointTurnCount),
              0,
            );
            const files =
              (canParseLiveDiffPatch
                ? parseProviderTurnDiffFiles(event.payload.unifiedDiff)
                : null) ??
              trackedPlaceholder?.files ??
              existingCheckpoint?.files ??
              [];
            const checkpointRef =
              livePlaceholder?.checkpointRef ??
              CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`);
            const checkpointTurnCount = livePlaceholder?.checkpointTurnCount ?? maxTurnCount + 1;
            // Leave assistantMessageId undefined on the placeholder: the real
            // capture performed by CheckpointReactor will resolve the actual
            // assistant MessageId once the message is finalized. Emitting a
            // synthetic id here would leak an incorrect key that can collide
            // across turns and cause the diff card to render on the wrong row.
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef,
              status: "missing",
              files,
              assistantMessageId: undefined,
              checkpointTurnCount,
              createdAt: now,
            });
            if (canParseLiveDiffPatch) {
              yield* Ref.update(providerDiffPlaceholdersRef, (placeholders) => {
                const next = new Map(placeholders);
                next.set(placeholderKey, {
                  checkpointRef,
                  checkpointTurnCount,
                  files,
                });
                return next;
              });
            }
          }
        }
      }

      const activityEvent =
        event.type === "item.completed" && toolOutputKey
          ? withBufferedToolOutputData(event, yield* takeBufferedToolOutput(toolOutputKey))
          : event.type === "item.updated" && toolOutputKey
            ? withBufferedToolOutputData(event, yield* getBufferedToolOutput(toolOutputKey))
            : event;
      const activities = runtimeEventToActivities(activityEvent);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Effect.gen(function* () {
      const nextAssistantDeliveryMode =
        event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE;
      yield* Ref.set(assistantDeliveryModeRef, nextAssistantDeliveryMode);
      if (nextAssistantDeliveryMode !== "streaming") {
        return;
      }

      const thread = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId),
      );
      const activeTurnId = thread?.session?.activeTurnId ?? undefined;
      if (!activeTurnId) {
        return;
      }

      const flushEvent: ProviderRuntimeEvent = {
        type: "turn.started",
        eventId: event.eventId,
        provider: thread?.session?.providerName === "claudeAgent" ? "claudeAgent" : "codex",
        createdAt: event.payload.createdAt,
        threadId: event.payload.threadId,
        turnId: activeTurnId,
        payload: {},
      };
      yield* flushBufferedAssistantMessagesForTurn({
        event: flushEvent,
        threadId: event.payload.threadId,
        turnId: activeTurnId,
        createdAt: event.payload.createdAt,
        commandTag: "assistant-delta-domain-flush",
      });
    });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
