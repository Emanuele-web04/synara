import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import {
  ApprovalRequestId,
  type GrokModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  getDefaultEffort,
  getModelCapabilities,
  humanizeModelSlug,
  normalizeGrokModelOptions,
} from "@synara/shared/model";
import { decodeOutboundJson, decodeOutboundText, outboundHttp } from "@synara/shared/outboundHttp";
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
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  forkAcpAdapterTurnIdleWatchdog,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import { forkViaAcpRuntime } from "../acp/acpFork.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpDebugLoggers, makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  extractGrokUserInputQuestions,
  extractGrokExitPlanMarkdown,
  GROK_ASK_USER_QUESTION_METHODS,
  GROK_EXIT_PLAN_MODE_METHODS,
  GrokAskUserQuestionRequest,
  GrokExitPlanModeRequest,
  makeGrokExitPlanModeApprovedResponse,
  makeGrokExitPlanModeCapturedResponse,
  makeGrokQuestionResponse,
} from "../acp/GrokAcpExtension.ts";
import {
  applyGrokAcpModelSelection,
  getGrokApiKeyEnv,
  makeGrokAcpRuntime,
  runGrokAcpCompactionCommand,
  type GrokAcpRuntimeSettings,
} from "../acp/GrokAcpSupport.ts";
import { GrokAdapter, type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "grok" as const;

export const takeGrokSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const GROK_RESUME_VERSION = 1 as const;
const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
// forking a dead source reopens it first — leave room for the load-replay gate plus the fork exchange
const GROK_ACP_FORK_TIMEOUT_MS = 30_000;
const GROK_ACP_TRANSPORT_DEBUG_MARKER = "grok-acp-meta-stripper-v2";
const GROK_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const GROK_ACP_DEBUG_ENV = "SYNARA_GROK_ACP_DEBUG";
const SYNARA_GROK_ACP_DEBUG_ENV = "SYNARA_GROK_ACP_DEBUG";
const LEGACY_GROK_ACP_DEBUG_ENV = "DP_GROK_ACP_DEBUG";
// backstop for an alive-but-silent grok child; generous so long quiet runs aren't killed — override via SYNARA_GROK_TURN_IDLE_TIMEOUT_MS
const GROK_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_GROK_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const GROK_TURN_WATCHDOG_INTERVAL_MS = 15_000;
// hard cap on manual /compact: compactingThread rejects sends while set, so a silent child mid-compaction would wedge the thread — reuses the idle timeout (compactions stream well under it)
const GROK_COMPACT_TIMEOUT_MS = GROK_TURN_IDLE_TIMEOUT_MS;
const GROK_COMPACT_ABANDON_QUIET_MS = 5_000;
const GROK_COMPACT_CANCEL_WAIT_MS = 10_000;
const GROK_COMPACT_OUTCOME_QUIET_MS = 200;
const GROK_COMPACT_OUTCOME_MAX_WAIT_MS = 2_000;
// a prompt response can resolve while queued session/update events sit unhandled — keep the turn active (bounded) until the backlog drains so late updates keep attribution
const GROK_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const GROK_TURN_SETTLE_DRAIN_POLL_MS = 25;
const GROK_EXIT_PLAN_RESPONSE_GRACE_MS = 25;
const XAI_API_BASE_URL = "https://api.x.ai/v1";
const GROK_PLAN_MODE_PROMPT_PREFIX = [
  "Synara requested Grok's native plan mode.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");
const GROK_PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "fetch_mcp_resource",
  "get_command_or_subagent_output",
  "get_task_output",
  "get_terminal_command_output",
  "grep",
  "hashline_grep",
  "hashline_read",
  "list_dir",
  "list_mcp_resources",
  "lsp",
  "memory_get",
  "memory_search",
  "read_file",
  "scheduler_list",
  "search_tool",
  "skill",
  "todo_write",
  "update_goal",
  "wait_tasks",
  "web_fetch",
  "web_search",
]);
const GROK_PLAN_GUARD_HOOK_CALLBACK_ID = "synara-plan-guard";
const GROK_SESSION_META = {
  "x.ai/hooks": {
    PreToolUse: [
      {
        matcher: "*",
        hookCallbackIds: [GROK_PLAN_GUARD_HOOK_CALLBACK_ID],
      },
    ],
  },
} satisfies Record<string, unknown>;

export function buildGrokTurnPromptText(input: {
  readonly text: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return withAcpPlanModePrompt({
      text: input.text ?? "",
      interactionMode: "plan",
      promptPrefix: GROK_PLAN_MODE_PROMPT_PREFIX,
    });
  }
  return input.text;
}

export function buildGrokPromptMeta(interactionMode: ProviderInteractionMode): {
  readonly mode: "plan" | "agent";
} {
  // Grok reconciles its Plan tracker from session/prompt _meta.mode — unlike x.ai/toggle_plan_mode it's idempotent, so reconnects can't invert on resend
  return { mode: interactionMode === "plan" ? "plan" : "agent" };
}

export function extractGrokTerminalPlanMarkdown(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly capturedPlanFingerprint: string | undefined;
  readonly assistantText: string;
}): string | undefined {
  if (input.interactionMode !== "plan" || input.capturedPlanFingerprint !== undefined) {
    return undefined;
  }
  const planMarkdown = input.assistantText.trim();
  return planMarkdown.length > 0 ? planMarkdown : undefined;
}

export function resolveGrokPlanHookResponse(
  interactionMode: ProviderInteractionMode | undefined,
  payload: unknown,
): Record<string, never> | { readonly decision: "deny"; readonly systemMessage: string } {
  if (interactionMode !== "plan" || !isRecord(payload)) {
    return {};
  }
  if (payload.hookCallbackId !== GROK_PLAN_GUARD_HOOK_CALLBACK_ID) {
    return {};
  }
  const hookEventName =
    typeof payload.hookEventName === "string" ? payload.hookEventName.trim().toLowerCase() : "";
  if (hookEventName !== "pre_tool_use") {
    return {};
  }
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName.trim().toLowerCase() : "";
  if (GROK_PLAN_READ_ONLY_TOOL_NAMES.has(toolName)) {
    return {};
  }
  return {
    decision: "deny",
    systemMessage: `Synara Plan mode blocks the mutating or unknown Grok tool "${toolName || "unknown"}".`,
  };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

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
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
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
  activePlanResponseText: string;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  // tool-call→turn map for backlogged events after activeTurnId cleared — keeps attribution instead of falling into between-turn auto-compaction heuristics
  readonly turnToolCallIds: Map<string, TurnId>;
  sessionUpdatesProcessed: number;
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  turnStarting: boolean;
  pendingTurnInterrupted: boolean;
  compactingThread: boolean;
  // failed-compaction tool detail recorded while compactingThread — a failed tool call whose /compact still resolves must not persist as compacted
  compactionFailedToolDetail: string | undefined;
  compactionQuietUntil: number | undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scopeGrokRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
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
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
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
  return humanizeModelSlug(slug);
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

export function selectGrokDiscoveredModelGroups(input: {
  readonly cliModels: ReadonlyArray<{ slug: string; name: string }>;
  readonly apiModels: ReadonlyArray<{ slug: string; name: string }>;
}): ReadonlyArray<ReadonlyArray<{ slug: string; name: string }>> {
  // `grok models` is the picker source of truth — the xAI API still advertises retired grok-build slugs the CLI no longer serves
  if (input.cliModels.length > 0) {
    return [input.cliModels];
  }
  if (input.apiModels.length > 0) {
    return [input.apiModels];
  }
  return [];
}

export function mergeGrokModelDescriptors(
  groups: ReadonlyArray<ReadonlyArray<{ slug: string; name: string }>>,
): ProviderModelDescriptor[] {
  const models: ProviderModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const capabilities = getModelCapabilities("grok", slug);
      const defaultReasoningEffort = getDefaultEffort(capabilities);
      models.push({
        slug,
        name: model.name.trim() || formatGrokModelName(slug),
        supportedReasoningEfforts: capabilities.reasoningEffortLevels.map((level) => ({
          value: level.value,
          label: level.label,
          ...(level.description ? { description: level.description } : {}),
        })),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      });
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
      const baseUrl = input.baseUrl ?? XAI_API_BASE_URL;
      const response = await outboundHttp.request({
        url: `${baseUrl}/language-models`,
        policy: {
          service: "xai-model-discovery",
          allowedOrigins: [new URL(baseUrl).origin],
          timeoutMs: 10_000,
          maxRequestBytes: 0,
          maxResponseBytes: 1_000_000,
          maxRedirects: 0,
          maxConcurrent: 2,
          maxQueued: 4,
          requirePublicAddress: true,
        },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
      });
      if (response.status < 200 || response.status >= 300) {
        const detail = decodeOutboundText(response);
        throw new Error(
          detail.trim() || `xAI language model discovery failed with HTTP ${response.status}.`,
        );
      }
      return parseXaiLanguageModelDescriptors(
        decodeOutboundJson(response, { maxDepth: 32, maxNodes: 20_000 }),
      );
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

function applyRequestedModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: GrokModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("../acp/AcpErrors.ts").AcpError;
    readonly method: "session/set_config_option";
  }) => E;
}): Effect.Effect<void, E> {
  if (!input.modelSelection) return Effect.void;
  return applyGrokAcpModelSelection({
    runtime: input.runtime,
    model: input.modelSelection.model,
    options: input.modelSelection.options,
    mapError: ({ cause, method }) => input.mapError({ cause, method }),
  });
}

export function resolveGrokRuntimeModelSettings(
  modelSelection:
    | {
        readonly model: string;
        readonly options?: GrokModelOptions | null | undefined;
      }
    | undefined,
): GrokAcpRuntimeSettings {
  if (!modelSelection) return {};
  const options = normalizeGrokModelOptions(modelSelection.model, modelSelection.options);
  return {
    model: modelSelection.model,
    ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  };
}

function resolveGrokSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

export function makeGrokAdapter(
  grokSettings: GrokAcpRuntimeSettings,
  options?: GrokAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

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
        if (!acceptAcpPlanUpdate(ctx, payload)) return;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
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
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
          ctx.sessionConfigReady = undefined;
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const completeGrokPlanTurn = (
      ctx: GrokSessionContext,
      turnId: TurnId,
      activePromptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { state: "completed", stopReason: null, ...completedCost },
        });
        yield* Effect.ignore(ctx.acp.cancel);
        if (activePromptFiber) {
          yield* Fiber.interrupt(activePromptFiber);
        }
      });

    const noteSuppressedGrokRuntimeEvent = (ctx: GrokSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (!isGrokAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("grok.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason: "orphan-turn-event",
        });
      });

    const activeTurnIdForGrokRuntimeEvent = (ctx: GrokSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.compactingThread) {
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedGrokRuntimeEvent(ctx, eventTag);
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
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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

    const waitForGrokQueuedTurnEventsDrained = (ctx: GrokSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: GROK_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
        pollMs: GROK_TURN_SETTLE_DRAIN_POLL_MS,
      });

    const settleGrokCompactionOutcome = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        yield* waitForGrokQueuedTurnEventsDrained(ctx);
        const startedAt = Date.now();
        while (true) {
          const now = Date.now();
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

    const waitForAbandonedGrokCompaction = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        const cancelFiber = ctx.compactionCancelFiber;
        if (cancelFiber !== undefined) {
          yield* Fiber.join(cancelFiber).pipe(
            Effect.ignoreCause(),
            Effect.timeoutOption(GROK_COMPACT_CANCEL_WAIT_MS),
          );
          ctx.compactionCancelFiber = undefined;
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

    const startSession: GrokAdapterShape["startSession"] = (input) => {
      let registeredCtx: GrokSessionContext | undefined;
      const setup = withThreadLock(
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
          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: GrokSessionContext;

          const resumeSessionId = parseGrokResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isGrokAcpDebugEnabled(),
            provider: PROVIDER,
            marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: GROK_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: (payload) =>
              payload.includes("grokShell") || payload.includes("x.ai/fs_notify"),
          });
          const providerGrokOptions = input.providerOptions?.grok;
          const runtimeGrokModelSettings = resolveGrokRuntimeModelSettings(grokModelSelection);
          const effectiveGrokSettings: GrokAcpRuntimeSettings = {
            ...(grokSettings.binaryPath !== undefined
              ? { binaryPath: grokSettings.binaryPath }
              : {}),
            ...(providerGrokOptions?.binaryPath !== undefined
              ? { binaryPath: providerGrokOptions.binaryPath }
              : {}),
            ...runtimeGrokModelSettings,
          };

          yield* Effect.logInfo("grok.acp.start", {
            marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: GROK_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveGrokSettings.model,
            reasoningEffort: effectiveGrokSettings.reasoningEffort,
            alwaysApprove: input.runtimeMode === "full-access",
            binaryPath: effectiveGrokSettings.binaryPath ?? "grok",
          });

          const acp = yield* makeGrokAcpRuntime({
            grokSettings: effectiveGrokSettings,
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "Synara", version: "0.0.0" },
            // Grok registers client hooks from session setup metadata, not initialize.clientCapabilities — re-send on load/resume so a reconnected session keeps the Plan-mode write gate
            sessionMeta: GROK_SESSION_META,
            ...(agentGatewayCredentials
              ? {
                  buildMcpServers: (initializeResult) =>
                    buildAcpSynaraMcpServers({
                      connection: gatewaySessionLease!.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleExtRequest("x.ai/hooks/run", Schema.Unknown, (params) =>
              Effect.succeed(resolveGrokPlanHookResponse(ctx?.activeInteractionMode, params)),
            );
            for (const method of GROK_ASK_USER_QUESTION_METHODS) {
              yield* acp.handleExtRequest(method, GrokAskUserQuestionRequest, (params) =>
                Effect.gen(function* () {
                  yield* logNative(input.threadId, method, params);
                  const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                  const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent(input.lifecycleGeneration, {
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: extractGrokUserInputQuestions(params) },
                    raw: {
                      source: "acp.jsonrpc",
                      method,
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent(input.lifecycleGeneration, {
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolved },
                  });
                  return makeGrokQuestionResponse(params, resolved);
                }),
              );
            }
            for (const method of GROK_EXIT_PLAN_MODE_METHODS) {
              yield* acp.handleExtRequest(method, GrokExitPlanModeRequest, (params) =>
                Effect.gen(function* () {
                  yield* logNative(input.threadId, method, params);
                  if (ctx?.activeInteractionMode === "default") {
                    // A new Default turn is the user's approval to leave the provider-native Plan gate and continue with implementation.
                    return makeGrokExitPlanModeApprovedResponse();
                  }
                  const planMarkdown = extractGrokExitPlanMarkdown(params);
                  const turnId = ctx?.activeTurnId;
                  const activePromptFiber = ctx?.activePromptFiber;
                  if (planMarkdown !== undefined) {
                    yield* offerRuntimeEvent(input.lifecycleGeneration, {
                      type: "turn.proposed.completed",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      ...(turnId !== undefined
                        ? { turnId }
                        : {
                            itemId: RuntimeItemId.makeUnsafe(
                              `grok-plan-approval:${params.toolCallId}`,
                            ),
                          }),
                      payload: { planMarkdown },
                      raw: {
                        source: "acp.jsonrpc",
                        method,
                        payload: params,
                      },
                    });
                    if (
                      ctx !== undefined &&
                      turnId !== undefined &&
                      ctx.activeInteractionMode === "plan" &&
                      ctx.lastPlanFingerprint !== planMarkdown
                    ) {
                      ctx.lastPlanFingerprint = planMarkdown;
                      // the extension response must reach Grok before Synara cancels the prompt fiber — inline cancel tears down the pending reverse request and recreates the misleading "client disconnected" failure
                      yield* Effect.gen(function* () {
                        yield* Effect.sleep(GROK_EXIT_PLAN_RESPONSE_GRACE_MS);
                        yield* completeGrokPlanTurn(ctx, turnId, activePromptFiber);
                      }).pipe(Effect.forkIn(ctx.scope));
                    }
                  }
                  return makeGrokExitPlanModeCapturedResponse();
                }),
              );
            }
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  if (policyOutcome.outcome === "selected") {
                    if (isGrokAcpDebugEnabled()) {
                      yield* Effect.logInfo("grok.acp.permission_policy_applied", {
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        interactionMode: ctx?.activeInteractionMode,
                        optionId: policyOutcome.optionId,
                        options: params.options.map((option) => ({
                          kind: option.kind,
                          optionId: option.optionId,
                        })),
                        toolKind: params.toolCall.kind,
                        toolTitle: params.toolCall.title,
                      });
                    }
                    return { outcome: policyOutcome };
                  }
                  return { outcome: policyOutcome };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
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
                  input.lifecycleGeneration,
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
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

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
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
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
            activePlanResponseText: "",
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            sessionUpdatesProcessed: 0,
            sessionConfigReady,
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
                if (isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                }
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
                        input.lifecycleGeneration,
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
                      // stale tool updates from an abandoned /compact can arrive until the child processes the cancel — drop them rather than attribute anywhere
                      if (
                        ctx.compactionQuietUntil !== undefined &&
                        Date.now() < ctx.compactionQuietUntil &&
                        isGrokContextCompactionToolCall(event.toolCall)
                      ) {
                        return;
                      }
                      // a queued update for a call the settled turn rendered belongs to that turn even if its title mentions "compact" — never reclassify as auto-compaction
                      const lateTurnId =
                        ctx.activeTurnId === undefined && !ctx.compactingThread
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      // the title heuristic applies only between turns (grok-initiated auto-compaction); a live turn's tool call may legitimately mention "compact"
                      const treatAsCompaction =
                        ctx.compactingThread ||
                        (ctx.activeTurnId === undefined &&
                          lateTurnId === undefined &&
                          isGrokContextCompactionToolCall(event.toolCall));
                      if (treatAsCompaction) {
                        // manual /compact emits the terminal row itself, so tool updates stay progress-only to avoid duplicate "Context compacted" rows; auto-compaction keeps its terminal row
                        const isTerminal =
                          event.toolCall.status === "completed" ||
                          event.toolCall.status === "failed";
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
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
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
                        input.lifecycleGeneration,
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
                        if (ctx.activeInteractionMode === "plan") {
                          ctx.activePlanResponseText += event.text;
                        }
                        if (scopedItemId !== undefined) {
                          ctx.activeAssistantItemsWithContent.add(scopedItemId);
                        }
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
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
                      recordAcpSessionCost(ctx, event.cost);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
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
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          registeredCtx = ctx;
          sessionScopeTransferred = true;

          return { ctx, session, started, grokModelSelection, sessionConfigReady };
        }).pipe(Effect.scoped),
      );

      return Effect.gen(function* () {
        const { ctx, session, started, grokModelSelection, sessionConfigReady } = yield* setup;
        yield* ctx.acp.awaitLoadReplayReady.pipe(
          Effect.mapError((cause) =>
            ctx.stopped
              ? new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                })
              : mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
          ),
        );

        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            if (ctx.stopped || sessions.get(input.threadId) !== ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            yield* applyRequestedModelSelection({
              runtime: ctx.acp,
              modelSelection: grokModelSelection,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Grok ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }),
        );

        return session;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || registeredCtx === undefined
            ? Effect.void
            : Effect.ignore(stopSessionInternal(registeredCtx)),
        ),
      );
    };

    const failGrokTurnAsTimedOut = (ctx: GrokSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
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
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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
        yield* Effect.ignore(ctx.acp.cancel).pipe(Effect.forkIn(ctx.scope));
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cannot start a turn while Grok context compaction is in progress.",
          });
        }
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
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        yield* waitForAbandonedGrokCompaction(ctx);
        // don't publish a working turn while load replay is still suppressed — a concurrent stop releases the gate as "session disappeared" before any turn lifecycle opens
        yield* ctx.acp.awaitLoadReplayReady.pipe(
          Effect.mapError((cause) =>
            ctx.stopped
              ? new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                })
              : mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
          ),
        );
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
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applyRequestedModelSelection({
          runtime: ctx.acp,
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
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: buildGrokTurnPromptText({
            text: input.input?.trim(),
            interactionMode,
          }),
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
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeGrokSynaraHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activePlanResponseText = "";
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.turnToolCallIds.clear();
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { ...(model ? { model } : {}) },
        });

        const runPrompt = Effect.suspend(() =>
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({
                prompt: promptParts,
                _meta: buildGrokPromptMeta(interactionMode),
              }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForGrokQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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
                yield* waitForGrokQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                const terminalPlanMarkdown = extractGrokTerminalPlanMarkdown({
                  interactionMode: ctx.activeInteractionMode,
                  capturedPlanFingerprint: ctx.lastPlanFingerprint,
                  assistantText: ctx.activePlanResponseText,
                });
                if (terminalPlanMarkdown !== undefined) {
                  ctx.lastPlanFingerprint = terminalPlanMarkdown;
                  yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { planMarkdown: terminalPlanMarkdown },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "synara.grok.terminal-plan-response",
                      payload: result,
                    },
                  });
                }
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
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
                // PromptResponse.usage is cumulative session spend, not context occupancy — never synthesize a context-window update from it; usage_update is the only trustworthy meter source
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                ...(model ? { model } : {}),
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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

        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: GROK_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: GROK_TURN_WATCHDOG_INTERVAL_MS,
          onIdleTimeout: (idleMs) => failGrokTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning("grok.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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
          }),
        );
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

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
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
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
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
        const preLockCtx = yield* requireSession(threadId);
        if (preLockCtx.sessionConfigReady !== undefined) {
          yield* Deferred.await(preLockCtx.sessionConfigReady);
        }
        const ctx = yield* withThreadLock(threadId, claimGrokCompactionSlot(threadId, preLockCtx));
        return yield* runGrokCompaction(ctx).pipe(
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
        if (ctx !== preLockCtx) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue:
              "The Grok session was restarted while waiting to compact; retry once it settles.",
          });
        }
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "A Grok context compaction is already in progress.",
          });
        }
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
        yield* waitForAbandonedGrokCompaction(ctx);
        yield* emitGrokContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.updated",
          status: "inProgress",
          title: "Compacting context",
        });

        const compactResult = yield* runGrokAcpCompactionCommand(ctx.acp).pipe(
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
          // closing a load-resumed runtime releases the replay gate as a request error rather than interrupt — teardown keeps interruption-only UI semantics and no stale compaction failure
          if (ctx.stopped) {
            return yield* Effect.interrupt;
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

        yield* settleGrokCompactionOutcome(ctx);

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

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
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
          const childEnv = buildProviderChildEnvironment({ provider: "grok" });
          const child = yield* childProcessSpawner.spawn(
            makeEffectProcessCommand(binaryPath, ["models"], {
              env: childEnv,
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
        const models = mergeGrokModelDescriptors(
          selectGrokDiscoveredModelGroups({ cliModels, apiModels }),
        );
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
          source: cliModels.length > 0 ? "grok-cli" : "grok-cli+xai-api",
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

    const grokForkTimeoutError = (method: string): ProviderAdapterRequestError =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Grok ACP did not respond to ${method} within ${GROK_ACP_FORK_TIMEOUT_MS / 1000}s.`,
      });

    const forkThread: NonNullable<GrokAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveGrokSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveGrokSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork a Grok session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          forkViaAcpRuntime({
            provider: PROVIDER,
            runtime,
            targetCwd,
            unsupportedIssue:
              "This Grok ACP version does not advertise session/fork; Synara will rebuild the fork from its retained transcript.",
            requestTimeoutMs: GROK_ACP_FORK_TIMEOUT_MS,
            timeoutError: grokForkTimeoutError,
          });

        const activeSource = sessions.get(input.sourceThreadId);
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue:
              "The source Grok session has a turn in flight; Synara will rebuild the fork from its retained transcript.",
          });
        }
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseGrokResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Grok session has no resumable native cursor.",
                });
              }
              const providerGrokOptions = input.providerOptions?.grok;
              const runtime = yield* makeGrokAcpRuntime({
                grokSettings: {
                  ...(grokSettings.binaryPath !== undefined
                    ? { binaryPath: grokSettings.binaryPath }
                    : {}),
                  ...(providerGrokOptions?.binaryPath !== undefined
                    ? { binaryPath: providerGrokOptions.binaryPath }
                    : {}),
                },
                childProcessSpawner,
                cwd: sourceCwd,
                runtimeMode: input.runtimeMode,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Synara Fork", version: "0.0.0" },
                sessionMeta: GROK_SESSION_META,
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(GROK_ACP_FORK_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(grokForkTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        return {
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: GROK_RESUME_VERSION,
            sessionId: forked.sessionId,
          },
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterProcessError ||
          cause instanceof ProviderAdapterSessionClosedError ||
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/fork", cause),
        ),
      );

    const stopAll = () => settleConcurrentTeardowns(sessions.values(), stopSessionInternal);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
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
      forkThread,
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
