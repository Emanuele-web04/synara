import {
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationCheckpointFile,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@synara/contracts";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { buildStalePendingRequestFailureDetail } from "@synara/shared/threadSummary";
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
import { activeThreadGoal } from "../../provider/goalMode.ts";
import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "../../provider/terminalTurnApplicability.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../../persistence/Layers/ProjectionPendingInteractions.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import {
  OrchestrationCommandIdentityCollisionError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../Errors.ts";
import { makeRuntimeJournalPoisonGate } from "../runtimeJournalPoisonGate.ts";
import { isExpiredSidechat } from "../sidechatLifecycle.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionGeneratedImageActivityRecord,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import {
  projectProviderRuntimeActivities,
  providerActivityUpdateDedupeKey,
  providerActivityUpdateFingerprint,
  readableReasoningDetail,
  runtimePayloadRecord,
  runtimeTurnState,
} from "../providerRuntimeActivityProjection.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string, target = "event"): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${target}`);

// the delivery-mode handshake is in-memory — a restart, a provider skipping turn.started, or a lost request leaves a turn unbound; defaulting unbound to "buffered" withheld the whole message until completion, so fail toward live output instead
const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "streaming";
const PROVIDER_RUNTIME_INGESTION_CAPACITY = 1_024;
const PROVIDER_RUNTIME_REPLAY_PAGE_SIZE = 128;
const PROVIDER_RUNTIME_REPLAY_POLL_MIN_MS = 250;
const PROVIDER_RUNTIME_REPLAY_POLL_MAX_MS = 5_000;
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
// hot-path cache only — settlement also reads durable activity records so TTL expiry or restart can't discard the transcript reference
const PENDING_GENERATED_IMAGES_TTL = Duration.minutes(60);
const ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY = 4_096;
const ACTIVITY_UPDATE_FINGERPRINT_TTL = Duration.minutes(360);
const MAX_NATIVE_CHILDREN_PER_PARENT_TURN = 20;
const NATIVE_CHILD_IDS_BY_SOURCE_TURN_CACHE_CAPACITY = 2_048;
const NATIVE_CHILD_IDS_BY_SOURCE_TURN_TTL = Duration.minutes(360);
const ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY = 2_048;
const ASSISTANT_DELIVERY_MODE_BY_TURN_TTL = Duration.minutes(60);
// a turn realistically produces a handful of images — the cap bounds a pathological provider replaying completions in a loop
const MAX_PENDING_GENERATED_IMAGES_PER_TURN = 32;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_PROPOSED_PLAN_CHARS = 64_000;
const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 24_000;
const MAX_BUFFERED_REASONING_SUMMARY_CHARS = 8_000;
const MAX_BUFFERED_REASONING_SUMMARY_PARTS = 24;
const BUFFERED_TEXT_TRUNCATION_MARKER = "... [truncated]";
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.SYNARA_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

/** backs off while the live stream is healthy and caught up — this poll only recovers rows whose notification was missed */
export function nextRuntimeJournalSafetyPollDelayMs(
  currentDelayMs: number,
  hadBacklog: boolean,
): number {
  if (hadBacklog) return PROVIDER_RUNTIME_REPLAY_POLL_MIN_MS;
  return Math.min(
    PROVIDER_RUNTIME_REPLAY_POLL_MAX_MS,
    Math.max(PROVIDER_RUNTIME_REPLAY_POLL_MIN_MS, currentDelayMs * 2),
  );
}

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
  // stored values are only ever read, never mutated — ReadonlyArray, which also accepts readonly checkpoint.files without a copy
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
};
type NativeChildSlotState = {
  initialized: boolean;
  readonly childIds: Set<string>;
};

/** promotes a thread shell into a full OrchestrationThread with empty heavy arrays — valid only for events that never read them (see eventNeedsHeavyThreadDetail) */
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

/** PERF: loading full thread detail per event decodes every message — quadratic for a long streaming turn, so the transcript and turn.completed fall minutes behind; only the event types below read the heavy arrays, everything else uses the cheap shell */
function eventNeedsHeavyThreadDetail(event: ProviderRuntimeEvent): boolean {
  if (event.type === "item.completed") {
    // completion reads thread.messages for fallback text; image completion scans it to attach the reference; session exit/error flushes pending images into the terminal message
    return (
      event.payload.itemType === "assistant_message" ||
      generatedImagePathFromRuntimeEvent(event) !== undefined
    );
  }
  return (
    event.type === "turn.proposed.completed" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "turn.diff.updated" ||
    event.type === "session.exited" ||
    event.type === "runtime.error"
  );
}

function parseProviderTurnDiffFiles(
  unifiedDiff: string,
): Effect.Effect<OrchestrationCheckpointFile[] | null> {
  return parseCheckpointFilesFromUnifiedDiff(unifiedDiff).pipe(
    Effect.catchCause(() => Effect.succeed(null)),
  );
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

/** true when the event renders as its own timeline row — such an event between deltas closes the current text segment so the next delta starts an interleave-positioned one */
function isRowMakingProviderRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const itemType = event.payload.itemType;
      return isToolLifecycleItemType(itemType) || itemType === "context_compaction";
    }
    case "runtime.warning":
    case "user-input.requested":
    case "user-input.resolved":
      return true;
    case "content.delta":
      return (
        event.payload.streamKind === "command_output" ||
        event.payload.streamKind === "file_change_output"
      );
    default:
      return false;
  }
}

function assistantMessageSegmentKey(threadId: ThreadId, messageId: MessageId): string {
  return JSON.stringify([threadId, messageId]);
}

function reasoningSummaryBufferKey(
  event: ProviderRuntimeEvent,
  threadId = event.threadId,
): string | null {
  if ((event.provider !== "codex" && event.provider !== "antigravity") || !event.itemId) {
    return null;
  }
  if (
    event.type === "content.delta" &&
    (event.payload.streamKind === "reasoning_summary_text" ||
      (event.provider === "antigravity" && event.payload.streamKind === "reasoning_text"))
  ) {
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
    (event.provider !== "codex" && event.provider !== "antigravity") ||
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

/** Studio copies add a source→workspace-path marker; non-Studio images keep the provider path; the query is turn-scoped, independent of the bounded activity window */
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

  // a Studio marker can survive even if the tool row was pruned — image-specific, so retaining the copied path is safe
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

const takeCached = <Key, Value>(cache: Cache.Cache<Key, Value>, key: Key) =>
  Cache.getOption(cache, key).pipe(
    Effect.flatMap((value) => Cache.invalidate(cache, key).pipe(Effect.as(value))),
  );

export function selectProviderRuntimeJournalStream(input: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly streamPersistedEvents?: Stream.Stream<PersistedProviderRuntimeEvent>;
  readonly append: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<PersistedProviderRuntimeEvent, unknown>;
}) {
  return (
    input.streamPersistedEvents ??
    input.streamEvents.pipe(
      Stream.mapEffect((event) =>
        input.append(event).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("provider runtime event journal ingestion failed", {
                  eventId: event.eventId,
                  eventType: event.type,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(undefined)),
          ),
        ),
      ),
      Stream.filter(
        (persisted): persisted is NonNullable<typeof persisted> => persisted !== undefined,
      ),
    )
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const pendingInteractions = yield* ProjectionPendingInteractionRepository;
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

  // provider turns and domain events can race, and ProviderService permits >1 outstanding send per thread — neither a global mode nor the session's generic active turn is a valid correlation key
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
            // a turn observed before its request may already wait on the unmatched side — once that exact turn terminates it must not be claimable by a later request
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
  // flushed into the terminal assistant message when the turn settles so the visible final row owns the image, not collapsed narration
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
  const nativeChildIdsBySourceTurn = yield* Cache.make<string, NativeChildSlotState>({
    capacity: NATIVE_CHILD_IDS_BY_SOURCE_TURN_CACHE_CAPACITY,
    timeToLive: NATIVE_CHILD_IDS_BY_SOURCE_TURN_TTL,
    lookup: () => Effect.succeed({ initialized: false, childIds: new Set<string>() }),
  });

  const claimNativeChildSlot = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    sourceTurnId: TurnId | null,
    childThreadId: ThreadId,
  ) {
    const budgetKey = `${parentThreadId}:${sourceTurnId ?? "session"}`;
    const slotState = yield* Cache.get(nativeChildIdsBySourceTurn, budgetKey);
    if (!slotState.initialized) {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      for (const thread of snapshot.threads) {
        if (
          thread.parentThreadId === parentThreadId &&
          (thread.sourceTurnId ?? null) === sourceTurnId
        ) {
          slotState.childIds.add(thread.id);
        }
      }
      slotState.initialized = true;
    }
    const childIds = slotState.childIds;
    if (childIds.has(childThreadId)) {
      return { admitted: true, budgetKey } as const;
    }
    if (childIds.size >= MAX_NATIVE_CHILDREN_PER_PARENT_TURN) {
      return { admitted: false, budgetKey } as const;
    }
    childIds.add(childThreadId);
    return { admitted: true, budgetKey } as const;
  });

  const dispatchActivityUpdate = Effect.fnUntraced(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    activity: OrchestrationThreadActivity,
  ) {
    const key = providerActivityUpdateDedupeKey(event, threadId, activity);
    const fingerprint = key ? providerActivityUpdateFingerprint(activity) : undefined;
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

  // PERF: cheap counterpart for events that never read the heavy arrays — see eventNeedsHeavyThreadDetail
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

          // safety valve — flush full buffered text as a delta to cap memory
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const getBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
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
                return Effect.forEach(
                  projectProviderRuntimeActivities(completionEvent),
                  (activity) => dispatchActivityUpdate(completionEvent, threadId, activity),
                ).pipe(Effect.asVoid);
              }),
            ),
        ).pipe(Effect.asVoid),
      ),
    );
  };

  const clearAssistantMessageState = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      const segmentKey = assistantMessageSegmentKey(threadId, messageId);
      bufferedTextSegmentsByMessageKey.delete(segmentKey);
      bufferedTextSpilledByMessageKey.delete(segmentKey);
      const statesForThread = segmentStateByThreadId.get(threadId);
      statesForThread?.delete(messageId);
      if (statesForThread?.size === 0) {
        segmentStateByThreadId.delete(threadId);
      }
      yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
    });

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

  /** each recorded segment fans back out as its own delta carrying its boundary start time so the projection keeps the interleaved timeline; oversized/spilled buffers fall back to a single delta */
  const dispatchFinalAssistantTextSegments = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    tagBase: string;
    text: string;
  }) =>
    Effect.gen(function* () {
      const segmentKey = assistantMessageSegmentKey(input.threadId, input.messageId);
      const segments = bufferedTextSegmentsByMessageKey.get(segmentKey) ?? [];
      const spilled = bufferedTextSpilledByMessageKey.has(segmentKey);
      if (segments.length > 1 && !spilled) {
        for (const [segmentIndex, segment] of segments.entries()) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(
              input.event,
              `${input.tagBase}-segment-${segmentIndex}`,
              input.messageId,
            ),
            threadId: input.threadId,
            messageId: input.messageId,
            delta: segment.text,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(segment.startedAt ? { segmentStartedAt: segment.startedAt } : {}),
            segmentSequence: segment.sequence,
            createdAt: input.createdAt,
          });
        }
        bufferedTextSegmentsByMessageKey.delete(segmentKey);
        bufferedTextSpilledByMessageKey.delete(segmentKey);
        return;
      }
      const bufferedSegmentStartedAt = spilled ? undefined : segments[0]?.startedAt;
      const bufferedSegmentSequence = spilled ? undefined : segments[0]?.sequence;
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.tagBase, input.messageId),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(bufferedSegmentStartedAt ? { segmentStartedAt: bufferedSegmentStartedAt } : {}),
        ...(bufferedSegmentSequence !== undefined
          ? { segmentSequence: bufferedSegmentSequence }
          : {}),
        createdAt: input.createdAt,
      });
      bufferedTextSegmentsByMessageKey.delete(segmentKey);
      bufferedTextSpilledByMessageKey.delete(segmentKey);
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
      const bufferedText = yield* getBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        const segmentKey = assistantMessageSegmentKey(input.threadId, input.messageId);
        bufferedTextSegmentsByMessageKey.delete(segmentKey);
        bufferedTextSpilledByMessageKey.delete(segmentKey);
        return false;
      }

      yield* dispatchFinalAssistantTextSegments({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        tagBase: input.commandTag,
        text: bufferedText,
      });
      yield* Cache.invalidate(bufferedAssistantTextByMessageId, input.messageId);
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
    asyncQuestions?: import("@synara/contracts").AsyncUserInputQuestions;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* getBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (hasRenderableAssistantText(text)) {
        yield* dispatchFinalAssistantTextSegments({
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
          tagBase: input.finalDeltaCommandTag,
          text,
        });
      } else {
        const segmentKey = assistantMessageSegmentKey(input.threadId, input.messageId);
        bufferedTextSegmentsByMessageKey.delete(segmentKey);
        bufferedTextSpilledByMessageKey.delete(segmentKey);
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag, input.messageId),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.asyncQuestions ? { asyncQuestions: input.asyncQuestions } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.threadId, input.messageId);
    });

  /** image markdown already on the target is skipped — provider replays never duplicate references or re-emit message-sent for already-finalized targets */
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

      // finalize only when the message actually changed or was still streaming — skipping keeps replays from emitting redundant message-sent events
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

  /** Codex emits images as artifacts so the final assistant item is often intentionally empty — attaching eagerly hands them to a message the UI collapses; flushing at settle targets the terminal message whose body becomes the image markdown */
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
      // the terminal message is the newest of the turn — the UI folds every earlier assistant row so this is the only row that stays visible
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

  /** copies a completed image into the Studio workspace (Outbox/Images) with direct attribution; returns null — must stay non-fatal — so the transcript falls back to the Codex-home file */
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
            yield* Effect.forEach(messageIds.value, (messageId) =>
              clearAssistantMessageState(threadId, messageId),
            );
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

  /** a session.started marks a fresh runtime whose in-memory callbacks are empty — every unsettled row seen here is provably orphaned (new requests ingest strictly after); settle as stale — leaving them open kept the prompt on screen while every response was dropped */
  const settleUnanswerablePendingInteractions = (
    threadId: ThreadId,
    event: ProviderRuntimeEvent,
    now: string,
  ) =>
    Effect.gen(function* () {
      const rows = yield* pendingInteractions.listUnsettled({ threadId });
      for (const row of rows) {
        // an uncertain delivery is not proof its callback was invalidated
        if (row.status === "uncertain" && row.interactionKind === "approval") continue;
        const isApproval = row.interactionKind === "approval";
        const requestKind = isApproval ? ("approval" as const) : ("user-input" as const);
        const commandId = providerCommandId(event, `stale-pending-${requestKind}`, row.requestId);
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId,
          activity: {
            id: EventId.makeUnsafe(commandId),
            tone: "error",
            kind: isApproval
              ? "provider.approval.respond.failed"
              : "provider.user-input.respond.failed",
            summary: isApproval
              ? "Provider approval response failed"
              : "Provider user input response failed",
            payload: {
              detail: buildStalePendingRequestFailureDetail(requestKind, row.requestId),
              requestId: row.requestId,
              ...(row.lifecycleGeneration ? { lifecycleGeneration: row.lifecycleGeneration } : {}),
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
      }
    });

  // segment tracking scoped by thread+message — a row event marks only that thread's active messages so the next delta starts a new segment even when timestamps are equal; buffered delivery accumulates slices per segment for fan-out (spill marks turns whose boundary invalidated it)
  const segmentStateByThreadId = new Map<
    ThreadId,
    Map<MessageId, { hasText: boolean; splitPending: boolean }>
  >();
  const bufferedTextSegmentsByMessageKey = new Map<
    string,
    ReadonlyArray<{ readonly sequence: number; readonly startedAt: string; readonly text: string }>
  >();
  const bufferedTextSpilledByMessageKey = new Set<string>();

  const processRuntimeEvent = (event: ProviderRuntimeEvent, runtimeSequence: number) =>
    Effect.gen(function* () {
      const now = event.createdAt;
      // load the heavy detail only when this event's handlers read thread.messages/proposedPlans/checkpoints — else the cheap shell (see eventNeedsHeavyThreadDetail)
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
          const sourceTurnId = toTurnId(event.turnId) ?? null;
          // one event can describe the child as both collab receiver and provider thread — re-read after any earlier dispatch
          // mirror the parent load — only heavy-detail handlers read the child's arrays
          const existingThread = needsHeavyThreadDetail
            ? yield* projectionSnapshotQuery.getThreadDetailById(childThreadId)
            : Option.map(
                yield* projectionSnapshotQuery.getThreadShellById(childThreadId),
                threadDetailFromShell,
              );
          // reuse the parent's selection when models match so capability flags survive — a diverging model gets a bare selection
          const resolvedModelSelection =
            identity?.model && identity.modelIsRequestedHint !== true
              ? identity.model === parentThread.modelSelection.model
                ? parentThread.modelSelection
                : {
                    provider: parentThread.modelSelection.provider,
                    model: identity.model,
                  }
              : undefined;

          if (Option.isNone(existingThread)) {
            // the read hides soft-deleted threads but thread.create is decided tombstone-inclusive — re-creating a deleted child is durably rejected and every replay would fail on the stored rejection; drop the projection instead of resurrecting it
            if (yield* projectionSnapshotQuery.threadIdExistsIncludingDeleted(childThreadId)) {
              yield* Effect.logDebug("provider runtime ingestion skipped deleted subagent thread", {
                eventId: event.eventId,
                eventType: event.type,
                threadId: childThreadId,
              });
              return undefined;
            }
            const slot = yield* claimNativeChildSlot(parentThread.id, sourceTurnId, childThreadId);
            if (!slot.admitted) {
              const overflowId = EventId.makeUnsafe(
                `provider-native-child-overflow:${slot.budgetKey}`,
              );
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe(`provider:native-child-overflow:${slot.budgetKey}`),
                threadId: parentThread.id,
                activity: {
                  id: overflowId,
                  tone: "error",
                  kind: "subagent.materialization.capped",
                  summary: `Synara limited this provider turn to ${MAX_NATIVE_CHILDREN_PER_PARENT_TURN} visible native subagents.`,
                  payload: {
                    source: "provider_native",
                    cap: MAX_NATIVE_CHILDREN_PER_PARENT_TURN,
                  },
                  turnId: sourceTurnId,
                  createdAt: now,
                },
                createdAt: now,
              });
              return undefined;
            }
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
              creationSource: "provider_native",
              sourceThreadId: parentThread.id,
              ...(sourceTurnId !== null ? { sourceTurnId } : {}),
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
                creationSource: "provider_native" as const,
                sourceThreadId: parentThread.id,
                sourceTurnId,
                gatewayOperationId: null,
                gatewayOperationIndex: null,
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
      const targetThreadResolution =
        providerThreadId !== undefined &&
        providerParentThreadId !== undefined &&
        providerThreadId !== providerParentThreadId
          ? yield* ensureSubagentThread(
              providerThreadId,
              extractSubagentIdentity(event, providerThreadId),
            )
          : { threadId: parentThread.id, thread: parentThread };
      if (targetThreadResolution === undefined) {
        return;
      }
      const thread = targetThreadResolution.thread;
      if (isRowMakingProviderRuntimeEvent(event)) {
        for (const state of segmentStateByThreadId.get(thread.id)?.values() ?? []) {
          if (state.hasText) {
            state.splitPending = true;
          }
        }
      }
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
      // ProviderService permits overlapping sends — even a turn.started that can't replace the lifecycle still binds exactly one queued delivery policy
      if (event.type === "turn.started" && eventTurnId) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId);
      }
      // a terminal event can be the first lifecycle signal — consume a pending request but never add a completed turn to the unmatched side
      if (isTerminalTurnEvent && eventTurnId) {
        yield* matchStartedTurnAssistantDeliveryMode(thread.id, eventTurnId, {
          recordUnmatched: false,
        });
      }
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (event.type === "session.started") {
        yield* settleUnanswerablePendingInteractions(thread.id, event, now);
      }

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        let nextActiveTurnId = activeTurnId;
        if (event.type === "turn.started") {
          nextActiveTurnId = eventTurnId ?? null;
        } else if (
          isTerminalTurnEvent ||
          event.type === "session.exited" ||
          (event.type === "session.state.changed" &&
            (event.payload.state === "ready" ||
              event.payload.state === "stopped" ||
              event.payload.state === "error"))
        ) {
          nextActiveTurnId = null;
        }
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return event.payload.state === "waiting" ? "running" : event.payload.state;
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed": {
              const turnState = runtimeTurnState(event);
              if (turnState === "failed") return "error";
              if (turnState === "interrupted" || turnState === "cancelled") {
                return "interrupted";
              }
              return "ready";
            }
            case "turn.aborted":
              return "interrupted";
            case "session.started":
            case "thread.started":
              // thread/session start notifications can arrive mid-turn — preserve running state
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        let lastError = thread.session?.lastError ?? null;
        if (event.type === "session.state.changed" && event.payload.state === "error") {
          lastError = event.payload.reason ?? lastError ?? "Provider session error";
        } else if (status === "error") {
          lastError =
            asString(runtimePayloadRecord(event)?.errorMessage) ?? lastError ?? "Turn failed";
        } else if (status === "ready" || status === "interrupted") {
          lastError = null;
        }

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

          // recovery settles the old turn and drains queued work — its technical cancellation must not pause an autonomous goal
          const isDevinWedgeRecoveryCancellation =
            event.provider === "devin" &&
            event.type === "turn.completed" &&
            event.payload.state === "cancelled" &&
            event.payload.stopReason === "synara.devin.wedge-recovery";
          if (isTerminalTurnEvent && !isDevinWedgeRecoveryCancellation) {
            // the read model advances synchronously with goal tools — reading it here prevents a fast terminal event from overtaking the achieved/blocked/pause projection
            const settledThread = (yield* orchestrationEngine.getReadModel()).threads.find(
              (candidate) => candidate.id === thread.id,
            );
            if (
              settledThread &&
              settledThread.deletedAt == null &&
              settledThread.archivedAt == null &&
              !isExpiredSidechat(settledThread) &&
              settledThread.parentThreadId == null &&
              Boolean(activeThreadGoal(settledThread)?.trim()) &&
              settledThread.goalPausedAt == null
            ) {
              if (event.type === "turn.completed" && runtimeTurnState(event) === "completed") {
                yield* orchestrationEngine.dispatch({
                  type: "thread.goal.continue",
                  commandId: providerCommandId(event, "goal-continue", thread.id),
                  threadId: thread.id,
                  goalStartedAt: settledThread.goalStartedAt ?? null,
                  trigger: "turn-completed",
                  ...(eventTurnId !== undefined ? { sourceTurnId: eventTurnId } : {}),
                  createdAt: now,
                });
              } else {
                // a failed/aborted/cancelled/interrupted turn must stop autonomous resurrection until the user resumes
                yield* orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId: providerCommandId(event, "goal-auto-pause", thread.id),
                  threadId: thread.id,
                  goalPaused: true,
                });
              }
            }
          }
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
        (event.payload.streamKind === "reasoning_summary_text" ||
          (event.provider === "antigravity" && event.payload.streamKind === "reasoning_text")) &&
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
          // some providers emit content before/without turn.started — treat the first concrete delta as the arrival signal so the FIFO request mode binds before delivery
          yield* matchStartedTurnAssistantDeliveryMode(thread.id, turnId);
        }

        const assistantDeliveryMode = yield* getAssistantDeliveryMode(
          thread.id,
          turnId ?? activeTurnId ?? undefined,
        );
        // a row-making event between deltas closes the segment — the next delta starts a new one at its own time; on final flush segments fan out so the projection keeps interleaved boundaries
        const statesForThread = segmentStateByThreadId.get(thread.id) ?? new Map();
        segmentStateByThreadId.set(thread.id, statesForThread);
        const segmentState = statesForThread.get(assistantMessageId) ?? {
          hasText: false,
          splitPending: false,
        };
        statesForThread.set(assistantMessageId, segmentState);
        const startsNewSegment = !segmentState.hasText || segmentState.splitPending;
        const segmentStartedAt = startsNewSegment ? now : undefined;
        segmentState.hasText = true;
        segmentState.splitPending = false;
        const bufferedSegmentKey = assistantMessageSegmentKey(thread.id, assistantMessageId);
        if (assistantDeliveryMode === "buffered") {
          if (!bufferedTextSpilledByMessageKey.has(bufferedSegmentKey)) {
            const existingSegments = bufferedTextSegmentsByMessageKey.get(bufferedSegmentKey);
            const tail = existingSegments?.[existingSegments.length - 1];
            if (segmentStartedAt === undefined && tail !== undefined) {
              bufferedTextSegmentsByMessageKey.set(bufferedSegmentKey, [
                ...existingSegments!.slice(0, -1),
                {
                  sequence: tail.sequence,
                  startedAt: tail.startedAt,
                  text: `${tail.text}${assistantDelta}`,
                },
              ]);
            } else {
              bufferedTextSegmentsByMessageKey.set(bufferedSegmentKey, [
                ...(existingSegments ?? []),
                {
                  sequence: runtimeSequence,
                  startedAt: segmentStartedAt ?? now,
                  text: assistantDelta,
                },
              ]);
            }
          }
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            // the spill boundary splits buffered text — per-segment fan-out can't reproduce the truncation; fall back to single-delta flush
            bufferedTextSegmentsByMessageKey.delete(bufferedSegmentKey);
            bufferedTextSpilledByMessageKey.add(bufferedSegmentKey);
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
            ...(segmentStartedAt ? { segmentStartedAt } : {}),
            ...(segmentStartedAt ? { segmentSequence: runtimeSequence } : {}),
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
              asyncQuestions:
                thread.parentThreadId == null ? event.payload.asyncQuestions : undefined,
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
        const assistantMessageId =
          assistantCompletion.asyncQuestions && event.itemId
            ? MessageId.makeUnsafe(`assistant:${event.itemId}`)
            : yield* resolveAssistantCompletionMessageId({
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
          ...(assistantCompletion.asyncQuestions
            ? { asyncQuestions: assistantCompletion.asyncQuestions }
            : {}),
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
        // Studio threads get a durable in-workspace copy so the image outlives Codex-home cleanup; non-Studio keeps the original path
        const copied = yield* materializeStudioGeneratedImage({
          event,
          thread,
          imagePath: generatedImagePath,
          turnId: generatedImageTurnId,
          createdAt: now,
        });
        const displayPath = copied?.fullPath ?? generatedImagePath;
        if (generatedImageTurnId) {
          // defer the transcript reference to turn settle — the work row already surfaces progress mid-turn
          yield* rememberPendingGeneratedImage(thread.id, generatedImageTurnId, displayPath);
        } else {
          // no turn to correlate — attach immediately to the provider item (replay) or an existing reference, else a standalone image-only message
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

          // the turn's terminal message owns the images — an artifact-only turn's final message is intentionally empty; the markdown becomes its body
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
          // images produced before the session died are real — surface them now
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
          // the old turn was technically cancelled — only the failed recovery can pause its goal; never pause a different turn
          if (
            event.provider === "devin" &&
            asObject(event.payload.detail)?.reason === "synara.devin.wedge-recovery" &&
            eventTurnId !== undefined &&
            thread.latestTurn?.turnId === eventTurnId
          ) {
            const failedThread = (yield* orchestrationEngine.getReadModel()).threads.find(
              (candidate) => candidate.id === thread.id,
            );
            if (
              failedThread &&
              activeThreadGoal(failedThread)?.trim() &&
              failedThread.goalPausedAt == null
            ) {
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: providerCommandId(event, "goal-recovery-failed-pause", thread.id),
                threadId: thread.id,
                goalPaused: true,
              });
            }
          }
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
          // only provider-diff placeholders are live-updated — a real CheckpointReactor checkpoint is the terminal diff and stays authoritative
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
                ? yield* parseProviderTurnDiffFiles(event.payload.unifiedDiff)
                : null) ??
              trackedPlaceholder?.files ??
              existingCheckpoint?.files ??
              [];
            const checkpointRef =
              livePlaceholder?.checkpointRef ??
              CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`);
            const checkpointTurnCount = livePlaceholder?.checkpointTurnCount ?? maxTurnCount + 1;
            // leave assistantMessageId undefined — the real capture resolves it once finalized; a synthetic id could collide across turns and render the card on the wrong row
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(
                event,
                "thread-turn-diff-complete",
                `${thread.id}:${turnId}`,
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
      yield* Effect.forEach(
        projectProviderRuntimeActivities(activityEvent, runtimeSequence),
        (activity) => dispatchActivityUpdate(activityEvent, thread.id, activity),
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

      // exact-turn delivery modes survive terminal events for a bounded TTL — providers may send late item/delta events after settlement
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
      // a native steer rides the live turn — no later turn.started arrives, so bind to the live turn immediately
      const steerProvider = thread?.session?.providerName ?? thread?.modelSelection.provider;
      const isNativeSteer =
        event.payload.dispatchMode === "steer" &&
        steerProvider !== undefined &&
        providerSupportsNativeTurnSteering(steerProvider);
      let deliveryTurnId: TurnId | undefined;
      if (isNativeSteer) {
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
        provider: (steerProvider ?? "codex") as ProviderKind,
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

  // acknowledge once per drained page, not per event — removes a commit (and its open-turn/index writes) from every streamed token; the cursor flushes before anything reads it out of band and at stop; a crash leaves at most one page unacknowledged; in-process retries flush the completed prefix before reading the next page — receipts dedupe durable writes, not process-local aggregation
  let pendingAckedSequence: number | null = null;

  const flushRuntimeCursor = Effect.suspend(() => {
    const throughSequence = pendingAckedSequence;
    if (throughSequence === null) return Effect.void;
    return runtimeEvents
      .advanceConsumerCursorThrough({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        throughSequence,
        updatedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.flatMap((advanced) =>
          advanced
            ? Effect.sync(() => {
                // keep a newer completed prefix if work advanced during the SQL call — a failed commit retains this retry fence
                if (pendingAckedSequence === throughSequence) pendingAckedSequence = null;
              })
            : Effect.die(
                new Error(
                  `Provider runtime cursor could not advance through event ${throughSequence}`,
                ),
              ),
        ),
      );
  });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime"
      ? processRuntimeEvent(input.event, input.sequence).pipe(
          Effect.andThen(
            Effect.sync(() => {
              pendingAckedSequence = Math.max(pendingAckedSequence ?? 0, input.sequence);
            }),
          ),
        )
      : processDomainEvent(input.event);

  // a failed row blocks later rows in its page — domain inputs still drain and the durable poll retries from the exact cursor
  let runtimeJournalPageBlocked = false;

  const quarantineUnreplayableCommand = Effect.fnUntraced(function* (
    input: Extract<RuntimeIngestionInput, { source: "runtime" }>,
    error: OrchestrationCommandIdentityCollisionError | OrchestrationCommandPreviouslyRejectedError,
  ) {
    // a receipt binds one command id to one fingerprint and a stored rejection binds it to the refusal — retrying the same row can never collide or succeed; commonly a partially projected event rebuilt from newer state, or a command durably rejected on first dispatch; the journal has one global cursor so waiting on the poison gate drops every later event for every provider for ~a minute — dead-letter the unreplayable row immediately
    // a failure flushing preceding rows must block this page too — else a later success could acknowledge past the poison row
    runtimeJournalPageBlocked = true;
    yield* flushRuntimeCursor;
    const advanced = yield* runtimeEvents
      .advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: input.sequence,
        updatedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catchCause((cause) => {
          runtimeJournalPageBlocked = true;
          return Effect.logWarning("provider runtime unreplayable command quarantine failed", {
            sequence: input.sequence,
            eventId: input.event.eventId,
            eventType: input.event.type,
            threadId: input.event.threadId,
            provider: input.event.provider,
            commandId: error.commandId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null));
        }),
      );
    if (advanced === null) {
      return;
    }
    if (!advanced) {
      runtimeJournalPageBlocked = true;
      yield* Effect.logWarning("provider runtime unreplayable command could not be quarantined", {
        sequence: input.sequence,
        eventId: input.event.eventId,
        eventType: input.event.type,
        threadId: input.event.threadId,
        provider: input.event.provider,
        commandId: error.commandId,
        detail: error.detail,
      });
      return;
    }
    runtimeJournalPageBlocked = false;
    yield* Effect.logError(
      "provider runtime unreplayable command quarantined without blocking the journal",
      {
        sequence: input.sequence,
        eventId: input.event.eventId,
        eventType: input.event.type,
        threadId: input.event.threadId,
        provider: input.event.provider,
        commandId: error.commandId,
        detail: error.detail,
      },
    );
  });

  const processInputSafely = (input: RuntimeIngestionInput) =>
    input.source === "runtime" && runtimeJournalPageBlocked
      ? Effect.void
      : processInput(input).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));
            if (
              input.source === "runtime" &&
              (error instanceof OrchestrationCommandIdentityCollisionError ||
                error instanceof OrchestrationCommandPreviouslyRejectedError)
            ) {
              return quarantineUnreplayableCommand(input, error);
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
  // registered after the worker so LIFO runs it first — rows the worker completed are acknowledged on shutdown
  yield* Effect.addFinalizer(() =>
    flushRuntimeCursor.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime cursor flush failed during shutdown", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
  const runtimeJournalDrainLock = yield* Semaphore.make(1);

  // a deterministically failing row would pin the single global cursor forever — projection freezes for every thread durably across restarts; once the gate trips, the head row is dead-lettered so the journal flows again
  const poisonGate = makeRuntimeJournalPoisonGate();

  const deadLetterPoisonHeadRow = Effect.gen(function* () {
    yield* flushRuntimeCursor;
    const cursor = yield* runtimeEvents.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER);
    if (!poisonGate.noteBlockedDrain(cursor, Date.now())) return false;
    const highWater = yield* runtimeEvents.getHighWaterSequence;
    const page = yield* runtimeEvents.readAfter({
      sequenceExclusive: cursor,
      throughSequenceInclusive: highWater,
      limit: 1,
    });
    const poison = page[0];
    if (poison === undefined) return false;
    yield* Effect.logError("provider runtime journal dead-lettered a poison event", {
      sequence: poison.sequence,
      eventId: poison.event.eventId,
      eventType: poison.event.type,
      threadId: poison.event.threadId,
      provider: poison.event.provider,
    });
    const advanced = yield* runtimeEvents.advanceConsumerCursor({
      consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
      eventSequence: poison.sequence,
      updatedAt: new Date().toISOString(),
    });
    poisonGate.reset();
    return advanced;
  });

  const drainRuntimeJournalThrough = (throughSequenceInclusive?: number) =>
    runtimeJournalDrainLock.withPermits(1)(
      Effect.gen(function* () {
        // an interrupted drain may have left accepted work in the worker — finish it before retrying its acknowledgement
        yield* worker.drain;
        const replayFence = throughSequenceInclusive ?? (yield* runtimeEvents.getHighWaterSequence);
        let hadBacklog = false;
        while (true) {
          yield* flushRuntimeCursor;
          const cursor = yield* runtimeEvents.getConsumerCursor(
            PROVIDER_RUNTIME_INGESTION_CONSUMER,
          );
          if (cursor >= replayFence) return hadBacklog;
          hadBacklog = true;

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
          yield* flushRuntimeCursor;
          if (runtimeJournalPageBlocked) {
            // either the head row was skipped (loop from the fresh cursor) or the drain yields to the durable poller
            if (yield* deadLetterPoisonHeadRow) continue;
            return hadBacklog;
          }

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
      }).pipe(Effect.as(true));
    }),
  );

  const pollRuntimeJournalSafely = Effect.gen(function* () {
    // keep the loop inside one generator fiber — recursively chaining a fresh Effect per tick retains work in Bun's interpreter and grows CPU/RSS
    let delayMs = PROVIDER_RUNTIME_REPLAY_POLL_MIN_MS;
    while (true) {
      yield* Effect.sleep(Duration.millis(delayMs));
      const hadBacklog = yield* drainRuntimeJournalSafely;
      delayMs = nextRuntimeJournalSafetyPollDelayMs(delayMs, hadBacklog);
    }
  });

  const reconcileSettledOpenTurns: ProviderRuntimeIngestionShape["reconcileSettledOpenTurns"] =
    runtimeEvents.pruneSettledOpenTurns.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("provider runtime open-turn cleanup failed", {
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

  // this rebuild only restores bounded process-local caches — its durable effects are already committed and deduplicated by receipt; it runs on the boot path and dies on failure, so an unreplayable row must degrade this thread's caches rather than make the backend unbootable — the state is rebuildable, the boot loop isn't
  const rebuildAcceptedOpenTurnStateForEvent = (event: ProviderRuntimeEvent, sequence: number) =>
    prepareAcceptedRuntimeEventReplay(event).pipe(
      Effect.andThen(processRuntimeEvent(event, sequence)),
      Effect.as({ replayed: true } as const),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed({ replayed: false, cause } as const),
      ),
    );

  // accepted open-turn rows may have updated only process-local aggregation — re-run them before new output; stable receipts dedupe the durable effects while caches rebuild in order
  const rebuildAcceptedOpenTurnState = Effect.gen(function* () {
    let sequence = 0;
    // log only the first failure per turn but keep replaying — a rejection is scoped to that event's ids while a transient failure may succeed next event; skipping the turn would also skip text that exists only in these caches until completion
    const failedTurns = new Set<string>();
    let failedEvents = 0;
    while (true) {
      const page = yield* runtimeEvents.readAcceptedOpenTurnEvents({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        sequenceExclusive: sequence,
        limit: PROVIDER_RUNTIME_REPLAY_PAGE_SIZE,
      });
      if (page.length === 0) break;
      for (const entry of page) {
        sequence = entry.sequence;
        // open-turn rows key by (thread, turn) — a replayed event always carries a turn id
        const turnId = toTurnId(entry.event.turnId);
        const turnKey = turnId ? providerTurnKey(entry.event.threadId, turnId) : null;
        const replay = yield* rebuildAcceptedOpenTurnStateForEvent(entry.event, entry.sequence);
        if (replay.replayed) continue;

        failedEvents += 1;
        const failureKey = turnKey ?? `event:${entry.event.eventId}`;
        if (failedTurns.has(failureKey)) continue;
        failedTurns.add(failureKey);
        yield* Effect.logWarning("provider runtime ingestion failed to rebuild open-turn state", {
          eventId: entry.event.eventId,
          eventType: entry.event.type,
          threadId: entry.event.threadId,
          cause: Cause.pretty(replay.cause),
        });
      }
      if (page.length < PROVIDER_RUNTIME_REPLAY_PAGE_SIZE) break;
    }
    if (failedTurns.size > 0) {
      yield* Effect.logWarning("provider runtime ingestion encountered open-turn replay failures", {
        failedTurns: failedTurns.size,
        failedEvents,
      });
    }
  });
  const startupRuntimeReplayComplete = yield* Deferred.make<void>();

  const start: ProviderRuntimeIngestionShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      const streamPersistedEvents = providerService.streamPersistedEvents;
      const persistedRuntimeEvents = selectProviderRuntimeJournalStream({
        streamEvents: providerService.streamEvents,
        ...(streamPersistedEvents === undefined ? {} : { streamPersistedEvents }),
        append: (event) => runtimeEvents.append(event),
      });
      // notifications only raise the fence and wake the drain fiber — events arriving mid-drain process as pages acknowledged once per page instead of a drain and ack per notification; batching engages exactly when ingestion falls behind
      let requestedLiveFence = 0;
      const liveDrainWakeups = yield* Queue.sliding<void>(1);
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Queue.take(liveDrainWakeups);
            while (true) {
              const fence = requestedLiveFence;
              yield* drainRuntimeJournalThrough(fence).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("provider runtime event journal ingestion failed", {
                        throughSequence: fence,
                        cause: Cause.pretty(cause),
                      }),
                ),
              );
              if (requestedLiveFence <= fence) return;
              // a blocked page yields to the safety poller instead of spinning
              const cursor = yield* runtimeEvents.getConsumerCursor(
                PROVIDER_RUNTIME_INGESTION_CONSUMER,
              );
              if (cursor < fence) return;
            }
          }),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(persistedRuntimeEvents, (persisted) =>
          Deferred.await(startupRuntimeReplayComplete).pipe(
            Effect.andThen(
              Effect.sync(() => {
                requestedLiveFence = Math.max(requestedLiveFence, persisted.sequence);
              }),
            ),
            Effect.andThen(Queue.offer(liveDrainWakeups, undefined)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("provider runtime event journal ingestion failed", {
                    eventId: persisted.event.eventId,
                    eventType: persisted.event.type,
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
      // a prior reconciliation can leave a durable turn terminal while the ledger calls it open — replaying that stale row can reuse a command id with a payload from the newer projection, so remove settled rows before rebuilding
      yield* runtimeEvents.pruneSettledOpenTurns;
      yield* rebuildAcceptedOpenTurnState;
      yield* drainRuntimeJournal;
      yield* Deferred.succeed(startupRuntimeReplayComplete, undefined);
      yield* Effect.forkScoped(pollRuntimeJournalSafely);
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
    reconcileSettledOpenTurns,
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
      ProjectionPendingInteractionRepositoryLive,
      ProviderRuntimeEventRepositoryLive,
      OrchestrationCommandReceiptRepositoryLive,
    ),
  ),
);
