import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@synara/contracts";
import { Cache, Cause, Deferred, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@synara/shared/subagents";

import {
  generatedImageMarkdown,
  generatedImagePathFromRuntimeEvent,
  isCodexGeneratedImageArtifact,
} from "../../codexGeneratedImages.ts";
import { copyAndAttributeStudioGeneratedImage } from "../../studioGeneratedImages.ts";
import { parseCheckpointFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "../../provider/terminalTurnApplicability.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionGeneratedImageActivityRecord,
} from "../Services/ProjectionSnapshotQuery.ts";
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
const providerCommandId = (event: ProviderRuntimeEvent, tag: string, target = "event"): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${target}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const PROVIDER_RUNTIME_INGESTION_CAPACITY = 1_024;
const PROVIDER_RUNTIME_REPLAY_PAGE_SIZE = 128;
const PROVIDER_RUNTIME_REPLAY_POLL_INTERVAL = Duration.millis(250);
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 2_048;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(60);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 1_024;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(60);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 1_024;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(60);
const BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY = 2_048;
const BUFFERED_TOOL_OUTPUT_BY_KEY_TTL = Duration.minutes(60);
const BUFFERED_REASONING_SUMMARY_BY_KEY_CACHE_CAPACITY = 2_048;
const BUFFERED_REASONING_SUMMARY_BY_KEY_TTL = Duration.minutes(60);
const PENDING_GENERATED_IMAGES_CACHE_CAPACITY = 512;
// Hot-path cache only. Turn settlement also reads durable activity records, so
// TTL expiry or a server restart cannot discard the transcript reference.
const PENDING_GENERATED_IMAGES_TTL = Duration.minutes(60);
const ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY = 4_096;
const ACTIVITY_UPDATE_FINGERPRINT_TTL = Duration.minutes(360);
const ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY = 2_048;
const ASSISTANT_DELIVERY_MODE_BY_TURN_TTL = Duration.minutes(60);
// One turn realistically produces a handful of images; the cap only bounds a
// pathological provider replaying image completions in a loop.
const MAX_PENDING_GENERATED_IMAGES_PER_TURN = 32;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_PROPOSED_PLAN_CHARS = 64_000;
const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 24_000;
const MAX_BUFFERED_REASONING_SUMMARY_CHARS = 8_000;
const MAX_BUFFERED_REASONING_SUMMARY_PARTS = 24;
const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;
const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";
const BUFFERED_TEXT_TRUNCATION_MARKER = "... [truncated]";
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.SYNARA_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type RuntimeIngestionDomainEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-start-requested" | "thread.reverted" | "thread.conversation-rolled-back";
  }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      sequence: number;
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: RuntimeIngestionDomainEvent;
    };

type ActivityPayload = OrchestrationThreadActivity["payload"];
type BufferedToolOutput = {
  readonly text: string;
  readonly truncated: boolean;
};
type BufferedReasoningSummary = {
  readonly parts: ReadonlyMap<number, string>;
  readonly sourceEvent: Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;
};
type AssistantDeliveryModeBindingState = {
  readonly pendingModesByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<AssistantDeliveryMode>>;
  readonly unmatchedTurnIdsByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<TurnId>>;
  readonly settledUnmatchedRequestDebtByThreadId: ReadonlyMap<ThreadId, number>;
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
  if (event.type === "item.completed") {
    // assistant_message completion reads thread.messages to decide whether to
    // apply fallback completion text; image_generation completion scans
    // thread.messages to attach the generated-image reference.
    return (
      event.payload.itemType === "assistant_message" ||
      generatedImagePathFromRuntimeEvent(event) !== undefined
    );
  }
  // Session exits and runtime errors flush the turn's pending generated images
  // into the terminal assistant message, which requires thread.messages.
  return (
    event.type === "turn.proposed.completed" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "turn.diff.updated" ||
    event.type === "session.exited" ||
    event.type === "runtime.error"
  );
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

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && left === right;
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

function reasoningSummaryBufferKey(
  event: ProviderRuntimeEvent,
  threadId = event.threadId,
): string | null {
  if (event.provider !== "codex" || !event.itemId) {
    return null;
  }
  if (event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text") {
    return [threadId, event.turnId ?? "no-turn", event.itemId].join(":");
  }
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType === "reasoning"
  ) {
    return [threadId, event.turnId ?? "no-turn", event.itemId].join(":");
  }
  return null;
}

function readableReasoningDetail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.replace(/<!--[\s\S]*?-->/gu, "").trim() ? trimmed : undefined;
}

function joinedBufferedReasoningSummary(
  summary: BufferedReasoningSummary | undefined,
): string | undefined {
  if (!summary) return undefined;
  return readableReasoningDetail(
    Array.from(summary.parts.entries())
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n"),
  );
}

function withBufferedReasoningSummary(
  event: ProviderRuntimeEvent,
  summary: BufferedReasoningSummary | undefined,
): ProviderRuntimeEvent {
  if (
    event.type !== "item.completed" ||
    event.provider !== "codex" ||
    event.payload.itemType !== "reasoning" ||
    readableReasoningDetail(event.payload.detail)
  ) {
    return event;
  }
  const bufferedDetail = joinedBufferedReasoningSummary(summary);
  if (!bufferedDetail) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      detail: bufferedDetail,
    },
  };
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

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
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
  return isJsonObject(value) ? value : undefined;
}

/**
 * Resolves persisted image tool records to their durable display paths. Studio
 * copies add a source -> workspace-path marker; non-Studio images keep the
 * provider artifact path. The query supplying these records is turn-scoped and
 * independent of the bounded thread-detail activity window.
 */
export function collectPersistedGeneratedImagePaths(
  records: ReadonlyArray<ProjectionGeneratedImageActivityRecord>,
): string[] {
  const studioDisplayPathBySourcePath = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== STUDIO_OUTPUTS_ACTIVITY_KIND) {
      continue;
    }
    const payload = asObject(record.payload);
    const data = asObject(payload?.data);
    const generatedImage = asObject(data?.generatedImage);
    const sourcePath = asString(generatedImage?.sourcePath)?.trim();
    const fullPath = asString(generatedImage?.fullPath)?.trim();
    if (sourcePath && fullPath) {
      studioDisplayPathBySourcePath.set(sourcePath, fullPath);
    }
  }

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  const representedSourcePaths = new Set<string>();
  const addPath = (path: string) => {
    if (!seenPaths.has(path)) {
      seenPaths.add(path);
      paths.push(path);
    }
  };

  for (const record of records) {
    if (record.kind !== "tool.completed") {
      continue;
    }
    const payload = asObject(record.payload);
    if (payload?.itemType !== "image_generation") {
      continue;
    }
    const artifact = isCodexGeneratedImageArtifact(payload.data) ? payload.data : undefined;
    if (!artifact) {
      continue;
    }
    representedSourcePaths.add(artifact.path);
    addPath(studioDisplayPathBySourcePath.get(artifact.path) ?? artifact.path);
  }

  // A Studio marker can survive even if a provider's corresponding tool row was
  // pruned or malformed. It is image-specific, so retaining the copied path is safe.
  for (const [sourcePath, fullPath] of studioDisplayPathBySourcePath) {
    if (!representedSourcePaths.has(sourcePath)) {
      addPath(fullPath);
    }
  }

  return paths;
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
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const state = asString(runtimePayloadRecord(event)?.state);
  return state === "failed" || state === "interrupted" || state === "cancelled"
    ? state
    : "completed";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  if (requestType === "command_execution_approval" || requestType === "exec_command_approval")
    return "command";
  if (requestType === "file_read_approval") return "file-read";
  return requestType === "file_change_approval" || requestType === "apply_patch_approval"
    ? "file-change"
    : undefined;
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
  // Codex only renders completed reasoning items with a readable summary.
  // Empty starts/completions are private/encrypted reasoning boundaries, not
  // transcript rows. Waiting for the authoritative completion also avoids
  // per-token activity writes and transcript height churn.
  if (
    event.provider === "codex" &&
    event.type === "item.completed" &&
    event.payload.itemType === "reasoning" &&
    event.itemId !== undefined &&
    readableReasoningDetail(event.payload.detail) !== undefined
  ) {
    const reasoningItemId = String(event.itemId);
    const reasoningDetail = readableReasoningDetail(event.payload.detail)!;
    return [
      {
        id: EventId.makeUnsafe(`provider-reasoning:${event.threadId}:${reasoningItemId}`),
        createdAt: event.createdAt,
        tone: "tool",
        kind: "task.progress",
        summary: "Reasoning trace",
        payload: toActivityPayload({
          ...(event.payload.status ? { status: event.payload.status } : {}),
          detail: truncateDetail(reasoningDetail, MAX_ACTIVITY_DATA_STRING_CHARS),
          data: { toolCallId: reasoningItemId },
        }),
        turnId: toTurnId(event.turnId) ?? null,
        ...maybeSequence,
      },
    ];
  }
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

    case "request.opened":
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
          kind: event.type === "request.opened" ? "approval.requested" : "approval.resolved",
          summary:
            event.type === "request.resolved"
              ? "Approval resolved"
              : requestKind === "command"
                ? "Command approval requested"
                : requestKind === "file-read"
                  ? "File-read approval requested"
                  : requestKind === "file-change"
                    ? "File-change approval requested"
                    : "Approval requested",
          payload: toActivityPayload({
            requestId:
              event.requestId === undefined
                ? undefined
                : ApprovalRequestId.makeUnsafe(event.requestId),
            ...(event.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: event.lifecycleGeneration }
              : {}),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.type === "request.opened" && event.payload.detail
              ? { detail: truncateDetail(event.payload.detail) }
              : {}),
            ...(event.type === "request.resolved" && event.payload.decision
              ? { decision: event.payload.decision }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const payload = runtimePayloadRecord(event);
      const message = asString(payload?.message);
      if (!message) {
        return [];
      }
      const errorClass = asString(payload?.class);
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
      const raw = asObject((event as { raw?: unknown }).raw);
      const nativeType = asString(asObject(raw?.payload)?.type);
      const message = truncateDetail(event.payload.message);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary:
            (event.provider === "opencode" || event.provider === "kilo") &&
            (nativeType === "session.next.retried" || nativeType === "session.status")
              ? event.provider === "opencode"
                ? "OpenCode retrying"
                : "Kilo retrying"
              : "Runtime warning",
          // Keep the user-visible message even when raw detail is structured.
          payload: toActivityPayload({
            message,
            detail: message,
            ...(nativeType ? { nativeEventType: nativeType } : {}),
            ...activityDataField(event.payload.detail),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "model.rerouted",
          summary: `Model switched: ${event.payload.fromModel} -> ${event.payload.toModel}`,
          payload: toActivityPayload({
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            detail: truncateDetail(event.payload.reason, 500),
          }),
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

    case "user-input.requested":
    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: event.type,
          summary:
            event.type === "user-input.requested" ? "User input requested" : "User input submitted",
          payload: toActivityPayload({
            ...(event.requestId ? { requestId: event.requestId } : {}),
            ...(event.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: event.lifecycleGeneration }
              : {}),
            ...(event.type === "user-input.requested"
              ? { questions: event.payload.questions }
              : { answers: event.payload.answers }),
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

    case "item.updated":
    case "item.completed":
    case "item.started": {
      if (event.type !== "item.started" && event.payload.itemType === "context_compaction") {
        const failed = event.type === "item.completed" && event.payload.status === "failed";
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: failed ? "error" : "info",
            kind: "context-compaction",
            summary:
              event.type === "item.updated"
                ? "Compacting conversation..."
                : failed
                  ? "Context compaction failed"
                  : "Context compacted",
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
          kind:
            event.type === "item.started"
              ? "tool.started"
              : event.type === "item.completed"
                ? "tool.completed"
                : "tool.updated",
          summary:
            event.type === "item.started"
              ? `${event.payload.title ?? "Tool"} started`
              : (event.payload.title ??
                (event.type === "item.completed" ? "Tool" : "Tool updated")),
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
      const errorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
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
            ...(errorMessage ? { errorMessage } : {}),
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

function activityUpdateDedupeKey(
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): string | undefined {
  const prefix = `${threadId}:${event.provider}:${activity.kind}`;
  if (
    activity.kind === "context-window.updated" ||
    activity.kind === "account.rate-limits.updated"
  ) {
    return prefix;
  }

  const payload = asObject(activity.payload);
  if (activity.kind === "task.progress") {
    const taskId = asString(payload?.taskId);
    return taskId ? `${prefix}:${taskId}` : undefined;
  }
  if (activity.kind !== "tool.updated") {
    return undefined;
  }

  const data = asObject(payload?.data);
  const toolUpdateId =
    event.itemId ??
    asString(data?.toolUseId) ??
    asString(data?.toolCallId) ??
    asString(data?.callId) ??
    asString(data?.callID);
  return toolUpdateId ? `${prefix}:${toolUpdateId}` : undefined;
}

function activityUpdateFingerprint(activity: OrchestrationThreadActivity): string {
  return stringifyJsonLike({
    kind: activity.kind,
    summary: activity.summary,
    payload: activity.payload,
    turnId: activity.turnId,
  });
}

const takeCached = <Key, Value>(cache: Cache.Cache<Key, Value>, key: Key) =>
  Cache.getOption(cache, key).pipe(
    Effect.flatMap((value) => Cache.invalidate(cache, key).pipe(Effect.as(value))),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const runtimeEvents = yield* ProviderRuntimeEventRepository;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const outstandingTurnIdsByThreadRef = yield* Ref.make<ReadonlyMap<ThreadId, ReadonlySet<TurnId>>>(
    new Map(),
  );

  const rememberOutstandingTurn = (threadId: ThreadId, turnId: TurnId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      const next = new Map(state);
      next.set(threadId, new Set([...(next.get(threadId) ?? []), turnId]));
      return next;
    });
  const forgetOutstandingTurn = (threadId: ThreadId, turnId: TurnId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      const current = state.get(threadId);
      if (!current?.has(turnId)) return state;
      const next = new Map(state);
      const remaining = new Set(current);
      remaining.delete(turnId);
      if (remaining.size === 0) next.delete(threadId);
      else next.set(threadId, remaining);
      return next;
    });
  const clearOutstandingTurns = (threadId: ThreadId) =>
    Ref.update(outstandingTurnIdsByThreadRef, (state) => {
      if (!state.has(threadId)) return state;
      const next = new Map(state);
      next.delete(threadId);
      return next;
    });

  // Match request modes and provider turn ids from either arrival direction.
  // Provider turns and domain events can race, and ProviderService permits more
  // than one outstanding send per thread, so neither a global mode nor the
  // session's generic active turn is a valid correlation key.
  const assistantDeliveryModeBindingsRef = yield* Ref.make<AssistantDeliveryModeBindingState>({
    pendingModesByThreadId: new Map(),
    unmatchedTurnIdsByThreadId: new Map(),
    settledUnmatchedRequestDebtByThreadId: new Map(),
  });
  const cloneAssistantDeliveryModeBindings = (state: AssistantDeliveryModeBindingState) => ({
    pendingModesByThreadId: new Map(state.pendingModesByThreadId),
    unmatchedTurnIdsByThreadId: new Map(state.unmatchedTurnIdsByThreadId),
    settledUnmatchedRequestDebtByThreadId: new Map(state.settledUnmatchedRequestDebtByThreadId),
  });
  const shiftThreadQueue = <Value>(
    queues: Map<ThreadId, ReadonlyArray<Value>>,
    threadId: ThreadId,
  ): Value | undefined => {
    const values = queues.get(threadId) ?? [];
    const value = values[0];
    if (value === undefined) return undefined;
    if (values.length === 1) queues.delete(threadId);
    else queues.set(threadId, values.slice(1));
    return value;
  };
  const assistantDeliveryModeByTurnKey = yield* Cache.make<string, AssistantDeliveryMode>({
    capacity: ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY,
    timeToLive: ASSISTANT_DELIVERY_MODE_BY_TURN_TTL,
    lookup: () => Effect.succeed(DEFAULT_ASSISTANT_DELIVERY_MODE),
  });

  const matchAssistantDeliveryModeRequest = (threadId: ThreadId, mode: AssistantDeliveryMode) =>
    Effect.gen(function* () {
      const matchedTurnId = yield* Ref.modify(assistantDeliveryModeBindingsRef, (state) => {
        const nextState = cloneAssistantDeliveryModeBindings(state);
        const {
          pendingModesByThreadId,
          unmatchedTurnIdsByThreadId,
          settledUnmatchedRequestDebtByThreadId,
        } = nextState;
        const settledRequestDebt = settledUnmatchedRequestDebtByThreadId.get(threadId) ?? 0;
        if (settledRequestDebt > 0) {
          if (settledRequestDebt === 1) {
            settledUnmatchedRequestDebtByThreadId.delete(threadId);
          } else {
            settledUnmatchedRequestDebtByThreadId.set(threadId, settledRequestDebt - 1);
          }
          return [undefined, nextState] as const;
        }
        const unmatchedTurnId = shiftThreadQueue(unmatchedTurnIdsByThreadId, threadId);
        if (!unmatchedTurnId) {
          pendingModesByThreadId.set(threadId, [
            ...(pendingModesByThreadId.get(threadId) ?? []),
            mode,
          ]);
        }
        return [unmatchedTurnId, nextState] as const;
      });
      if (matchedTurnId) {
        yield* Cache.set(
          assistantDeliveryModeByTurnKey,
          providerTurnKey(threadId, matchedTurnId),
          mode,
        );
      }
      return matchedTurnId;
    });

  const matchStartedTurnAssistantDeliveryMode = (
    threadId: ThreadId,
    turnId: TurnId,
    options: { readonly recordUnmatched?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const key = providerTurnKey(threadId, turnId);
      if (Option.isSome(yield* Cache.getOption(assistantDeliveryModeByTurnKey, key))) {
        return;
      }
      const mode = yield* Ref.modify(assistantDeliveryModeBindingsRef, (state) => {
        const nextState = cloneAssistantDeliveryModeBindings(state);
        const {
          pendingModesByThreadId,
          unmatchedTurnIdsByThreadId,
          settledUnmatchedRequestDebtByThreadId,
        } = nextState;
        const pendingMode = shiftThreadQueue(pendingModesByThreadId, threadId);
        if (pendingMode === undefined) {
          if (options.recordUnmatched === false) {
            // A turn observed before its request may already be waiting on the
            // unmatched side. Once that exact turn terminates it must not be
            // claimable by a later, unrelated request.
            const unmatchedTurnIds = unmatchedTurnIdsByThreadId.get(threadId) ?? [];
            const remainingTurnIds = unmatchedTurnIds.filter(
              (unmatchedTurnId) => unmatchedTurnId !== turnId,
            );
            if (remainingTurnIds.length === 0) {
              unmatchedTurnIdsByThreadId.delete(threadId);
            } else if (remainingTurnIds.length !== unmatchedTurnIds.length) {
              unmatchedTurnIdsByThreadId.set(threadId, remainingTurnIds);
            }
            if (remainingTurnIds.length !== unmatchedTurnIds.length) {
              settledUnmatchedRequestDebtByThreadId.set(
                threadId,
                (settledUnmatchedRequestDebtByThreadId.get(threadId) ?? 0) + 1,
              );
            }
            return [undefined, nextState] as const;
          }
          const unmatchedTurnIds = unmatchedTurnIdsByThreadId.get(threadId) ?? [];
          if (!unmatchedTurnIds.includes(turnId)) {
            unmatchedTurnIdsByThreadId.set(threadId, [...unmatchedTurnIds, turnId]);
          }
          return [undefined, nextState] as const;
        }
        return [pendingMode, nextState] as const;
      });
      if (mode) {
        yield* Cache.set(assistantDeliveryModeByTurnKey, key, mode);
      }
    });

  const getAssistantDeliveryMode = (threadId: ThreadId, turnId: TurnId | undefined) =>
    turnId
      ? Cache.getOption(assistantDeliveryModeByTurnKey, providerTurnKey(threadId, turnId)).pipe(
          Effect.map(Option.getOrElse(() => DEFAULT_ASSISTANT_DELIVERY_MODE)),
        )
      : Effect.succeed(DEFAULT_ASSISTANT_DELIVERY_MODE);

  const clearAssistantDeliveryModeBindingsForThread = (threadId: ThreadId) =>
    Ref.update(assistantDeliveryModeBindingsRef, (state) => {
      if (
        !state.pendingModesByThreadId.has(threadId) &&
        !state.unmatchedTurnIdsByThreadId.has(threadId) &&
        !state.settledUnmatchedRequestDebtByThreadId.has(threadId)
      ) {
        return state;
      }
      const nextState = cloneAssistantDeliveryModeBindings(state);
      nextState.pendingModesByThreadId.delete(threadId);
      nextState.unmatchedTurnIdsByThreadId.delete(threadId);
      nextState.settledUnmatchedRequestDebtByThreadId.delete(threadId);
      return nextState;
    });

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
  const bufferedReasoningSummaryByKey = yield* Cache.make<
    string,
    BufferedReasoningSummary | undefined
  >({
    capacity: BUFFERED_REASONING_SUMMARY_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_REASONING_SUMMARY_BY_KEY_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  // Display paths of generated images completed during a still-running turn, keyed by
  // providerTurnKey. Flushed into the turn's terminal assistant message when the turn
  // settles, so the visible final row owns the image instead of collapsed narration.
  const pendingGeneratedImagesByTurnKey = yield* Cache.make<string, ReadonlyArray<string>>({
    capacity: PENDING_GENERATED_IMAGES_CACHE_CAPACITY,
    timeToLive: PENDING_GENERATED_IMAGES_TTL,
    lookup: () => Effect.succeed([]),
  });
  const latestActivityUpdateFingerprintByKey = yield* Cache.make<string, string | undefined>({
    capacity: ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY,
    timeToLive: ACTIVITY_UPDATE_FINGERPRINT_TTL,
    lookup: () => Effect.succeed(undefined),
  });
  const providerDiffPlaceholdersRef = yield* Ref.make(new Map<string, ProviderDiffPlaceholder>());

  const dispatchActivityUpdate = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    activity: OrchestrationThreadActivity,
  ) {
    const key = activityUpdateDedupeKey(event, threadId, activity);
    const fingerprint = key ? activityUpdateFingerprint(activity) : undefined;
    if (key && fingerprint) {
      const previous = yield* Cache.getOption(latestActivityUpdateFingerprintByKey, key);
      if (Option.isSome(previous) && previous.value === fingerprint) {
        return;
      }
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: providerCommandId(
        event,
        "thread-activity-append",
        `${threadId}:${activity.kind}:${activity.id}`,
      ),
      threadId,
      activity,
      createdAt: activity.createdAt,
    });
    if (key && fingerprint) {
      yield* Cache.set(latestActivityUpdateFingerprintByKey, key, fingerprint);
    }
  });

  const clearActivityUpdateFingerprints = Effect.fnUntraced(function* (threadId: ThreadId) {
    const keyPrefix = `${threadId}:`;
    yield* Effect.forEach(
      Array.from(yield* Cache.keys(latestActivityUpdateFingerprintByKey)),
      (key) =>
        key.startsWith(keyPrefix)
          ? Cache.invalidate(latestActivityUpdateFingerprintByKey, key)
          : Effect.void,
    );
  });

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
    takeCached(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.map(Option.getOrElse(() => "")),
    );

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
    takeCached(bufferedProposedPlanById, planId).pipe(Effect.map(Option.getOrUndefined));

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
    takeCached(bufferedToolOutputByKey, key).pipe(Effect.map(Option.getOrUndefined));

  const appendBufferedReasoningSummary = (
    key: string,
    event: Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>,
  ) =>
    Cache.getOption(bufferedReasoningSummaryByKey, key).pipe(
      Effect.flatMap((existingEntry) => {
        const summaryIndex = event.payload.summaryIndex ?? 0;
        const delta = event.payload.delta;
        if (
          summaryIndex < 0 ||
          summaryIndex >= MAX_BUFFERED_REASONING_SUMMARY_PARTS ||
          delta.length === 0
        ) {
          return Effect.void;
        }
        const existingSummary = Option.getOrUndefined(existingEntry);
        const parts = new Map(existingSummary?.parts ?? []);
        const existingPart = parts.get(summaryIndex) ?? "";
        const otherChars = Array.from(parts.entries()).reduce(
          (total, [index, text]) => total + (index === summaryIndex ? 0 : text.length),
          0,
        );
        const partLimit = Math.max(0, MAX_BUFFERED_REASONING_SUMMARY_CHARS - otherChars);
        if (partLimit === 0) {
          return Effect.void;
        }
        parts.set(summaryIndex, appendCappedBufferedText(existingPart, delta, partLimit));
        return Cache.set(bufferedReasoningSummaryByKey, key, {
          parts,
          sourceEvent: event,
        });
      }),
    );

  const takeBufferedReasoningSummary = (key: string) =>
    takeCached(bufferedReasoningSummaryByKey, key).pipe(Effect.map(Option.getOrUndefined));

  const settleBufferedReasoningSummaries = (
    threadId: ThreadId,
    terminalEvent: ProviderRuntimeEvent,
    turnId?: TurnId,
  ) => {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    const status =
      terminalEvent.type === "runtime.error" ||
      terminalEvent.type === "turn.aborted" ||
      (terminalEvent.type === "turn.completed" && terminalEvent.payload.state !== "completed") ||
      (terminalEvent.type === "session.exited" && terminalEvent.payload.exitKind === "error")
        ? "failed"
        : "completed";
    return Cache.keys(bufferedReasoningSummaryByKey).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          Array.from(keys).filter((key) => key.startsWith(prefix)),
          (key) =>
            takeBufferedReasoningSummary(key).pipe(
              Effect.flatMap((summary) => {
                const detail = joinedBufferedReasoningSummary(summary);
                if (!summary || !detail || !summary.sourceEvent.itemId) {
                  return Effect.void;
                }
                const completionEvent: ProviderRuntimeEvent = {
                  ...summary.sourceEvent,
                  eventId: EventId.makeUnsafe(
                    `${terminalEvent.eventId}:reasoning:${summary.sourceEvent.itemId}`,
                  ),
                  threadId,
                  type: "item.completed",
                  payload: {
                    itemType: "reasoning",
                    status,
                    title: "Reasoning",
                    detail,
                  },
                };
                return Effect.forEach(runtimeEventToActivities(completionEvent), (activity) =>
                  dispatchActivityUpdate(completionEvent, threadId, activity),
                ).pipe(Effect.asVoid);
              }),
            ),
        ).pipe(Effect.asVoid),
      ),
    );
  };

  const clearAssistantMessageState = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

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
        commandId: providerCommandId(input.event, input.commandTag, input.messageId),
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
      yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
        finalizeAssistantMessage({
          event: input.event,
          threadId: input.threadId,
          messageId: assistantMessageId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
          finalDeltaCommandTag: input.finalDeltaCommandTag,
        }),
      );
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
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag, input.messageId),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag, input.messageId),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  /**
   * Appends generated-image markdown to one explicit assistant message (creating it
   * when it does not exist yet) and finalizes it. Image markdown already present on
   * the target is skipped, so provider replays never duplicate references or re-emit
   * message-sent events for untouched, already-finalized targets.
   */
  const appendGeneratedImagesToAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    targetMessage:
      | Pick<OrchestrationThread["messages"][number], "id" | "text" | "streaming">
      | undefined;
    newMessageId: MessageId;
    imagePaths: ReadonlyArray<string>;
    turnId?: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const targetMessageId = input.targetMessage?.id ?? input.newMessageId;
      const targetMessageText = input.targetMessage?.text ?? "";
      const targetIsStreaming = input.targetMessage?.streaming ?? false;

      const missingMarkdown: string[] = [];
      for (const imagePath of input.imagePaths) {
        const markdown = generatedImageMarkdown(imagePath);
        if (
          targetMessageText.includes(imagePath) ||
          targetMessageText.includes(markdown) ||
          missingMarkdown.includes(markdown)
        ) {
          continue;
        }
        missingMarkdown.push(markdown);
      }

      let dispatchedDelta = false;
      if (missingMarkdown.length > 0) {
        const joined = missingMarkdown.join("\n\n");
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, "generated-image-delta", targetMessageId),
          threadId: input.threadId,
          messageId: targetMessageId,
          delta: targetMessageText.trim().length > 0 ? `\n\n${joined}` : joined,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
        dispatchedDelta = true;
      }

      // Only finalize when we actually changed the message (delta dispatched, or we
      // just created a brand-new image-only message), or when the existing target was
      // still streaming. Skipping complete on already-finalized targets keeps replays
      // and duplicate provider notifications from emitting redundant message-sent events.
      const shouldComplete = dispatchedDelta || !input.targetMessage || targetIsStreaming;
      if (shouldComplete) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, "generated-image-complete", targetMessageId),
          threadId: input.threadId,
          messageId: targetMessageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
    });

  const rememberPendingGeneratedImage = (threadId: ThreadId, turnId: TurnId, imagePath: string) =>
    Cache.getOption(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingPaths) => {
        const paths = Option.getOrElse(existingPaths, (): ReadonlyArray<string> => []);
        if (paths.includes(imagePath) || paths.length >= MAX_PENDING_GENERATED_IMAGES_PER_TURN) {
          return Effect.void;
        }
        return Cache.set(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId), [
          ...paths,
          imagePath,
        ]);
      }),
    );

  const takePendingGeneratedImages = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingPaths) =>
        Cache.invalidate(pendingGeneratedImagesByTurnKey, providerTurnKey(threadId, turnId)).pipe(
          Effect.as(Option.getOrElse(existingPaths, (): ReadonlyArray<string> => [])),
        ),
      ),
    );

  /**
   * Codex emits generated images as artifacts, so the turn's final assistant item is
   * often intentionally empty: the image IS the answer. Attaching images eagerly to
   * whatever narration exists mid-turn hands them to a message the settled-turn UI
   * collapses into the "Worked for…" disclosure, leaving the visible terminal row as
   * "(empty response)". Flushing at turn settle targets the actual terminal message
   * — including an empty one, whose body becomes the image markdown. Persisted
   * activity recovery complements the hot cache for long turns and restarts.
   */
  const flushPendingGeneratedImagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    turnId: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const cachedImagePaths = yield* takePendingGeneratedImages(input.thread.id, input.turnId);
      const persistedRecords = yield* projectionSnapshotQuery
        .listGeneratedImageActivitiesByTurn(input.thread.id, input.turnId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to recover persisted generated-image references", {
              threadId: input.thread.id,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as<ReadonlyArray<ProjectionGeneratedImageActivityRecord>>([])),
          ),
        );
      const imagePaths = [
        ...new Set([...cachedImagePaths, ...collectPersistedGeneratedImagePaths(persistedRecords)]),
      ];
      if (imagePaths.length === 0) {
        return;
      }
      // The terminal assistant message is the newest of the turn: the transcript UI
      // gives the last assistant row ownership of the settled turn and folds every
      // earlier assistant row, so this is the only row that stays visible.
      const terminalMessage = input.thread.messages
        .filter((message) => message.role === "assistant" && message.turnId === input.turnId)
        .toSorted(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        )[0];
      yield* appendGeneratedImagesToAssistantMessage({
        event: input.event,
        threadId: input.thread.id,
        targetMessage: terminalMessage,
        newMessageId: MessageId.makeUnsafe(`assistant:image:${input.turnId}`),
        imagePaths,
        turnId: input.turnId,
        createdAt: input.createdAt,
      });
    });

  /**
   * For Studio threads, copies a completed generated image into the thread's Studio
   * workspace (Outbox/Images) and appends direct output attribution. Returns null —
   * and must stay non-fatal — for non-Studio threads and on any copy failure, so the
   * transcript path falls back to the original Codex-home file.
   */
  const materializeStudioGeneratedImage = (input: {
    event: ProviderRuntimeEvent;
    thread: OrchestrationThread;
    imagePath: string;
    turnId: TurnId | undefined;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const project = yield* getProjectShell(input.thread);
      if (!project || project.kind !== "studio") {
        return null;
      }
      const workspaceRoot = resolveThreadWorkspaceCwd({
        thread: input.thread,
        projects: [project],
      });
      if (!workspaceRoot) {
        return null;
      }
      return yield* copyAndAttributeStudioGeneratedImage({
        orchestrationEngine,
        sourcePath: input.imagePath,
        workspaceRoot,
        threadId: input.thread.id,
        turnId: input.turnId,
        eventId: input.event.eventId,
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to copy generated image into Studio workspace", {
          threadId: input.thread.id,
          imagePath: input.imagePath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null));
      }),
    );

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
      const planMarkdown = normalizeNonEmptyString(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert", input.planId),
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
      const bufferedMarkdown = normalizeNonEmptyString(bufferedPlan?.text);
      const fallbackMarkdown = normalizeNonEmptyString(input.fallbackMarkdown);
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
      yield* Cache.invalidate(bufferedProposedPlanById, input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      yield* Effect.forEach(Array.from(yield* Cache.keys(turnMessageIdsByTurnKey)), (key) =>
        Effect.gen(function* () {
          if (!key.startsWith(prefix)) {
            return;
          }

          const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
          if (Option.isSome(messageIds)) {
            yield* Effect.forEach(messageIds.value, clearAssistantMessageState);
          }

          yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
        }),
      );
      yield* Effect.forEach(Array.from(yield* Cache.keys(bufferedProposedPlanById)), (key) =>
        key.startsWith(`plan:${threadId}:`)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      );
      yield* Effect.forEach(Array.from(yield* Cache.keys(pendingGeneratedImagesByTurnKey)), (key) =>
        key.startsWith(prefix)
          ? Cache.invalidate(pendingGeneratedImagesByTurnKey, key)
          : Effect.void,
      );
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

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = (yield* providerService.listSessions()).find(
      (entry) => entry.threadId === threadId,
    )?.activeTurnId;
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
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${sourcePlanId}`,
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
          const childThreadId = ThreadId.makeUnsafe(
            `subagent:${parentThread.id}:${providerThreadId}`,
          );
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
              commandId: providerCommandId(event, "subagent-thread-create", childThreadId),
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
                commandId: providerCommandId(event, "subagent-thread-meta-update", childThreadId),
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

      const providerThreadId = normalizeNonEmptyString(event.providerRefs?.providerThreadId);
      const providerParentThreadId = normalizeNonEmptyString(
        event.providerRefs?.providerParentThreadId,
      );
      const { thread } =
        providerThreadId !== undefined &&
        providerParentThreadId !== undefined &&
        providerThreadId !== providerParentThreadId
          ? yield* ensureSubagentThread(
              providerThreadId,
              extractSubagentIdentity(event, providerThreadId),
            )
          : { thread: parentThread };
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const isTerminalTurnEvent = event.type === "turn.completed" || event.type === "turn.aborted";
      const rawEventTurnId = toTurnId(event.turnId);
      if (event.type === "turn.started" && rawEventTurnId) {
        yield* rememberOutstandingTurn(thread.id, rawEventTurnId);
      }
      const terminalApplicability = isTerminalTurnEvent
        ? classifyTerminalTurnApplicability({
            activeTurnId,
            eventTurnId: rawEventTurnId,
            hasAmbiguousTurns:
              ((yield* Ref.get(outstandingTurnIdsByThreadRef)).get(thread.id)?.size ?? 0) > 1,
          })
        : undefined;
      const eventTurnId =
        terminalApplicability?.resolvedTurnId !== undefined
          ? TurnId.makeUnsafe(terminalApplicability.resolvedTurnId)
          : rawEventTurnId;

      const shouldApplyThreadLifecycle =
        event.type === "turn.started"
          ? !STRICT_PROVIDER_LIFECYCLE_GUARD ||
            isStartedTurnApplicable({ activeTurnId, eventTurnId })
          : !isTerminalTurnEvent || (terminalApplicability?.applicable ?? true);
      if (isTerminalTurnEvent) {
        if (eventTurnId) {
          yield* forgetOutstandingTurn(thread.id, eventTurnId);
        }
        if (terminalApplicability?.reason === "ambiguous-missing-turn-id") {
          yield* Effect.logWarning("provider.runtime.ambiguous_terminal_event_ignored", {
            threadId: thread.id,
            eventType: event.type,
          });
        }
      }
      // ProviderService permits overlapping sends on one thread. Even when a
      // later turn.started cannot replace the active lifecycle, it still binds
      // exactly one queued delivery policy for that provider turn.
      if (event.type === "turn.started" && eventTurnId) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId);
      }
      // A terminal event can be the first lifecycle signal for a provider
      // turn. Consume an already-pending request in that case, but never add a
      // completed turn to the unmatched side for a future request to claim.
      if (isTerminalTurnEvent && eventTurnId) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId, {
          recordUnmatched: false,
        });
      }
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
              return event.payload.state === "waiting" ? "running" : event.payload.state;
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
            : status === "error"
              ? (asString(runtimePayloadRecord(event)?.errorMessage) ??
                thread.session?.lastError ??
                "Turn failed")
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
            commandId: providerCommandId(event, "thread-session-set", thread.id),
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
            commandId: providerCommandId(event, "thread-runtime-mode-set", thread.id),
            threadId: thread.id,
            runtimeMode: inferredRuntimeMode,
            createdAt: now,
          });
        }
      }

      const toolOutputKey = event.itemId
        ? [event.threadId, event.turnId ?? "no-turn", event.itemId].join(":")
        : null;
      if (
        toolOutputKey &&
        event.type === "content.delta" &&
        (event.payload.streamKind === "command_output" ||
          event.payload.streamKind === "file_change_output") &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedToolOutput(toolOutputKey, event.payload.delta);
      }

      const reasoningSummaryKey = reasoningSummaryBufferKey(event, thread.id);
      if (
        reasoningSummaryKey &&
        event.type === "content.delta" &&
        event.payload.streamKind === "reasoning_summary_text" &&
        event.payload.delta.length > 0
      ) {
        yield* appendBufferedReasoningSummary(reasoningSummaryKey, event);
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
          // Some providers can emit content before (or without) turn.started.
          // Treat the first concrete assistant delta as an equivalent arrival
          // signal so the FIFO request mode is bound before delivery is chosen.
          yield* matchStartedTurnAssistantDeliveryMode(thread.id, turnId);
        }

        const assistantDeliveryMode = yield* getAssistantDeliveryMode(
          thread.id,
          turnId ?? activeTurnId ?? undefined,
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(
                event,
                "assistant-delta-buffer-spill",
                assistantMessageId,
              ),
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
            commandId: providerCommandId(event, "assistant-delta", assistantMessageId),
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
        // Studio threads get a durable in-workspace copy (plus direct Output panel
        // attribution); the transcript then references that copy so the image outlives
        // any Codex-home cleanup. Non-Studio threads keep the original path.
        const copied = yield* materializeStudioGeneratedImage({
          event,
          thread,
          imagePath: generatedImagePath,
          turnId: generatedImageTurnId,
          createdAt: now,
        });
        const displayPath = copied?.fullPath ?? generatedImagePath;
        if (generatedImageTurnId) {
          // Defer the transcript reference to turn settle (see the flush helper); the
          // "Generated image" work row already surfaces progress mid-turn.
          yield* rememberPendingGeneratedImage(thread.id, generatedImageTurnId, displayPath);
        } else {
          // No turn to correlate with: attach immediately to the same provider item
          // (replay) or an existing reference, else a standalone image-only message.
          const messages = thread.messages;
          const sameItemMessageId = event.itemId
            ? MessageId.makeUnsafe(`assistant:${event.itemId}`)
            : undefined;
          const markdown = generatedImageMarkdown(displayPath);
          const targetMessage = messages.find(
            (message) =>
              message.role === "assistant" &&
              (message.id === sameItemMessageId ||
                message.text.includes(displayPath) ||
                message.text.includes(markdown)),
          );
          yield* appendGeneratedImagesToAssistantMessage({
            event,
            threadId: thread.id,
            targetMessage,
            newMessageId: MessageId.makeUnsafe(`assistant:image:${event.itemId ?? event.eventId}`),
            imagePaths: [displayPath],
            createdAt: now,
          });
        }
      }

      if (isTerminalTurnEvent) {
        const finalizedTurnId = eventTurnId ?? activeTurnId ?? undefined;
        if (finalizedTurnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
            thread.id,
            finalizedTurnId,
          );
          yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
            finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId: finalizedTurnId,
              createdAt: now,
              commandTag: "assistant-complete-finalize",
              finalDeltaCommandTag: "assistant-delta-finalize-fallback",
            }),
          );
          yield* clearAssistantMessageIdsForTurn(thread.id, finalizedTurnId);

          // After finalization the turn's terminal assistant message is settled;
          // hand it the images the turn produced (an artifact-only turn's final
          // message is intentionally empty — the image markdown becomes its body).
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: finalizedTurnId,
            createdAt: now,
          });

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
        yield* clearOutstandingTurns(thread.id);
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
          // Images produced before the session died are real; surface them now.
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: exitedTurnId,
            createdAt: now,
          });
          yield* clearProviderDiffPlaceholder(thread.id, exitedTurnId);
        }
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage =
          asString(runtimePayloadRecord(event)?.message) ?? "Provider runtime error";
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
          yield* flushPendingGeneratedImagesForTurn({
            event,
            thread,
            turnId: erroredTurnId,
            createdAt: now,
          });
          yield* clearProviderDiffPlaceholder(thread.id, erroredTurnId);
        }

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set", thread.id),
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
          commandId: providerCommandId(event, "thread-meta-update", thread.id),
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
              commandId: providerCommandId(
                event,
                "thread-turn-diff-complete",
                `${thread.id}:${eventTurnId}`,
              ),
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
        event.type === "item.completed" && reasoningSummaryKey
          ? withBufferedReasoningSummary(
              event,
              yield* takeBufferedReasoningSummary(reasoningSummaryKey),
            )
          : event.type === "item.completed" && toolOutputKey
            ? withBufferedToolOutputData(event, yield* takeBufferedToolOutput(toolOutputKey))
            : event.type === "item.updated" && toolOutputKey
              ? withBufferedToolOutputData(event, yield* getBufferedToolOutput(toolOutputKey))
              : event;
      yield* Effect.forEach(runtimeEventToActivities(activityEvent), (activity) =>
        dispatchActivityUpdate(activityEvent, thread.id, activity),
      );

      if (isTerminalTurnEvent) {
        yield* settleBufferedReasoningSummaries(thread.id, event, toTurnId(event.turnId));
      } else if (event.type === "session.exited") {
        yield* settleBufferedReasoningSummaries(thread.id, event);
      } else if (event.type === "runtime.error") {
        yield* settleBufferedReasoningSummaries(
          thread.id,
          event,
          eventTurnId ?? activeTurnId ?? undefined,
        );
      }

      // Exact-turn delivery modes deliberately survive terminal events for a
      // bounded TTL: providers may send late item/delta events after settlement.
      // Unbound request/turn state is safe to clear when a session ends before
      // the two sides can be matched.
      if (event.type === "session.exited" || event.type === "runtime.error") {
        yield* clearAssistantDeliveryModeBindingsForThread(thread.id);
      }
    });

  const processDomainEvent = (event: RuntimeIngestionDomainEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.reverted" || event.type === "thread.conversation-rolled-back") {
        yield* clearActivityUpdateFingerprints(event.payload.threadId);
        yield* clearAssistantDeliveryModeBindingsForThread(event.payload.threadId);
        yield* clearOutstandingTurns(event.payload.threadId);
        return;
      }
      const nextAssistantDeliveryMode =
        event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE;
      const thread = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId),
      );
      const isCodexSteer =
        event.payload.dispatchMode === "steer" &&
        (thread?.session?.providerName ?? thread?.modelSelection.provider) === "codex";
      let deliveryTurnId: TurnId | undefined;
      if (isCodexSteer) {
        let activeTurnId = thread?.session?.activeTurnId ?? undefined;
        if (!activeTurnId) {
          const runtimeSession = (yield* providerService.listSessions()).find(
            (session) => session.threadId === event.payload.threadId,
          );
          activeTurnId = toTurnId(runtimeSession?.activeTurnId);
        }
        if (!activeTurnId) {
          return;
        }
        deliveryTurnId = activeTurnId;
        yield* Cache.set(
          assistantDeliveryModeByTurnKey,
          providerTurnKey(event.payload.threadId, activeTurnId),
          nextAssistantDeliveryMode,
        );
      } else {
        deliveryTurnId = yield* matchAssistantDeliveryModeRequest(
          event.payload.threadId,
          nextAssistantDeliveryMode,
        );
      }
      if (!deliveryTurnId || nextAssistantDeliveryMode !== "streaming") {
        return;
      }

      const flushEvent: ProviderRuntimeEvent = {
        type: "turn.started",
        eventId: event.eventId,
        provider:
          isCodexSteer || thread?.session?.providerName !== "claudeAgent" ? "codex" : "claudeAgent",
        createdAt: event.payload.createdAt,
        threadId: event.payload.threadId,
        turnId: deliveryTurnId,
        payload: {},
      };
      yield* flushBufferedAssistantMessagesForTurn({
        event: flushEvent,
        threadId: event.payload.threadId,
        turnId: deliveryTurnId,
        createdAt: event.payload.createdAt,
        commandTag: "assistant-delta-domain-flush",
      });
    });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime"
      ? processRuntimeEvent(input.event).pipe(
          Effect.andThen(
            runtimeEvents.advanceConsumerCursor({
              consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
              eventSequence: input.sequence,
              updatedAt: new Date().toISOString(),
            }),
          ),
          Effect.flatMap((advanced) =>
            advanced
              ? Effect.void
              : Effect.die(
                  new Error(
                    `Provider runtime cursor could not advance through event ${input.sequence}`,
                  ),
                ),
          ),
        )
      : processDomainEvent(input.event);

  // A failed journal row blocks later runtime rows in the same page. Domain
  // inputs still drain, and the durable poll retries from the exact cursor.
  let runtimeJournalPageBlocked = false;

  const processInputSafely = (input: RuntimeIngestionInput) =>
    input.source === "runtime" && runtimeJournalPageBlocked
      ? Effect.void
      : processInput(input).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            if (input.source === "runtime") {
              runtimeJournalPageBlocked = true;
            }
            return Effect.logWarning("provider runtime ingestion failed to process event", {
              source: input.source,
              eventId: input.event.eventId,
              eventType: input.event.type,
              cause: Cause.pretty(cause),
            });
          }),
        );

  const worker = yield* makeDrainableWorker(processInputSafely, {
    capacity: PROVIDER_RUNTIME_INGESTION_CAPACITY,
  });
  const runtimeJournalDrainLock = yield* Semaphore.make(1);

  const drainRuntimeJournalThrough = (throughSequenceInclusive?: number) =>
    runtimeJournalDrainLock.withPermits(1)(
      Effect.gen(function* () {
        const replayFence = throughSequenceInclusive ?? (yield* runtimeEvents.getHighWaterSequence);
        while (true) {
          const cursor = yield* runtimeEvents.getConsumerCursor(
            PROVIDER_RUNTIME_INGESTION_CONSUMER,
          );
          if (cursor >= replayFence) return;

          const page = yield* runtimeEvents.readAfter({
            sequenceExclusive: cursor,
            throughSequenceInclusive: replayFence,
            limit: PROVIDER_RUNTIME_REPLAY_PAGE_SIZE,
          });
          if (page.length === 0) {
            return yield* Effect.die(
              new Error(`Provider runtime journal is missing rows after cursor ${cursor}`),
            );
          }

          runtimeJournalPageBlocked = false;
          yield* Effect.forEach(page, (entry) =>
            worker.enqueue({
              source: "runtime",
              sequence: entry.sequence,
              event: entry.event,
            }),
          );
          yield* worker.drain;
          if (runtimeJournalPageBlocked) return;

          const advancedCursor = yield* runtimeEvents.getConsumerCursor(
            PROVIDER_RUNTIME_INGESTION_CONSUMER,
          );
          if (advancedCursor <= cursor) {
            return yield* Effect.die(
              new Error(`Provider runtime journal made no progress after cursor ${cursor}`),
            );
          }
        }
      }),
    );

  const drainRuntimeJournal = drainRuntimeJournalThrough();

  const drainRuntimeJournalSafely = drainRuntimeJournal.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("provider runtime journal drain failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const prepareAcceptedRuntimeEventReplay = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (
      event.type !== "content.delta" ||
      event.payload.streamKind !== "assistant_text" ||
      event.turnId === undefined
    ) {
      return;
    }
    const turnId = toTurnId(event.turnId);
    if (!turnId) return;
    const messageId = MessageId.makeUnsafe(
      `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
    );
    const streamingReceipt = yield* commandReceipts.getByCommandId({
      commandId: providerCommandId(event, "assistant-delta", messageId),
    });
    yield* Cache.set(
      assistantDeliveryModeByTurnKey,
      providerTurnKey(event.threadId, turnId),
      Option.isSome(streamingReceipt) ? "streaming" : "buffered",
    );
  });

  // Accepted open-turn rows may have updated only bounded process-local
  // aggregation state. Re-run them before new output; stable command receipts
  // deduplicate durable effects while the caches are rebuilt in event order.
  const rebuildAcceptedOpenTurnState = Effect.gen(function* () {
    let sequence = 0;
    while (true) {
      const page = yield* runtimeEvents.readAcceptedOpenTurnEvents({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        sequenceExclusive: sequence,
        limit: PROVIDER_RUNTIME_REPLAY_PAGE_SIZE,
      });
      if (page.length === 0) return;
      for (const entry of page) {
        yield* prepareAcceptedRuntimeEventReplay(entry.event);
        yield* processRuntimeEvent(entry.event);
        sequence = entry.sequence;
      }
      if (page.length < PROVIDER_RUNTIME_REPLAY_PAGE_SIZE) return;
    }
  });
  const startupRuntimeReplayComplete = yield* Deferred.make<void>();

  const start: ProviderRuntimeIngestionShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          runtimeEvents.append(event).pipe(
            Effect.flatMap((persisted) =>
              Deferred.await(startupRuntimeReplayComplete).pipe(
                Effect.andThen(drainRuntimeJournalThrough(persisted.sequence)),
              ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("provider runtime event rejected before journal append", {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (
            event.type !== "thread.turn-start-requested" &&
            event.type !== "thread.reverted" &&
            event.type !== "thread.conversation-rolled-back"
          ) {
            return Effect.void;
          }
          return Deferred.await(startupRuntimeReplayComplete).pipe(
            Effect.andThen(worker.enqueue({ source: "domain", event })),
          );
        }),
      );
      yield* rebuildAcceptedOpenTurnState;
      yield* drainRuntimeJournal;
      yield* Deferred.succeed(startupRuntimeReplayComplete, undefined);
      yield* Effect.forkScoped(
        Effect.sleep(PROVIDER_RUNTIME_REPLAY_POLL_INTERVAL).pipe(
          Effect.andThen(drainRuntimeJournalSafely),
          Effect.forever,
        ),
      );
    }),
  ).pipe(Effect.orDie);

  const drainThroughCurrentHighWater = Effect.gen(function* () {
    const replayFence = yield* runtimeEvents.getHighWaterSequence;
    yield* drainRuntimeJournalThrough(replayFence);
    yield* worker.drain;
    const cursor = yield* runtimeEvents.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER);
    if (cursor < replayFence) {
      return yield* Effect.die(
        new Error(
          `Provider runtime journal stopped at ${cursor} before drain fence ${replayFence}`,
        ),
      );
    }
  }).pipe(Effect.orDie);

  return {
    start,
    drain: drainThroughCurrentHighWater,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionTurnRepositoryLive,
      ProviderRuntimeEventRepositoryLive,
      OrchestrationCommandReceiptRepositoryLive,
    ),
  ),
);
