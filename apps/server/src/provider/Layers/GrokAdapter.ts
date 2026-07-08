/**
 * GrokAdapterLive - Grok Build CLI (`grok agent ... stdio`) via ACP.
 *
 * @module GrokAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type GrokModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { filterProviderPromptImageAttachments } from "../promptAttachments.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  selectAcpFullAccessPermissionOptionId,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import type { AcpSessionRuntimeOptions } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyGrokAcpModelSelection,
  getGrokApiKeyEnv,
  makeGrokAcpRuntime,
  type GrokAcpRuntimeSettings,
} from "../acp/GrokAcpSupport.ts";
import { GrokAdapter, type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "grok" as const;
const GROK_RESUME_VERSION = 1 as const;
const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const GROK_ACP_TRANSPORT_DEBUG_MARKER = "grok-acp-meta-stripper-v2";
const GROK_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const GROK_ACP_DEBUG_ENV = "SYNARA_GROK_ACP_DEBUG";
const SYNARA_GROK_ACP_DEBUG_ENV = "SYNARA_GROK_ACP_DEBUG";
const LEGACY_GROK_ACP_DEBUG_ENV = "DP_GROK_ACP_DEBUG";
const GROK_RESUME_REPLAY_QUIET_MS = 200;
// Longest that startSession blocks waiting for the resume replay to settle.
// Suppression stays active past this point; only the startup path is unblocked.
const GROK_RESUME_REPLAY_MAX_WAIT_MS = 1_500;
// Absolute cap on replay suppression. A replay still streaming after this long
// is treated as pathological: give up, warn, and unblock turns rather than
// gating the thread forever.
const GROK_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
const GROK_COMPACT_PROMPT = "/compact";
// Backstop for an alive-but-silent grok child: if a turn produces no ACP
// activity for this long, force-fail it instead of showing "Working" forever.
// Generous by design so legitimate long, quiet tool runs are not killed;
// override with SYNARA_GROK_TURN_IDLE_TIMEOUT_MS when a workload needs longer.
const GROK_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_GROK_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const GROK_TURN_WATCHDOG_INTERVAL_MS = 15_000;
// Hard cap on a manual /compact prompt. compactingThread rejects every send
// while set, so a Grok child that goes alive-but-silent mid-compaction would
// otherwise wedge the thread indefinitely. Reuses the turn idle timeout value
// as a generous ceiling (compactions stream activity well under it).
const GROK_COMPACT_TIMEOUT_MS = GROK_TURN_IDLE_TIMEOUT_MS;
// After a timed-out /compact the cancel is only best-effort: the child may
// still stream stale compaction updates for a moment. Hold new turns (and
// drop compaction-shaped tool updates) for this long so those events cannot
// be attributed to the next active turn.
const GROK_COMPACT_ABANDON_QUIET_MS = 5_000;
// Bounded wait for the forked post-timeout cancel to be written before the
// next prompt is dispatched. stdio delivers in order, so once the cancel is
// on the wire it cannot cancel a prompt written after it; a fully wedged
// child never confirms, hence the cap.
const GROK_COMPACT_CANCEL_WAIT_MS = 10_000;
// The compaction outcome (failed tool detail) is recorded by the notification
// consumer, which can lag the /compact response; wait for inbound activity to
// go quiet (bounded) before deciding success.
const GROK_COMPACT_OUTCOME_QUIET_MS = 200;
const GROK_COMPACT_OUTCOME_MAX_WAIT_MS = 2_000;
// A prompt response can resolve while session/update events received during
// the turn still sit in the ACP event queue. The turn stays active (bounded)
// until that backlog drains so late tool updates keep their turn attribution
// instead of falling into the between-turn heuristics. Zero-cost when the
// consumer is keeping up (the queue is already empty).
const GROK_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const GROK_TURN_SETTLE_DRAIN_POLL_MS = 25;
const XAI_API_BASE_URL = "https://api.x.ai/v1";
const ACP_PLAN_MODE_ALIASES = ["plan"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const GROK_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Grok plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function summarizeGrokAcpLogPayload(payload: unknown): unknown {
  const text =
    typeof payload === "string"
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload, null, 2);
          } catch {
            return String(payload);
          }
        })();
  if (text.length <= GROK_ACP_LOG_PAYLOAD_LIMIT) {
    return text;
  }
  return `${text.slice(0, GROK_ACP_LOG_PAYLOAD_LIMIT)}... [truncated ${text.length - GROK_ACP_LOG_PAYLOAD_LIMIT} chars]`;
}

function summarizeGrokAcpRequestPayload(method: string, payload: unknown): unknown {
  if (method === "session/prompt") {
    return "[redacted session/prompt payload]";
  }
  return summarizeGrokAcpLogPayload(payload);
}

function isGrokAcpDebugEnabled(): boolean {
  return (
    process.env[GROK_ACP_DEBUG_ENV] === "1" ||
    process.env[SYNARA_GROK_ACP_DEBUG_ENV] === "1" ||
    process.env[LEGACY_GROK_ACP_DEBUG_ENV] === "1"
  );
}

function mapGrokModelDiscoveryError(cause: unknown): ProviderAdapterRequestError {
  if (cause instanceof ProviderAdapterRequestError) {
    return cause;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "model/list",
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function shouldMirrorGrokAcpProtocolLog(event: {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed" | "dropped";
  readonly payload: unknown;
}): boolean {
  if (event.stage === "decode_failed") return true;
  if (event.stage === "dropped") return true;
  if (event.direction !== "incoming" || event.stage !== "raw") return false;
  const payload = summarizeGrokAcpLogPayload(event.payload);
  if (typeof payload !== "string") return false;
  return payload.includes("grokShell") || payload.includes("x.ai/fs_notify");
}

function makeGrokAcpRuntimeLoggers(
  base: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">,
): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  const debugEnabled = isGrokAcpDebugEnabled();
  const requestLogger: AcpSessionRuntimeOptions["requestLogger"] =
    base.requestLogger || debugEnabled
      ? (event) =>
          Effect.gen(function* () {
            if (base.requestLogger) {
              yield* base.requestLogger(event);
            }
            if (debugEnabled && event.status === "failed") {
              yield* Effect.logWarning("grok.acp.request_failed", {
                marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
                method: event.method,
                payload: summarizeGrokAcpRequestPayload(event.method, event.payload),
                cause: event.cause ? Cause.pretty(event.cause) : undefined,
              });
            }
          })
      : undefined;
  const protocolLogging: AcpSessionRuntimeOptions["protocolLogging"] =
    base.protocolLogging || debugEnabled
      ? {
          logIncoming: base.protocolLogging?.logIncoming ?? debugEnabled,
          logOutgoing: base.protocolLogging?.logOutgoing ?? false,
          logger: (event) =>
            Effect.gen(function* () {
              if (base.protocolLogging?.logger) {
                yield* base.protocolLogging.logger(event);
              }
              if (!debugEnabled || !shouldMirrorGrokAcpProtocolLog(event)) {
                return;
              }
              yield* Effect.logWarning("grok.acp.protocol", {
                marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
                direction: event.direction,
                stage: event.stage,
                payload: summarizeGrokAcpLogPayload(event.payload),
              });
            }),
        }
      : undefined;

  return {
    ...(requestLogger ? { requestLogger } : {}),
    ...(protocolLogging ? { protocolLogging } : {}),
  };
}

export interface GrokAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface GrokSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during the most recent turn, mapped to that
  // turn. A backlogged consumer can process a queued ToolCallUpdated after the
  // prompt response cleared activeTurnId; this keeps the event attributed to
  // its originating turn instead of the between-turn auto-compaction
  // heuristic. Cleared when the next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  // Count of ACP session/update events fully handled by the notification
  // consumer. Compared against acp.sessionUpdatesEnqueuedCount to detect when
  // events received before a prompt response have all been processed —
  // in-flight handlers and stream chunk buffering included.
  sessionUpdatesProcessed: number;
  // Pending until startSession has applied the requested model/mode config.
  // The session is registered in `sessions` before the config RPCs run (so
  // replay keeps draining), which means sendTurn/compactThread can route to it
  // mid-startup; they await this gate so the first prompt never runs with
  // provider defaults. Resolved by stopSessionInternal too, like
  // resumeReplayReady, so a failed startup never strands waiters.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // True while sendTurn is between its compaction check and settling the turn;
  // compactThread reads it so a compaction prompt cannot slip into the gap
  // before ctx.activeTurnId is assigned.
  turnStarting: boolean;
  // Set by interruptTurn while a turn is still starting (no prompt fiber to
  // interrupt yet, e.g. gated on resume replay); startGrokTurn re-checks it
  // before dispatching so a cancelled turn is never prompted.
  pendingTurnInterrupted: boolean;
  compactingThread: boolean;
  // Failed compaction tool-call detail recorded while compactingThread is set;
  // runGrokCompaction reads it so a failed compaction whose /compact prompt
  // still resolves successfully is not persisted as compacted (mirrors how
  // normal turns use activeTurnFailedToolDetail).
  compactionFailedToolDetail: string | undefined;
  // Epoch-ms until which an abandoned (timed-out) /compact may still stream
  // stale updates; new turns wait it out and compaction-shaped tool updates
  // are dropped so they cannot pollute the next turn.
  compactionQuietUntil: number | undefined;
  // Forked best-effort cancel from a timed-out /compact. The next prompt
  // waits (bounded) for it so the cancel is on the wire first — stdio
  // ordering then guarantees it cannot cancel the new turn.
  compactionCancelFiber: Fiber.Fiber<void> | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

export function isGrokContextCompactionToolCall(toolCall: AcpToolCallState): boolean {
  const haystack = [toolCall.kind, toolCall.title, toolCall.detail]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  return /\b(compact|summariz)/u.test(haystack);
}

function clearGrokActiveTurn(ctx: GrokSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnHadAssistantContent = false;
  ctx.activeAssistantItemsWithContent.clear();
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scopeGrokRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return `grok:${turnId}:${itemId}`;
}

// Grok can close a stale assistant segment before any visible text arrives.
export function isRenderableGrokAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

// Grok may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeGrokToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return {
    ...toolCall,
    toolCallId: scopeGrokRuntimeItemIdForTurn(turnId, toolCall.toolCallId),
    data: {
      ...toolCall.data,
      providerToolCallId: toolCall.toolCallId,
    },
  };
}

function parseGrokResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function formatGrokModelName(slug: string): string {
  if (slug === "grok-build-0.1") {
    return "Grok Build 0.1";
  }
  if (slug === "grok-build") {
    return "Grok 4.3";
  }
  return slug.replace(/[-_/]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isGrokBuildApiModelSlug(slug: string): boolean {
  return slug === "grok-build-0.1" || /^grok-code-fast(?:-\d+(?:-\d+)?)?$/u.test(slug);
}

function readXaiModelAliases(rawModel: Record<string, unknown>): string[] {
  const aliases = rawModel.aliases;
  if (!Array.isArray(aliases)) {
    return [];
  }
  return aliases
    .filter((alias): alias is string => typeof alias === "string")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function parseGrokCliModelList(stdout: string): Array<{ slug: string; name: string }> {
  const models: Array<{ slug: string; name: string; isDefault: boolean }> = [];
  let inAvailableModels = false;
  let fallbackDefaultModel: string | undefined;

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inAvailableModels && models.length > 0) {
        break;
      }
      continue;
    }
    const defaultMatch = /^Default model:\s*(\S+)/iu.exec(trimmed);
    if (defaultMatch?.[1]) {
      fallbackDefaultModel = defaultMatch[1].trim();
      continue;
    }
    if (/^Available models:/iu.test(trimmed)) {
      inAvailableModels = true;
      continue;
    }
    if (!inAvailableModels) {
      continue;
    }

    const modelMatch = /^(?:[*-]\s*)?([A-Za-z0-9._/-]+)(?:\s+\(([^)]*)\))?/u.exec(trimmed);
    if (!modelMatch?.[1]) {
      continue;
    }
    const slug = modelMatch[1].trim();
    if (!slug) {
      continue;
    }
    models.push({
      slug,
      name: formatGrokModelName(slug),
      isDefault: (modelMatch[2] ?? "").toLowerCase().includes("default"),
    });
  }

  if (models.length === 0 && fallbackDefaultModel) {
    models.push({
      slug: fallbackDefaultModel,
      name: formatGrokModelName(fallbackDefaultModel),
      isDefault: true,
    });
  }

  return models
    .toSorted((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .map(({ slug, name }) => ({ slug, name }));
}

export function parseXaiLanguageModelDescriptors(
  input: unknown,
): Array<{ slug: string; name: string }> {
  if (!isRecord(input)) return [];
  const rawModels = Array.isArray(input.models)
    ? input.models
    : Array.isArray(input.data)
      ? input.data
      : [];
  const models: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();

  for (const rawModel of rawModels) {
    if (!isRecord(rawModel) || typeof rawModel.id !== "string") {
      continue;
    }
    const slug = rawModel.id.trim();
    if (!slug) {
      continue;
    }
    const aliases = readXaiModelAliases(rawModel);
    const supportedSlugs = [slug, ...aliases].filter(isGrokBuildApiModelSlug);
    for (const supportedSlug of supportedSlugs) {
      const key = supportedSlug.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({ slug: supportedSlug, name: formatGrokModelName(supportedSlug) });
    }
  }

  return models;
}

export function mergeGrokModelDescriptors(
  groups: ReadonlyArray<ReadonlyArray<{ slug: string; name: string }>>,
): Array<{ slug: string; name: string }> {
  const models: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({ slug, name: model.name.trim() || formatGrokModelName(slug) });
    }
  }
  return models;
}

function xaiApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.XAI_API_BASE_URL?.trim() || XAI_API_BASE_URL).replace(/\/+$/u, "");
}

function fetchXaiLanguageModels(input: {
  readonly apiKey: string;
  readonly baseUrl?: string;
}): Effect.Effect<Array<{ slug: string; name: string }>, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${input.baseUrl ?? XAI_API_BASE_URL}/language-models`, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          detail.trim() || `xAI language model discovery failed with HTTP ${response.status}.`,
        );
      }
      return parseXaiLanguageModelDescriptors(await response.json());
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

function readAcpUsdCost(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) {
    return undefined;
  }
  return cost.amount >= 0 ? cost.amount : undefined;
}

function recordGrokSessionCost(
  ctx: GrokSessionContext,
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd !== undefined) {
    ctx.latestSessionCostUsd = sessionCostUsd;
  }
}

function finalizeGrokActiveTurnCost(ctx: GrokSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function withGrokPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${GROK_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : GROK_PLAN_MODE_PROMPT_PREFIX;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) return exact;
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) return partial;
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: GrokModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyGrokAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        options: input.modelSelection.options,
        mapError: ({ cause, method }) => input.mapError({ cause, method }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (requestedModeId) {
      yield* input.runtime.setMode(requestedModeId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_mode",
          }),
        ),
      );
    }
  });
}

function resolveGrokSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

export function makeGrokAdapter(
  grokSettings: GrokAcpRuntimeSettings,
  options?: GrokAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
          ctx.sessionConfigReady = undefined;
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.succeed(ctx.resumeReplayReady, undefined);
          ctx.resumeReplayReady = undefined;
          ctx.resumeReplayLastSuppressedAt = undefined;
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const noteSuppressedGrokRuntimeEvent = (
      ctx: GrokSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isGrokAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("grok.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const activeTurnIdForGrokRuntimeEvent = (ctx: GrokSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedGrokRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.compactingThread) {
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedGrokRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    const emitGrokContextCompactionRuntimeEvent = (
      ctx: GrokSessionContext,
      input: {
        readonly lifecycle: "item.updated" | "item.completed";
        readonly status: "inProgress" | "completed" | "failed";
        readonly title: string;
        readonly detail?: string;
      },
    ) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent({
          type: input.lifecycle,
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          itemId: RuntimeItemId.makeUnsafe(`grok-compaction:${ctx.threadId}`),
          payload: {
            itemType: "context_compaction",
            status: input.status,
            title: input.title,
            ...(input.detail ? { detail: input.detail } : {}),
          },
        });
      });

    // Holds the active-turn window open until session/update events that were
    // already enqueued when the prompt response resolved have been fully
    // handled by the notification consumer, so they settle with their turn
    // attribution (and recorded failed-tool detail) intact. Snapshotting the
    // runtime's enqueued count and waiting for the adapter's processed count
    // to catch up is immune to stream chunk buffering and in-flight handlers,
    // unlike a queue-size probe. Returns immediately when the consumer kept
    // up; bounded so a chatty stream cannot stall settlement past the cap.
    const waitForGrokQueuedTurnEventsDrained = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < GROK_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(GROK_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    // Waits until the notification consumer has been quiet briefly so state it
    // records from queued events (e.g. compactionFailedToolDetail) is visible
    // before the compaction outcome is decided. Bounded — a chatty session
    // cannot hold the /compact RPC open past the cap.
    const settleGrokCompactionOutcome = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        // First drain events that were already enqueued when the /compact
        // response resolved — a backlogged consumer may not have applied a
        // failed compaction tool update yet, and the quiet window below only
        // covers in-transit stragglers, not the existing backlog.
        yield* waitForGrokQueuedTurnEventsDrained(ctx);
        const startedAt = Date.now();
        while (true) {
          const now = Date.now();
          // Seed the quiet measurement from startedAt: a backlogged consumer
          // may not have bumped lastTurnActivityAt yet, so always wait at
          // least one full quiet interval after the prompt response before
          // deciding the outcome.
          const lastActivityAt = Math.max(ctx.lastTurnActivityAt ?? 0, startedAt);
          if (
            now - lastActivityAt >= GROK_COMPACT_OUTCOME_QUIET_MS ||
            now - startedAt >= GROK_COMPACT_OUTCOME_MAX_WAIT_MS
          ) {
            return;
          }
          yield* Effect.sleep(50);
        }
      });

    // After a timed-out /compact, hold new prompts until the forked cancel is
    // on the wire (bounded — a fully wedged child never confirms) and the
    // stale update stream has had its quiet window. stdio ordering then
    // guarantees the cancel cannot cancel the new prompt, and stragglers
    // cannot be attributed to the new turn.
    const waitForAbandonedGrokCompaction = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        const cancelFiber = ctx.compactionCancelFiber;
        if (cancelFiber !== undefined) {
          yield* Fiber.join(cancelFiber).pipe(
            Effect.ignoreCause(),
            Effect.timeoutOption(GROK_COMPACT_CANCEL_WAIT_MS),
          );
          ctx.compactionCancelFiber = undefined;
          // The cancel wait can outlive the quiet window armed at the original
          // compaction timeout; restart it from now so stragglers arriving
          // just after the cancel drains are still held off (and dropped).
          if (ctx.compactionQuietUntil !== undefined) {
            ctx.compactionQuietUntil = Math.max(
              ctx.compactionQuietUntil,
              Date.now() + GROK_COMPACT_ABANDON_QUIET_MS,
            );
          }
        }
        const compactionQuietUntil = ctx.compactionQuietUntil;
        if (compactionQuietUntil !== undefined) {
          const waitMs = compactionQuietUntil - Date.now();
          if (waitMs > 0) {
            yield* Effect.sleep(waitMs);
          }
          ctx.compactionQuietUntil = undefined;
        }
      });

    // On session/load, Grok can replay old ACP updates after the session is "ready".
    // Keep suppression active until that stream actually goes quiet — clearing it
    // on a fixed timeout lets late historical deltas leak into the first turn as
    // its content. The hard cap only guards against a replay that never settles.
    const settleGrokResumeReplayWhenQuiet = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        const ready = ctx.resumeReplayReady;
        if (ready === undefined) {
          return;
        }
        const startedAt = Date.now();
        ctx.resumeReplayLastSuppressedAt = startedAt;
        while (ctx.resumeReplayReady !== undefined) {
          const now = Date.now();
          const lastSuppressedAt = ctx.resumeReplayLastSuppressedAt ?? startedAt;
          const quietForMs = now - lastSuppressedAt;
          const elapsedMs = now - startedAt;
          if (
            quietForMs >= GROK_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= GROK_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= GROK_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning("grok.acp.resume_replay_quiet_wait_timeout", {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(GROK_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
      });

    const startSession: GrokAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const cwd = resolveGrokSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const grokModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: GrokSessionContext;

          const resumeSessionId = parseGrokResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeGrokAcpRuntimeLoggers(acpNativeLoggers);
          const providerGrokOptions = input.providerOptions?.grok;
          const effectiveGrokSettings: GrokAcpRuntimeSettings = {
            ...(grokSettings.binaryPath !== undefined
              ? { binaryPath: grokSettings.binaryPath }
              : {}),
            ...(providerGrokOptions?.binaryPath !== undefined
              ? { binaryPath: providerGrokOptions.binaryPath }
              : {}),
            ...(grokModelSelection?.model ? { model: grokModelSelection.model } : {}),
            ...(grokModelSelection?.options?.reasoningEffort
              ? { reasoningEffort: grokModelSelection.options.reasoningEffort }
              : {}),
            ...(input.runtimeMode === "full-access" ? { alwaysApprove: true } : {}),
          };

          yield* Effect.logInfo("grok.acp.start", {
            marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: GROK_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveGrokSettings.model,
            reasoningEffort: effectiveGrokSettings.reasoningEffort,
            alwaysApprove: effectiveGrokSettings.alwaysApprove === true,
            binaryPath: effectiveGrokSettings.binaryPath ?? "grok",
          });

          const acp = yield* makeGrokAcpRuntime({
            grokSettings: effectiveGrokSettings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "Synara", version: "0.0.0" },
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAcpFullAccessPermissionOptionId(
                    params.options,
                  );
                  if (autoApprovedOptionId !== undefined) {
                    if (isGrokAcpDebugEnabled()) {
                      yield* Effect.logInfo("grok.acp.permission_auto_approved", {
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        optionId: autoApprovedOptionId,
                        options: params.options.map((option) => ({
                          kind: option.kind,
                          optionId: option.optionId,
                        })),
                        toolKind: params.toolCall.kind,
                        toolTitle: params.toolCall.title,
                      });
                    }
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                  yield* Effect.logWarning("grok.acp.permission_auto_approve_unavailable", {
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    options: params.options.map((option) => ({
                      kind: option.kind,
                      optionId: option.optionId,
                    })),
                    toolKind: params.toolCall.kind,
                    toolTitle: params.toolCall.title,
                  });
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const resumeReplayReady =
            resumeSessionId !== undefined ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: grokModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            sessionUpdatesProcessed: 0,
            sessionConfigReady,
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady !== undefined ? Date.now() : undefined,
            turnStarting: false,
            pendingTurnInterrupted: false,
            compactingThread: false,
            compactionFailedToolDetail: undefined,
            compactionQuietUntil: undefined,
            compactionCancelFiber: undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Any inbound ACP event proves the child is alive and making
                // progress; reset the idle-progress watchdog clock.
                ctx.lastTurnActivityAt = Date.now();
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    {
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeGrokRuntimeItemIdForTurn(
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isGrokAcpDebugEnabled()) {
                          yield* Effect.logInfo("grok.acp.empty_assistant_item_suppressed", {
                            threadId: ctx.threadId,
                            turnId: activeTurnId,
                            itemId: scopedItemId,
                          });
                        }
                        return;
                      }
                      ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                      yield* offerRuntimeEvent(
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: scopedItemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;
                  case "PlanUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;
                  case "ToolCallUpdated":
                    {
                      // Stale tool updates from an abandoned (timed-out) /compact
                      // can arrive until the child processes the cancel; drop
                      // them instead of attributing them anywhere.
                      if (
                        ctx.compactionQuietUntil !== undefined &&
                        Date.now() < ctx.compactionQuietUntil &&
                        isGrokContextCompactionToolCall(event.toolCall)
                      ) {
                        return;
                      }
                      // A queued update for a tool call the just-settled turn
                      // already rendered belongs to that turn, even if its
                      // title mentions "compact"/"summarize" — a backlogged
                      // consumer must not reclassify it as auto-compaction.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined &&
                        ctx.activeTurnId === undefined &&
                        !ctx.compactingThread
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      // The title heuristic only applies between turns (grok-initiated
                      // auto-compaction); a live turn's tool call may legitimately
                      // mention "compact"/"summarize" and must render normally, and
                      // resume replay stays suppressed like every other event.
                      const treatAsCompaction =
                        ctx.compactingThread ||
                        (ctx.resumeReplayReady === undefined &&
                          ctx.activeTurnId === undefined &&
                          lateTurnId === undefined &&
                          isGrokContextCompactionToolCall(event.toolCall));
                      if (treatAsCompaction) {
                        // During a manual /compact, compactThread emits the single
                        // terminal row itself (and knows about cancellation), so
                        // tool-call updates stay progress-only to avoid duplicate
                        // "Context compacted" rows. Grok-initiated auto-compaction
                        // has no other completion source and keeps its terminal row.
                        const isTerminal =
                          event.toolCall.status === "completed" ||
                          event.toolCall.status === "failed";
                        // Manual compaction downgrades terminal tool events to
                        // progress rows, so remember a failure here for
                        // runGrokCompaction to honor after the prompt resolves.
                        if (ctx.compactingThread && event.toolCall.status === "failed") {
                          ctx.compactionFailedToolDetail =
                            readAcpFailedToolDetail(event.toolCall) ??
                            event.toolCall.detail ??
                            event.toolCall.title ??
                            "Grok reported a failed compaction tool call.";
                        }
                        const emitTerminal = isTerminal && !ctx.compactingThread;
                        const status = emitTerminal
                          ? event.toolCall.status === "failed"
                            ? "failed"
                            : "completed"
                          : "inProgress";
                        yield* emitGrokContextCompactionRuntimeEvent(ctx, {
                          lifecycle: emitTerminal ? "item.completed" : "item.updated",
                          status,
                          title:
                            event.toolCall.title?.trim() ||
                            (status === "completed" ? "Context compacted" : "Compacting context"),
                          ...(event.toolCall.detail ? { detail: event.toolCall.detail } : {}),
                        });
                        return;
                      }
                      if (lateTurnId !== undefined) {
                        // Emit with the originating turn id so the existing tool
                        // row resolves in place instead of being dropped as an
                        // orphan (or worse, misfiled as thread compaction).
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeGrokToolCallStateForTurn(lateTurnId, event.toolCall),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                      if (failedToolDetail !== undefined) {
                        ctx.activeTurnFailedToolDetail = failedToolDetail;
                      }
                      yield* offerRuntimeEvent(
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          toolCall: scopeGrokToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeGrokRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableGrokAssistantDelta(event)) {
                        ctx.activeTurnHadAssistantContent = true;
                        if (scopedItemId !== undefined) {
                          ctx.activeAssistantItemsWithContent.add(scopedItemId);
                        }
                      }
                      yield* offerRuntimeEvent(
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          ...(scopedItemId ? { itemId: scopedItemId } : {}),
                          text: event.text,
                          ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "UsageUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForGrokRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      recordGrokSessionCost(ctx, event.cost);
                      yield* offerRuntimeEvent(
                        makeAcpTokenUsageEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          usage: event.usage,
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }).pipe(
                // Bump the processed count only after the handler fully ran, so
                // waitForGrokQueuedTurnEventsDrained cannot observe an event as
                // consumed while its state updates are still being applied.
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Config RPCs run after the consumer fork so replay emitted while they are
          // in flight keeps draining. The session is already registered and the
          // start-scope finalizer no longer owns the session scope, so any failure
          // OR interruption of the remaining startup steps must tear the session
          // down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            yield* applyRequestedSessionConfiguration({
              runtime: acp,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
              modelSelection: grokModelSelection,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
            // The requested model/mode are applied; turns gated on this
            // deferred can now prompt without inheriting provider defaults.
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // Settle the replay in the background: suppression stays active until
              // the stream is genuinely quiet, while startup only blocks briefly so
              // a long replay cannot hold session startup hostage. sendTurn and
              // compactThread await the deferred, so the first turn stays gated
              // until the replay has actually finished.
              yield* settleGrokResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(GROK_RESUME_REPLAY_MAX_WAIT_MS),
              );
            }

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Grok ACP session ready" },
            });
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignore(stopSessionInternal(ctx)),
            ),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    // Idle-progress watchdog escape hatch: force-fail a turn whose grok child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via clearGrokActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failGrokTurnAsTimedOut = (ctx: GrokSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearGrokActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeGrokActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Grok stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("grok.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        // Best-effort: tell the child to abandon the turn, then unwind the
        // pending prompt fiber (its onInterrupt no-ops, the turn is cleared).
        // The cancel is forked, not awaited — this path only runs because the
        // child went silent, and a hung session/cancel must not block the
        // prompt-fiber interrupt or leak the watchdog fiber.
        yield* Effect.ignore(ctx.acp.cancel).pipe(Effect.forkIn(ctx.scope));
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // compactThread holds the thread lock but sendTurn intentionally does not
        // (turns are long-running); reject instead of racing a second prompt whose
        // events the compaction suppression would silently drop. Setting
        // turnStarting in the same synchronous block as this check closes the
        // reverse gap: startGrokTurn awaits config/attachment work before it
        // assigns ctx.activeTurnId, and compactThread checks turnStarting so a
        // compaction prompt cannot slip into that window.
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cannot start a turn while Grok context compaction is in progress.",
          });
        }
        // A second sendTurn entering while another turn is still starting would
        // clear that turn's pendingTurnInterrupted flag (letting a cancelled
        // turn dispatch anyway) and race two ACP prompts; reject it instead.
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Grok turn is still starting for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startGrokTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startGrokTurn = (
      ctx: GrokSessionContext,
      input: Parameters<GrokAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        // Startup registers the session before its config RPCs settle; a turn
        // routed in during that window must not prompt with provider defaults.
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.await(ctx.resumeReplayReady);
        }
        yield* waitForAbandonedGrokCompaction(ctx);
        // The gates above are resolved by stopSessionInternal too (a failed or
        // stopped startup must not strand waiters); a turn that was blocked on
        // them must fail here instead of emitting lifecycle events for a dead
        // session.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection:
            model === undefined
              ? undefined
              : {
                  model,
                  options: turnModelSelection?.options,
                },
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
        });
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim()
            ? withGrokPlanModePrompt({
                text: input.input.trim(),
                ...(input.interactionMode !== undefined
                  ? { interactionMode: input.interactionMode }
                  : {}),
              })
            : undefined,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of filterProviderPromptImageAttachments(input.attachments)) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        // A stop can land while the config RPCs or attachment reads above were
        // in flight; opening the turn now would publish turn.started (and a
        // phantom cancelled completion) for a session that already exited.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // Interrupts that landed during the pre-prompt waits (resume replay,
        // config RPCs, attachment reads) are honored by the prompt fiber's
        // dispatch guard below, so the turn completes through the normal
        // cancelled path instead of surfacing as a provider turn-start failure.
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // Late-event attribution only matters between turns; once a new turn
        // dispatches, stragglers from older turns are stale enough to drop.
        ctx.turnToolCallIds.clear();
        ctx.activeInteractionMode = input.interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { ...(model ? { model } : {}) },
        });

        const runPrompt = Effect.suspend(() =>
          // interruptTurn during the pre-prompt waits (resume replay, config
          // RPCs, attachment reads) or between turn.started publishing and this
          // fiber being registered sets pendingTurnInterrupted; honor it (and a
          // concurrent stop) here so a cancelled turn is never prompted.
          // Self-interrupting routes through the onInterrupt branch below, which
          // completes the turn as cancelled rather than as a provider failure.
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({ prompt: promptParts }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForGrokQueuedTurnEventsDrained(ctx);
                if (!clearGrokActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeGrokActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                  lastError: detail,
                };
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                // Drain BEFORE snapshotting turn state: queued events may still
                // set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForGrokQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearGrokActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeGrokActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning("grok.acp.turn_completed_without_content", {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearGrokActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeGrokActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                ...(model ? { model } : {}),
              };
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        // Backstop the forked prompt: if the child goes silent, fail the turn
        // instead of leaving it "Working" forever. Self-terminates when the
        // turn settles; pauses while a human approval is pending.
        yield* forkAcpTurnIdleWatchdog({
          idleTimeoutMs: GROK_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: GROK_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failGrokTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // A turn that is still starting has no prompt fiber to interrupt yet
        // (it may be gated on resume replay); flag it so startGrokTurn aborts
        // before prompting instead of running the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const activePromptFiber = ctx.activePromptFiber;
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (activePromptFiber) {
          yield* Fiber.interrupt(activePromptFiber);
        }
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<GrokAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const compactThread: NonNullable<GrokAdapterShape["compactThread"]> = (threadId) =>
      Effect.gen(function* () {
        // Wait for a settling resume replay before taking the thread lock:
        // stopSession/startSession need that lock, and stopping the session is
        // what resolves the deferred early, so awaiting under the lock would
        // stall stop/restart until the replay quiets or the hard timeout fires.
        const preLockCtx = yield* requireSession(threadId);
        if (preLockCtx.sessionConfigReady !== undefined) {
          yield* Deferred.await(preLockCtx.sessionConfigReady);
        }
        if (preLockCtx.resumeReplayReady !== undefined) {
          yield* Deferred.await(preLockCtx.resumeReplayReady);
        }
        // Claim the compaction slot under the thread lock, but run the
        // (potentially long) /compact prompt outside it: stopSession/restart
        // take the same lock, and a hung compaction must never block
        // stopSessionInternal from cancelling or killing the child.
        const ctx = yield* withThreadLock(threadId, claimGrokCompactionSlot(threadId, preLockCtx));
        return yield* runGrokCompaction(ctx).pipe(
          // compactingThread stays set until this clears it: sendTurn only
          // rejects while the flag is true, so clearing before the
          // completion/thread-state events publish would let a new turn start
          // and then be trailed by stale compaction bookkeeping.
          Effect.ensuring(
            Effect.sync(() => {
              ctx.compactingThread = false;
            }),
          ),
        );
      });

    const claimGrokCompactionSlot = (threadId: ThreadId, preLockCtx: GrokSessionContext) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // The pre-lock replay wait resolves early when the session is stopped;
        // if a restart won the lock first, this thread id now maps to a fresh
        // session that the original compaction request never targeted.
        if (ctx !== preLockCtx) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue:
              "The Grok session was restarted while waiting to compact; retry once it settles.",
          });
        }
        if (ctx.resumeReplayReady !== undefined) {
          // The session was restarted while waiting above and its new replay
          // window is still settling; reject instead of blocking the lock.
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while the resumed Grok thread is still replaying history.",
          });
        }
        // The prompt runs outside the thread lock, so a concurrent /compact can
        // reach this point while one is already in flight; reject it here.
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "A Grok context compaction is already in progress.",
          });
        }
        // turnStarting covers a sendTurn that is past its compaction check but
        // has not assigned ctx.activeTurnId yet; the check and the flag write
        // below stay in one synchronous block so the two paths cannot interleave.
        if (ctx.activeTurnId !== undefined || ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while a Grok turn is still active.",
          });
        }
        ctx.compactingThread = true;
        ctx.compactionFailedToolDetail = undefined;
        return ctx;
      });

    const runGrokCompaction = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        // A previous timed-out /compact may still be cancelling; same ordering
        // requirement as new turns.
        yield* waitForAbandonedGrokCompaction(ctx);
        yield* emitGrokContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.updated",
          status: "inProgress",
          title: "Compacting context",
        });

        const compactResult = yield* ctx.acp
          .prompt({
            prompt: [{ type: "text", text: GROK_COMPACT_PROMPT }],
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/prompt", error),
            ),
            Effect.timeoutOption(GROK_COMPACT_TIMEOUT_MS),
            Effect.exit,
          );

        if (Exit.isFailure(compactResult)) {
          // Interruption (session stopping) is not a compaction failure; let it unwind.
          if (Cause.hasInterruptsOnly(compactResult.cause)) {
            return yield* Effect.failCause(compactResult.cause);
          }
          const squashed = Cause.squash(compactResult.cause);
          const detail = squashed instanceof Error ? squashed.message : String(squashed);
          yield* emitGrokContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction failed",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
        }

        const promptResponse = Option.getOrUndefined(compactResult.value);
        if (promptResponse === undefined) {
          // Timed out: tell the child to abandon the prompt (best effort) and
          // surface the failure instead of leaving compactingThread wedged.
          // The cancel may take a moment to drain; suppress stragglers so the
          // next turn cannot inherit stale compaction updates. The cancel is
          // forked, not awaited: the child just proved it can go silent, and a
          // hung session/cancel would keep compactingThread set forever.
          ctx.compactionQuietUntil = Date.now() + GROK_COMPACT_ABANDON_QUIET_MS;
          ctx.compactionCancelFiber = yield* Effect.ignore(ctx.acp.cancel).pipe(
            Effect.forkIn(ctx.scope),
          );
          const detail = `Grok did not finish context compaction within ${Math.round(GROK_COMPACT_TIMEOUT_MS / 1000)}s; the compaction was abandoned.`;
          yield* Effect.logWarning("grok.acp.compact_timeout", {
            threadId: ctx.threadId,
            timeoutMs: GROK_COMPACT_TIMEOUT_MS,
          });
          yield* emitGrokContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction timed out",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
        }

        // The failed-tool detail below is recorded by the notification
        // consumer, which can lag the prompt response (the update may still
        // sit in the event queue); wait for inbound activity to go quiet
        // before deciding the outcome.
        yield* settleGrokCompactionOutcome(ctx);

        // ACP can answer a /compact prompt successfully with stopReason
        // "cancelled" (user interrupt via session/cancel); that is not a
        // completed compaction and must not be persisted as one.
        if (promptResponse.stopReason === "cancelled") {
          const detail = "Grok context compaction was cancelled before it completed.";
          yield* emitGrokContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction cancelled",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
        }

        // A compaction tool call can fail while the /compact prompt itself
        // still resolves successfully; honor the recorded failure instead of
        // persisting the compaction as completed.
        const failedToolDetail = ctx.compactionFailedToolDetail;
        if (failedToolDetail !== undefined) {
          yield* emitGrokContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction failed",
            detail: failedToolDetail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: failedToolDetail,
            }),
          );
        }

        // Success: thread.state.changed is the single terminal signal —
        // ingestion projects it into the "Context compacted manually" row, so
        // emitting an item.completed row here too would duplicate it.
        yield* offerRuntimeEvent({
          type: "thread.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {
            state: "compacted",
            detail: { reason: "provider.compactThread" },
          },
        });
      });

    const listModels: NonNullable<GrokAdapterShape["listModels"]> = (input) => {
      const binaryPath = input.binaryPath?.trim() || grokSettings.binaryPath || "grok";
      return Effect.gen(function* () {
        let cliError: unknown;
        let apiError: ProviderAdapterRequestError | undefined;
        const cliModels = yield* Effect.gen(function* () {
          const prepared = prepareWindowsSafeProcess(binaryPath, ["models"], { env: process.env });
          const child = yield* childProcessSpawner.spawn(
            ChildProcess.make(prepared.command, prepared.args, {
              shell: prepared.shell,
              env: process.env,
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail:
                stderr.trim() ||
                `Grok model discovery failed because '${binaryPath} models' exited with code ${exitCode}.`,
            });
          }
          return parseGrokCliModelList(stdout);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              cliError = error;
              return [];
            }),
          ),
        );
        const apiKey = getGrokApiKeyEnv();
        const apiModels = apiKey
          ? yield* fetchXaiLanguageModels({ apiKey, baseUrl: xaiApiBaseUrl() }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  apiError = error;
                  return [];
                }),
              ),
            )
          : [];
        const models = mergeGrokModelDescriptors([cliModels, apiModels]);
        if (models.length === 0) {
          if (cliError) {
            return yield* mapGrokModelDiscoveryError(cliError);
          }
          if (apiError) {
            return yield* apiError;
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Grok model discovery returned no models.",
          });
        }
        return {
          models,
          source: apiModels.length > 0 ? "grok-cli+xai-api" : "grok-cli",
          cached: false,
        } satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.mapError(mapGrokModelDiscoveryError),
        Effect.timeoutOption(GROK_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/list",
                  detail: "Timed out while discovering Grok models via CLI.",
                }),
              ),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );
    };

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
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
      getComposerCapabilities,
      compactThread,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape;
  });
}

export const GrokAdapterLive = Layer.effect(GrokAdapter, makeGrokAdapter({}));

export function makeGrokAdapterLive(
  grokSettings: GrokAcpRuntimeSettings = {},
  options?: GrokAdapterLiveOptions,
) {
  return Layer.effect(GrokAdapter, makeGrokAdapter(grokSettings, options));
}
