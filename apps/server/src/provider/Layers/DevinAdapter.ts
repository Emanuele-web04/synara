import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import {
  ApprovalRequestId,
  type ChatAttachment,
  type DevinModelOptions,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from "@synara/contracts";
import {
  getDevinStaticModelVariants,
  getModelCapabilities,
  getProviderOptionDescriptors,
  humanizeModelSlug,
  normalizeModelSlug,
  resolveDevinModelVariant,
  trimOrNull,
} from "@synara/shared/model";
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
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import type * as Acp from "@agentclientprotocol/sdk";

import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { AcpRequestError } from "../acp/AcpErrors.ts";
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
import {
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import {
  redactAcpLogSecrets,
  makeAcpDebugLoggers,
  makeAcpNativeLoggers,
} from "../acp/AcpNativeLogging.ts";
import {
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import {
  hasDevinApiKeyEnv,
  mapDevinAcpCommands,
  makeDevinAcpRuntime,
  resolveDevinBinaryPath,
  runDevinAcpCompactionCommand,
  type DevinAcpRuntimeSettings,
} from "../acp/DevinAcpSupport.ts";
import { createDevinSessionConfig, type DevinSessionConfig } from "../acp/DevinSessionConfig.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
  type ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";

const PROVIDER = "devin" as const;
const DEVIN_RESUME_VERSION = 1 as const;

const DEVIN_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 30 * 60 * 1000,
});

// wedge recovery: the devin child can deadlock while alive (hung sandbox_manager lock, PTY spawn never reaching shell-ready) and emits no ACP events; it announces both shapes on mirrored stderr
const DEVIN_STALL_WATCH_LOG_PATTERN = "affogato::stall_watch";
const DEVIN_SPAWN_START_LOG_PATTERN = /session_id=([0-9a-f]+) \[create_session\] starting/;
const DEVIN_SPAWN_READY_LOG_PATTERN =
  /session_id=([0-9a-f]+) \[create_session\] waiting for shell ready/;
const DEVIN_WEDGE_RECOVERY_CONTINUATION_PROMPT = "continue";
const DEVIN_WEDGE_RECOVERY_WARNING =
  "Devin stopped responding; restarting this session automatically and continuing the task.";
const DEVIN_WEDGE_RECOVERY_MAX_PER_THREAD = 3;
const DEVIN_WEDGE_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const DEVIN_WEDGE_SUPERVISOR_INTERVAL_MS = 5_000;

export interface DevinWedgeRecoveryOptions {
  readonly stallFuseMs: number;
  readonly spawnStallTimeoutMs: number;
  readonly checkIntervalMs: number;
  readonly maxPerThread: number;
  readonly windowMs: number;
}

// `0` is meaningful here: it disables the wedge detector rather than falling back to the default
export function resolveDevinOptionalTimeoutMs(input: {
  readonly envVar: string;
  readonly defaultMs: number;
  readonly env?: NodeJS.ProcessEnv;
}): number {
  const raw = (input.env ?? process.env)[input.envVar]?.trim();
  if (raw === undefined || raw === "") return input.defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return input.defaultMs;
  return parsed;
}

export function resolveDevinWedgeRecoveryOptions(
  env: NodeJS.ProcessEnv = process.env,
): DevinWedgeRecoveryOptions {
  return {
    stallFuseMs: resolveDevinOptionalTimeoutMs({
      envVar: "SYNARA_DEVIN_STALL_FUSE_MS",
      defaultMs: 90_000,
      env,
    }),
    spawnStallTimeoutMs: resolveDevinOptionalTimeoutMs({
      envVar: "SYNARA_DEVIN_SPAWN_STALL_TIMEOUT_MS",
      defaultMs: 30_000,
      env,
    }),
    checkIntervalMs: DEVIN_WEDGE_SUPERVISOR_INTERVAL_MS,
    maxPerThread: DEVIN_WEDGE_RECOVERY_MAX_PER_THREAD,
    windowMs: DEVIN_WEDGE_RECOVERY_WINDOW_MS,
  };
}

export type DevinWedgeSignal =
  | { readonly kind: "stall-watch"; readonly silentMs: number }
  | { readonly kind: "spawn-stall"; readonly spawnSessionId: string; readonly stalledMs: number };

// wedge signal = active turn + no pending human input + a child-announced failure shape persisted past its fuse
export function evaluateDevinWedgeSignal(input: {
  readonly activeTurnId: string | undefined;
  readonly awaitingHuman: boolean;
  readonly stallWatchDetectedAt: number | undefined;
  readonly spawnStalls: ReadonlyMap<string, number>;
  readonly now: number;
  readonly stallFuseMs: number;
  readonly spawnStallTimeoutMs: number;
}): DevinWedgeSignal | undefined {
  if (input.activeTurnId === undefined || input.awaitingHuman) return undefined;
  if (input.stallWatchDetectedAt !== undefined && input.stallFuseMs > 0) {
    const silentMs = input.now - input.stallWatchDetectedAt;
    if (silentMs >= input.stallFuseMs) {
      return { kind: "stall-watch", silentMs };
    }
  }
  if (input.spawnStallTimeoutMs > 0) {
    for (const [spawnSessionId, startedAt] of input.spawnStalls) {
      const stalledMs = input.now - startedAt;
      if (stalledMs >= input.spawnStallTimeoutMs) {
        return { kind: "spawn-stall", spawnSessionId, stalledMs };
      }
    }
  }
  return undefined;
}

export function canRecoverDevinWedge(input: {
  readonly recoveryAt: ReadonlyArray<number>;
  readonly now: number;
  readonly maxPerWindow: number;
  readonly windowMs: number;
}): boolean {
  return (
    input.recoveryAt.filter((at) => input.now - at < input.windowMs).length < input.maxPerWindow
  );
}
const DEVIN_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const DEVIN_COMMAND_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_COMMAND_DISCOVERY_CACHE_MS = 5 * 60_000;
const DEVIN_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const DEVIN_ACP_TRANSPORT_DEBUG_MARKER = "devin-acp-meta-stripper-v2";
const DEVIN_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const DEVIN_ACP_DEBUG_ENV = "SYNARA_DEVIN_ACP_DEBUG";
const LEGACY_DEVIN_ACP_DEBUG_ENV = "DP_DEVIN_ACP_DEBUG";
// session/load can replay old ACP updates after "ready" — suppression stays until the stream goes quiet; the hard cap only guards a replay that never settles
const DEVIN_RESUME_REPLAY_QUIET_MS = 200;
const DEVIN_RESUME_REPLAY_MAX_WAIT_MS = 1_500;
const DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
// backstop for an alive-but-silent devin child; compactions stream well under it — override via SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS
const DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DEVIN_TURN_SETTLE_DRAIN_POLL_MS = 25;
const DEVIN_COMPACT_TIMEOUT_MS = DEVIN_TURN_IDLE_TIMEOUT_MS;
// a timed-out /compact's cancel is best-effort — the child may still stream stale updates, so hold new turns until it quiets
const DEVIN_COMPACT_ABANDON_QUIET_MS = 5_000;
// bounded wait for the forked cancel to reach the wire — stdio ordering then guarantees it can't cancel a later prompt; a wedged child never confirms, hence the cap
const DEVIN_COMPACT_CANCEL_WAIT_MS = 10_000;
// compaction outcome is recorded by the notification consumer which can lag the /compact response — wait (bounded) for inbound quiet before deciding
const DEVIN_COMPACT_OUTCOME_QUIET_MS = 200;
const DEVIN_COMPACT_OUTCOME_MAX_WAIT_MS = 2_000;

const ACP_PLAN_MODE_ALIASES = ["plan", "architect"] as const;
const ACP_APPROVAL_MODE_ALIASES = ["accept-edits", "code"] as const;
const ACP_FULL_ACCESS_MODE_ALIASES = ["bypass", "full access"] as const;
const DEVIN_PLAN_MODE_PROMPT_PREFIX = [
  "Devin plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export interface DevinAdapterTimeouts {
  readonly turnIdleMs: number;
  readonly toolIdleMs: number;
}

export function resolveDevinAdapterTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): DevinAdapterTimeouts {
  return {
    turnIdleMs: resolveAcpTurnIdleTimeoutMs({
      envVar: "SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS",
      defaultMs: 30 * 60 * 1000,
      env,
    }),
    toolIdleMs: resolveAcpTurnIdleTimeoutMs({
      envVar: "SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS",
      defaultMs: 60 * 60 * 1000,
      env,
    }),
  };
}

interface DevinAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeAcpRuntime?: typeof makeDevinAcpRuntime;
  readonly onSessionUpdateProcessed?: () => void;
  readonly timeouts?: DevinAdapterTimeouts;
  readonly wedgeRecovery?: DevinWedgeRecoveryOptions;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface DevinSessionContext extends SynaraHarnessPolicyDeliveryState {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string | undefined;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<ProviderThreadTurnSnapshot>;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // once ctx.acp.prompt has returned the outcome is settled — an interrupt during post-prompt drain must not reclassify the turn as cancelled
  activePromptResolved: boolean;
  // lastSettledTurnId survives until the next dispatch so trailing ToolCallUpdated events still resolve the settled turn's rows in place after activeTurnId is cleared
  lastSettledTurnId: TurnId | undefined;
  lastPlanFingerprint: string | undefined;
  lastTurnActivityAt: number | undefined;
  // tool-call→turn map: a backlogged ToolCallUpdated can arrive after activeTurnId cleared or the next turn dispatched — keep attribution to the originating turn, pruned to the last settled turn (FIFO stream ⇒ ≤1 turn lag)
  readonly turnToolCallIds: Map<string, TurnId>;
  readonly devinToolCallLifecycleById: Map<string, "active" | "terminal">;
  // wedge state fed by the child's mirrored stderr: stallWatchDetectedAt = child's own stall confession (first wins, progress clears); spawnStalls = create_session starts never reaching shell-ready
  devinStallWatchDetectedAt: number | undefined;
  readonly devinSpawnStalls: Map<string, number>;
  // one auto-recovery per turn — a recovered turn can't trigger another if its replacement also stalls
  devinWedgeRecoveryAttemptedFor: string | undefined;
  devinWedgeRecoveryInFlight: boolean;
  // original start inputs replayed verbatim so the replacement child keeps the thread's model selection and provider options
  readonly devinStartModelSelection: ProviderSessionStartInput["modelSelection"];
  readonly devinStartProviderOptions: ProviderSessionStartInput["providerOptions"];
  sessionUpdatesProcessed: number;
  // session registers before post-registration setup settles, so sendTurn/compactThread can route mid-startup — they await this gate; stopSessionInternal resolves it too so failed startup never strands waiters
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // set between compaction check and turn settle so compactThread can't slip a prompt into the gap before activeTurnId is assigned
  turnStarting: boolean;
  // set by interruptTurn while no prompt fiber exists yet — startDevinTurn re-checks so a cancelled turn is never prompted
  pendingTurnInterrupted: boolean;
  compactingThread: boolean;
  // failed-compaction tool detail recorded while compactingThread — a failed tool call must not persist as a completed compaction
  compactionFailedToolDetail: string | undefined;
  compactionQuietUntil: number | undefined;
  compactionCancelFiber: Fiber.Fiber<void> | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
  gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly devinSessionConfig: DevinSessionConfig | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDevinProviderStartOptions(
  providerOptions: unknown,
): { readonly binaryPath?: string } | undefined {
  if (!isRecord(providerOptions) || !isRecord(providerOptions.devin)) {
    return undefined;
  }
  const binaryPath = providerOptions.devin.binaryPath;
  return typeof binaryPath === "string" ? { binaryPath } : {};
}

function parseDevinResume(resumeCursor: unknown): { readonly sessionId: string } | undefined {
  if (!isRecord(resumeCursor)) {
    return undefined;
  }
  const schemaVersion = resumeCursor.schemaVersion;
  const sessionId = resumeCursor.sessionId;
  if (
    schemaVersion !== DEVIN_RESUME_VERSION ||
    typeof sessionId !== "string" ||
    !sessionId.trim()
  ) {
    return undefined;
  }
  return { sessionId: sessionId.trim() };
}

function normalizeModeToken(value: string): string {
  return value.toLowerCase().trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeMode(value: string): ReadonlyArray<string> {
  const normalized = normalizeModeToken(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function findModeByExactNormalizedAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map(normalizeModeToken);
  return modes.find((mode) => {
    const normalizedId = normalizeModeToken(mode.id);
    const normalizedName = normalizeModeToken(mode.name);
    return normalizedAliases.some((alias) => normalizedId === alias || normalizedName === alias);
  });
}

function findModeByWholeTokenAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const aliasTokens = aliases.flatMap(tokenizeMode);
  return modes.find((mode) => {
    const modeTokens = new Set([...tokenizeMode(mode.id), ...tokenizeMode(mode.name)]);
    return aliasTokens.some((token) => modeTokens.has(token));
  });
}

export function resolveRequestedModeId(input: {
  readonly modeState: AcpSessionModeState | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): Effect.Effect<string | undefined, ProviderAdapterValidationError> {
  return Effect.gen(function* () {
    const { modeState, runtimeMode, interactionMode } = input;

    if (!modeState) {
      const requiredBy =
        interactionMode === "plan"
          ? "plan interaction mode"
          : runtimeMode === "approval-required"
            ? `runtime mode "${runtimeMode}"`
            : undefined;

      if (requiredBy) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "resolveRequestedModeId",
          issue: `Requested ${requiredBy} requires the ACP session to expose modes, but none were reported.`,
        });
      }

      return undefined;
    }

    const aliases =
      interactionMode === "plan"
        ? ACP_PLAN_MODE_ALIASES
        : runtimeMode === "approval-required"
          ? ACP_APPROVAL_MODE_ALIASES
          : ACP_FULL_ACCESS_MODE_ALIASES;

    // plan mode accepts only an exact normalized id/name match — whole-token matching is too permissive for a fail-closed gate
    const targetMode =
      interactionMode === "plan"
        ? findModeByExactNormalizedAliases(modeState.availableModes, aliases)
        : (findModeByExactNormalizedAliases(modeState.availableModes, aliases) ??
          findModeByWholeTokenAliases(modeState.availableModes, aliases));

    if (!targetMode) {
      if (runtimeMode === "full-access" && interactionMode !== "plan") {
        return undefined;
      }
      const requiredBy =
        interactionMode === "plan" ? "plan interaction mode" : `runtime mode "${runtimeMode}"`;
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "resolveRequestedModeId",
        issue: `Requested ${requiredBy} does not match any available ACP mode. Available modes: ${modeState.availableModes
          .map((mode) => `${mode.id} (${mode.name})`)
          .join(", ")}`,
      });
    }

    return targetMode.id === modeState.currentModeId ? undefined : targetMode.id;
  });
}

export function applyDevinSessionConfiguration(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getModeState" | "setMode">;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    const readModeState = () =>
      input.runtime.getModeState.pipe(
        Effect.timeoutOption(5_000),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );

    const modeState = yield* readModeState();

    const requestedModeId = yield* resolveRequestedModeId({
      modeState,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    });

    if (requestedModeId) {
      yield* input.runtime.setMode(requestedModeId).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setMode("${requestedModeId}") failed: ${error.message}`,
            }),
        ),
      );

      const modeStateAfter = yield* readModeState();
      const stillRequired = yield* resolveRequestedModeId({
        modeState: modeStateAfter,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      }).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setMode("${requestedModeId}") did not put the session into the requested mode: ${error.message}`,
            }),
        ),
      );
      if (stillRequired !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "applyDevinSessionConfiguration",
          issue: `setMode("${requestedModeId}") was not confirmed by the ACP agent. Current mode: ${modeStateAfter?.currentModeId ?? "undefined"}`,
        });
      }
    }
  });
}

export function scopeDevinRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

// Devin can close a stale assistant segment before any visible text arrives.
export function isRenderableDevinAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

export function scopeDevinToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function setDevinDiscoveryCacheEntry<Result>(
  cache: Map<string, { readonly expiresAt: number; readonly result: Result }>,
  key: string,
  value: { readonly expiresAt: number; readonly result: Result },
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DEVIN_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export function makeCachedDevinModelDiscovery<E, R>(input: {
  readonly discoveryLock: Semaphore.Semaphore;
  readonly discover: (binaryPath: string) => Effect.Effect<ProviderListModelsResult, E, R>;
}) {
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly result: ProviderListModelsResult }
  >();
  return (binaryPath: string, options?: { readonly forceReload?: boolean }) => {
    const resolvedBinaryPath = resolveDevinBinaryPath(binaryPath);
    const cached = cache.get(resolvedBinaryPath);
    if (options?.forceReload !== true && cached && cached.expiresAt > Date.now()) {
      return Effect.succeed({ ...cached.result, cached: true });
    }
    return input.discoveryLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = cache.get(resolvedBinaryPath);
        if (options?.forceReload !== true && cached && cached.expiresAt > Date.now()) {
          return { ...cached.result, cached: true };
        }
        const result = yield* input.discover(resolvedBinaryPath);
        if (result.error === undefined) {
          setDevinDiscoveryCacheEntry(cache, resolvedBinaryPath, {
            expiresAt: Date.now() + DEVIN_MODEL_DISCOVERY_CACHE_MS,
            result,
          });
        }
        return result;
      }),
    );
  };
}

function collectStreamAsString<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return collectUint8StreamText({ stream }).pipe(Effect.map(({ text }) => text));
}

function isDevinAcpDebugEnabled(): boolean {
  return (
    process.env[DEVIN_ACP_DEBUG_ENV] === "1" || process.env[LEGACY_DEVIN_ACP_DEBUG_ENV] === "1"
  );
}

interface DevinModelDescriptorSeed {
  readonly slug: string;
  readonly name?: string;
  readonly description?: string;
  readonly variants?: ReadonlyArray<DevinModelVariantSeed>;
}

interface DevinModelVariantSeed {
  readonly model: string;
  readonly label?: string;
  readonly maxContextTokens?: number;
}

function readDevinModelString(
  model: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = model[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readDevinModelNumber(
  model: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const value = model[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parseDevinModelVariant(value: unknown): DevinModelVariantSeed | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const model = readDevinModelString(value, ["model_uid", "modelUid", "uid", "model", "id"]);
  if (!model) {
    return undefined;
  }
  const label = readDevinModelString(value, ["label", "name", "displayName", "title"]);
  const maxContextTokens = readDevinModelNumber(value, [
    "max_context_tokens",
    "maxContextTokens",
    "context_window_tokens",
    "contextWindowTokens",
  ]);
  return {
    model,
    ...(label ? { label } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  };
}

function parseDevinModelFamily(
  value: Record<string, unknown>,
): DevinModelDescriptorSeed | undefined {
  const hasVariantIdentity =
    readDevinModelString(value, ["model_uid", "modelUid", "uid"]) !== undefined;
  const slug = readDevinModelString(
    value,
    hasVariantIdentity
      ? ["family_uid", "familyUid", "slug"]
      : ["slug", "family_uid", "familyUid", "id", "model"],
  );
  if (!slug) {
    return undefined;
  }

  const variants = Array.isArray(value.variants)
    ? value.variants
        .map(parseDevinModelVariant)
        .filter((variant): variant is DevinModelVariantSeed => variant !== undefined)
    : [];
  const name = readDevinModelString(value, ["family_label", "name", "label", "displayName"]);
  const description = readDevinModelString(value, ["description", "details"]);
  return {
    slug,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(variants.length > 0 ? { variants } : {}),
  };
}

function collectDevinModelDescriptors(
  value: unknown,
  models: DevinModelDescriptorSeed[],
  seen: Set<unknown>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDevinModelDescriptors(entry, models, seen);
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  const family = parseDevinModelFamily(value);
  if (family) {
    models.push(family);
    // a family owns its variants — recursing into them as independent families loses the effort matrix
    for (const [key, nested] of Object.entries(value)) {
      if (key === "variants") {
        continue;
      }
      if (Array.isArray(nested) || isRecord(nested)) {
        collectDevinModelDescriptors(nested, models, seen);
      }
    }
    return;
  }

  const concreteModel = readDevinModelString(value, ["model_uid", "modelUid", "uid"]);
  if (concreteModel) {
    const name = readDevinModelString(value, ["label", "name", "displayName", "title"]);
    models.push({ slug: concreteModel, ...(name ? { name } : {}) });
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectDevinModelDescriptors(nested, models, seen);
    }
  }
}

export function parseDevinCliModelList(stdout: string): DevinModelDescriptorSeed[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>([trimmed]);
  const firstObject = trimmed.search(/[[{]/u);
  const lastObject = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(trimmed.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.replace(/^\uFEFF/u, ""));
      const models: DevinModelDescriptorSeed[] = [];
      collectDevinModelDescriptors(parsed, models, new Set());
      return models;
    } catch {}
  }
  return [];
}

function formatDevinContextWindow(value: number | undefined, model: string): string | undefined {
  if (value !== undefined) {
    if (value >= 1_000_000 && value % 1_000_000 === 0) {
      return `${value / 1_000_000}m`;
    }
    if (value >= 1_000 && value % 1_000 === 0) {
      return `${value / 1_000}k`;
    }
    return String(value);
  }
  const suffix = model.match(/(?:^|[-_])(\d+(?:\.\d+)?m)(?:$|[-_])/iu)?.[1];
  return suffix?.toLowerCase();
}

function inferDevinReasoningEffort(variant: DevinModelVariantSeed): string | undefined {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase().replace(/[_.-]+/gu, " ");
  if (/\b(?:no thinking|none|off)\b/u.test(haystack)) return "none";
  if (/\bminimal\b/u.test(haystack)) return "minimal";
  if (/\blow\b/u.test(haystack)) return "low";
  if (/\bmedium\b/u.test(haystack)) return "medium";
  if (/\bxhigh\b|\bextra high\b/u.test(haystack)) return "xhigh";
  if (/\bhigh\b/u.test(haystack)) return "high";
  if (/\bmax\b/u.test(haystack)) return "max";
  return undefined;
}

function isDevinFastVariant(variant: DevinModelVariantSeed): boolean {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase();
  return (
    /\b(?:fast|lightning)\b/u.test(haystack) || /(?:^|[-_])priority(?:$|[-_])/u.test(variant.model)
  );
}

function isDevinThinkingVariant(variant: DevinModelVariantSeed): boolean {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase().replace(/[_.-]+/gu, " ");
  return (
    /\bthinking\b/u.test(haystack) &&
    !/\bno thinking\b/u.test(haystack) &&
    inferDevinReasoningEffort(variant) === undefined
  );
}

const DEVIN_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const DEVIN_EFFORT_ORDER: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function mergeDevinModelDescriptors(
  groups: ReadonlyArray<ReadonlyArray<DevinModelDescriptorSeed>>,
): Array<ProviderModelDescriptor> {
  const models: ProviderModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) continue;
      seen.add(key);
      const name = model.name?.trim() || humanizeModelSlug(slug);
      const rawVariants = model.variants ?? [];
      const effortValues = uniqueStrings(rawVariants.map(inferDevinReasoningEffort)).toSorted(
        (left, right) => DEVIN_EFFORT_ORDER.indexOf(left) - DEVIN_EFFORT_ORDER.indexOf(right),
      );
      const rawContextValues = uniqueStrings(
        rawVariants.map((variant) =>
          formatDevinContextWindow(variant.maxContextTokens, variant.model),
        ),
      );
      const contextWindowValues = rawContextValues.length > 1 ? rawContextValues : [];
      const defaultContextWindow =
        contextWindowValues.length > 0
          ? (rawVariants
              .map((variant) => formatDevinContextWindow(variant.maxContextTokens, variant.model))
              .find((value) => value === undefined) ?? contextWindowValues[0])
          : undefined;
      const hasFastMode = rawVariants.some(isDevinFastVariant);
      const hasThinkingVariant = rawVariants.some(isDevinThinkingVariant);
      const hasPlainThinkingVariant = rawVariants.some(
        (variant) =>
          !isDevinThinkingVariant(variant) && inferDevinReasoningEffort(variant) === undefined,
      );
      const hasThinkingToggle = hasThinkingVariant && hasPlainThinkingVariant;
      const modelVariants = rawVariants.map((variant) => {
        const reasoningEffort = inferDevinReasoningEffort(variant);
        const contextWindow = formatDevinContextWindow(variant.maxContextTokens, variant.model);
        return {
          model: variant.model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(contextWindowValues.length > 0 && contextWindow ? { contextWindow } : {}),
          ...(hasFastMode ? { fastMode: isDevinFastVariant(variant) } : {}),
          ...(hasThinkingToggle ? { thinking: isDevinThinkingVariant(variant) } : {}),
        };
      });
      const defaultVariant = rawVariants.find(
        (variant) =>
          !isDevinFastVariant(variant) &&
          !isDevinThinkingVariant(variant) &&
          (contextWindowValues.length === 0 ||
            formatDevinContextWindow(variant.maxContextTokens, variant.model) ===
              defaultContextWindow),
      );
      const defaultReasoningEffort =
        inferDevinReasoningEffort(defaultVariant ?? rawVariants[0] ?? { model: "" }) ??
        effortValues[0];
      const contextWindowOptions = contextWindowValues.map((value) =>
        value === defaultContextWindow
          ? { value, label: value.toUpperCase(), isDefault: true as const }
          : { value, label: value.toUpperCase() },
      );
      models.push({
        slug,
        name,
        ...(model.description ? { description: model.description } : {}),
        ...(effortValues.length > 0
          ? {
              supportedReasoningEfforts: effortValues.map((value) => ({
                value,
                label: DEVIN_EFFORT_LABELS[value] ?? humanizeModelSlug(value),
              })),
              ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            }
          : {}),
        ...(hasFastMode ? { supportsFastMode: true } : {}),
        ...(hasThinkingToggle ? { supportsThinkingToggle: true } : {}),
        ...(contextWindowOptions.length > 1
          ? {
              contextWindowOptions,
              ...(defaultContextWindow ? { defaultContextWindow } : {}),
            }
          : {}),
        ...(modelVariants.length > 0 ? { modelVariants } : {}),
      });
    }
  }
  return models;
}

export function buildDevinStaticModelDescriptors(): ReadonlyArray<ProviderModelDescriptor> {
  return MODEL_OPTIONS_BY_PROVIDER.devin.map((modelDefinition) => {
    const caps = getModelCapabilities(PROVIDER, modelDefinition.slug);
    const modelVariants = getDevinStaticModelVariants(modelDefinition.slug);
    return {
      slug: modelDefinition.slug,
      name: modelDefinition.name,
      optionDescriptors: getProviderOptionDescriptors({
        provider: PROVIDER,
        caps,
      }),
      supportsFastMode: caps.supportsFastMode,
      supportsThinkingToggle: caps.supportsThinkingToggle,
      contextWindowOptions: caps.contextWindowOptions,
      supportedReasoningEfforts: caps.reasoningEffortLevels,
      defaultReasoningEffort: caps.reasoningEffortLevels.find((o) => o.isDefault)?.value,
      ...(modelVariants ? { modelVariants } : {}),
    };
  });
}

export function buildDevinPromptMeta(interactionMode: ProviderInteractionMode): {
  readonly mode: "plan" | "agent";
} {
  // Devin reconciles its native Plan tracker from session/prompt _meta.mode — idempotent, so reconnects can't invert state on resend
  return { mode: interactionMode === "plan" ? "plan" : "agent" };
}

function redactDevinDiscoveryError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return String(redactAcpLogSecrets(message));
}

function acpToAdapterError(threadId: ThreadId) {
  return (cause: { readonly message: string }) =>
    new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: cause.message,
      cause,
    });
}

function buildDevinPromptParts(input: {
  readonly text: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<Array<Acp.ContentBlock>, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const promptText = appendFileAttachmentsPromptBlock({
      text: input.text
        ? withAcpPlanModePrompt({
            text: input.text.trim(),
            interactionMode: input.interactionMode,
            promptPrefix: DEVIN_PLAN_MODE_PROMPT_PREFIX,
          })
        : undefined,
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
      include: "all-files",
    });

    const promptParts: Array<Acp.ContentBlock> = [];
    if (promptText?.trim()) {
      promptParts.push({ type: "text", text: promptText });
    }

    promptParts.push(
      ...(yield* loadProviderPromptImageBlocks({
        attachments: input.attachments,
        attachmentsDir: input.attachmentsDir,
        provider: PROVIDER,
        method: "session/prompt",
        readFile: input.fileSystem.readFile,
      })),
    );
    return promptParts;
  });
}

// the ACP process takes a concrete model UID as --model, not effort/context flags; reasoning-effort labels are never model identifiers
export function resolveDevinStartModel<E, R>(input: {
  readonly explicitModel: string | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: DevinModelOptions | undefined;
      }
    | undefined;
  readonly discoverModels: () => Effect.Effect<ProviderListModelsResult, E, R>;
}): Effect.Effect<string | undefined, E | ProviderAdapterValidationError, R> {
  const modelSelection = input.modelSelection;
  const options = modelSelection?.options;
  const traitsNeedResolution =
    trimOrNull(options?.reasoningEffort) !== null ||
    options?.fastMode !== undefined ||
    options?.thinking !== undefined ||
    trimOrNull(options?.contextWindow) !== null;
  const resolveVariant = (runtimeModel?: ProviderModelDescriptor) =>
    resolveDevinModelVariant({
      model: modelSelection?.model,
      modelVariant: options?.modelVariant,
      reasoningEffort: options?.reasoningEffort,
      fastMode: options?.fastMode,
      thinking: options?.thinking,
      contextWindow: options?.contextWindow,
      ...(runtimeModel ? { runtimeModel } : {}),
    });
  const resolve = (runtimeModel?: ProviderModelDescriptor) =>
    resolveVariant(runtimeModel) ?? modelSelection?.model ?? input.explicitModel;
  if (!modelSelection || !traitsNeedResolution) {
    return Effect.succeed(resolve());
  }

  return input.discoverModels().pipe(
    Effect.flatMap((result) => {
      const normalizedSelection =
        normalizeModelSlug(modelSelection.model, PROVIDER) ?? modelSelection.model;
      const runtimeModel = result.models.find((candidate) => {
        const normalizedCandidate = normalizeModelSlug(candidate.slug, PROVIDER) ?? candidate.slug;
        return (
          normalizedCandidate === normalizedSelection ||
          candidate.modelVariants?.some((variant) => variant.model === modelSelection.model) ===
            true
        );
      });
      const resolvedModel = resolveVariant(runtimeModel);
      if (resolvedModel !== undefined) {
        return Effect.succeed(resolvedModel);
      }
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "resolveDevinStartModel",
          issue: `Could not resolve the requested traits to a concrete variant for Devin model '${modelSelection.model}'. Refresh models or clear the unsupported trait selection.`,
        }),
      );
    }),
  );
}

// a tool call mapped to an older turn keeps that provenance even while a newer turn is active — current-turn failure state applies only when the resolved turn is active
export function resolveDevinToolCallUpdatedTurnId(input: {
  readonly toolCallId: string;
  readonly activeTurnId: TurnId | undefined;
  readonly resumeReplayReady: boolean;
  readonly toolCallTurnIds: ReadonlyMap<string, TurnId>;
}): TurnId | undefined {
  if (input.resumeReplayReady) {
    return undefined;
  }
  const recordedTurnId = input.toolCallTurnIds.get(input.toolCallId);
  if (recordedTurnId !== undefined && recordedTurnId !== input.activeTurnId) {
    return recordedTurnId;
  }
  return input.activeTurnId;
}

export function pruneDevinToolCallTurnIds(
  toolCallTurnIds: Map<string, TurnId>,
  keepTurnId: TurnId | undefined,
): void {
  for (const [toolCallId, mappedTurnId] of toolCallTurnIds) {
    if (mappedTurnId !== keepTurnId) {
      toolCallTurnIds.delete(toolCallId);
    }
  }
}

function settleDevinActiveTurn(ctx: DevinSessionContext, turnId: TurnId): boolean {
  if (!clearAcpActiveTurn(ctx, turnId)) {
    return false;
  }
  ctx.lastSettledTurnId = turnId;
  clearDevinActiveToolCallIdleState(ctx);
  return true;
}

function resolveDevinCurrentIdleTimeoutMs(
  ctx: Pick<DevinSessionContext, "devinToolCallLifecycleById">,
  timeouts: DevinAdapterTimeouts,
): number {
  for (const lifecycle of ctx.devinToolCallLifecycleById.values()) {
    if (lifecycle === "active") {
      return timeouts.toolIdleMs;
    }
  }
  return timeouts.turnIdleMs;
}

function updateDevinToolCallIdleState(
  ctx: Pick<DevinSessionContext, "devinToolCallLifecycleById">,
  toolCall: AcpToolCallState,
): void {
  const { toolCallId, status } = toolCall;
  if (status === "completed" || status === "failed") {
    ctx.devinToolCallLifecycleById.set(toolCallId, "terminal");
    return;
  }
  if (
    (status === "pending" || status === "inProgress") &&
    ctx.devinToolCallLifecycleById.get(toolCallId) !== "terminal"
  ) {
    ctx.devinToolCallLifecycleById.set(toolCallId, "active");
  }
}

function clearDevinActiveToolCallIdleState(ctx: DevinSessionContext): void {
  ctx.devinToolCallLifecycleById.clear();
}

export function closeDevinSessionResources(input: {
  readonly scope: Scope.Closeable;
  readonly config: Pick<DevinSessionConfig, "cleanup"> | undefined;
}) {
  return Effect.gen(function* () {
    yield* Effect.ignore(Scope.close(input.scope, Exit.void));
    if (input.config) {
      yield* Effect.tryPromise(input.config.cleanup).pipe(
        Effect.catch(() => Effect.logWarning("devin.acp.session_config_cleanup_failed")),
      );
    }
  });
}

export function makeDevinAdapter(
  devinSettings: DevinAcpRuntimeSettings = {},
  options?: DevinAdapterLiveOptions,
) {
  const timeouts = options?.timeouts ?? resolveDevinAdapterTimeouts();
  const watchdogIntervalMs = Math.min(5_000, timeouts.turnIdleMs, timeouts.toolIdleMs);
  const wedge = options?.wedgeRecovery ?? resolveDevinWedgeRecoveryOptions();

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const createAcpRuntime = options?.makeAcpRuntime ?? makeDevinAcpRuntime;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );

    let nativeEventLogger = options?.nativeEventLogger;
    let managedNativeEventLogger: EventNdjsonLogger | undefined;
    if (nativeEventLogger === undefined && options?.nativeEventLogPath !== undefined) {
      managedNativeEventLogger = yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
        stream: "native",
      });
      nativeEventLogger = managedNativeEventLogger;
    }

    const sessions = new Map<ThreadId, DevinSessionContext>();
    // recovery budget lives at adapter level so it survives session restarts (each recovery replaces the session context)
    const wedgeRecoveryAtByThread = new Map<ThreadId, number[]>();
    const wedgeRecoveries = new Map<
      ThreadId,
      { turnId: TurnId; cancelled: Deferred.Deferred<void> }
    >();
    const cancelWedgeRecovery = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const recovery = wedgeRecoveries.get(threadId);
        if (!recovery || (turnId !== undefined && recovery.turnId !== turnId)) return false;
        wedgeRecoveries.delete(threadId);
        yield* Deferred.succeed(recovery.cancelled, undefined);
        return true;
      });
    // recoveries fork outside the session scope — a fiber inside it would be interrupted mid-recovery when the scope closes
    const wedgeRecoveryScope = yield* Scope.make("sequential");
    const commandDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListCommandsResult }
    >();
    const discoveryLock = yield* Semaphore.make(1);
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const makeDevinDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
    }) =>
      createAcpRuntime({
        devinSettings: {
          ...(devinSettings.binaryPath ? { binaryPath: devinSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        runtimeMode: "approval-required",
        clientInfo: { name: "Synara Command Discovery", version: "0.0.0" },
      });

    const discoverDevinModelsUncached = (binaryPath: string) => {
      const fallbackResult = {
        models: buildDevinStaticModelDescriptors(),
        source: "devin.static",
        cached: false,
      } satisfies ProviderListModelsResult;

      return Effect.gen(function* () {
        let discoveryError: string | undefined;
        const cliModels = yield* Effect.gen(function* () {
          const childEnv = buildProviderChildEnvironment({ provider: PROVIDER });
          const child = yield* childProcessSpawner.spawn(
            makeEffectProcessCommand(binaryPath, ["models", "list", "--format", "json"], {
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
            discoveryError = redactDevinDiscoveryError(
              stderr.trim() ||
                `Devin model discovery failed because '${binaryPath} models list' exited with code ${exitCode}.`,
            );
            return [];
          }
          return parseDevinCliModelList(stdout);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              discoveryError = redactDevinDiscoveryError(error);
              return [];
            }),
          ),
        );

        if (cliModels.length === 0 && discoveryError === undefined) {
          discoveryError = `'${binaryPath} models list' returned no models.`;
        }

        const models =
          cliModels.length > 0 ? mergeDevinModelDescriptors([cliModels]) : fallbackResult.models;

        return {
          models,
          source: cliModels.length > 0 ? "devin-cli" : fallbackResult.source,
          cached: false,
          ...(discoveryError !== undefined ? { error: discoveryError } : {}),
        } satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.succeed({
                ...fallbackResult,
                error: `Timed out after ${Math.round(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s while discovering Devin models via CLI.`,
              } satisfies ProviderListModelsResult),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );
    };
    const discoverDevinModels = makeCachedDevinModelDiscovery({
      discoveryLock,
      discover: discoverDevinModelsUncached,
    });

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
      ctx: DevinSessionContext,
      payload: AcpPlanUpdate,
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

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        clearDevinActiveToolCallIdleState(ctx);
        ctx.devinStallWatchDetectedAt = undefined;
        ctx.devinSpawnStalls.clear();
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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
        yield* closeDevinSessionResources({
          scope: ctx.scope,
          config: ctx.devinSessionConfig,
        });
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const waitForDevinQueuedTurnEventsDrained = (ctx: DevinSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
        pollMs: DEVIN_TURN_SETTLE_DRAIN_POLL_MS,
      });

    const noteSuppressedDevinRuntimeEvent = (
      ctx: DevinSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isDevinAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("devin.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const activeTurnIdForDevinRuntimeEvent = (ctx: DevinSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedDevinRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.compactingThread) {
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedDevinRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    const emitDevinContextCompactionRuntimeEvent = (
      ctx: DevinSessionContext,
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
          itemId: RuntimeItemId.makeUnsafe(`devin-compaction:${ctx.threadId}`),
          payload: {
            itemType: "context_compaction",
            status: input.status,
            title: input.title,
            ...(input.detail ? { detail: input.detail } : {}),
          },
        });
      });

    // wait (bounded) for the notification consumer to go quiet so state from queued events is visible before deciding the outcome
    const settleDevinCompactionOutcome = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        // drain events already enqueued at prompt-resolve first — the quiet window covers in-transit stragglers, not the existing backlog
        yield* waitForDevinQueuedTurnEventsDrained(ctx);
        const startedAt = Date.now();
        while (true) {
          const now = Date.now();
          const lastActivityAt = Math.max(ctx.lastTurnActivityAt ?? 0, startedAt);
          if (
            now - lastActivityAt >= DEVIN_COMPACT_OUTCOME_QUIET_MS ||
            now - startedAt >= DEVIN_COMPACT_OUTCOME_MAX_WAIT_MS
          ) {
            return;
          }
          yield* Effect.sleep(50);
        }
      });

    const waitForAbandonedDevinCompaction = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        const cancelFiber = ctx.compactionCancelFiber;
        if (cancelFiber !== undefined) {
          yield* Fiber.join(cancelFiber).pipe(
            Effect.ignoreCause(),
            Effect.timeoutOption(DEVIN_COMPACT_CANCEL_WAIT_MS),
          );
          ctx.compactionCancelFiber = undefined;
          if (ctx.compactionQuietUntil !== undefined) {
            ctx.compactionQuietUntil = Math.max(
              ctx.compactionQuietUntil,
              Date.now() + DEVIN_COMPACT_ABANDON_QUIET_MS,
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

    // keep suppression until the replay stream is genuinely quiet — a fixed timeout lets historical deltas leak into the first turn
    const settleDevinResumeReplayWhenQuiet = (ctx: DevinSessionContext) =>
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
            quietForMs >= DEVIN_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning("devin.acp.resume_replay_quiet_wait_timeout", {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(DEVIN_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
      });

    const startSession: DevinAdapterShape["startSession"] = (input) =>
      cancelWedgeRecovery(input.threadId).pipe(Effect.andThen(startDevinSession(input)));

    const startDevinSession = (
      input: Parameters<DevinAdapterShape["startSession"]>[0],
      recoverySession?: DevinSessionContext,
    ): ReturnType<DevinAdapterShape["startSession"]> =>
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

          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const devinModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;

          const existing = sessions.get(input.threadId);
          // Recheck under the lock: a user turn may start while recovery waits.
          if (
            recoverySession !== undefined &&
            (existing !== recoverySession ||
              existing.stopped ||
              existing.activeTurnId !== undefined ||
              existing.turnStarting)
          ) {
            return yield* Effect.interrupt;
          }
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

          const devinSessionConfig = yield* Effect.tryPromise({
            try: async () => {
              if (!gatewaySessionLease || !agentGatewayCredentials) return undefined;
              const bootstrapToken = gatewaySessionLease.issueStdioBootstrapToken?.();
              if (!bootstrapToken)
                throw new Error("Synara gateway bootstrap token was unavailable.");
              return createDevinSessionConfig({
                connection: gatewaySessionLease.connection,
                stdioProxy: agentGatewayCredentials.stdioProxy,
                bootstrapToken,
              });
            },
            catch: (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/start",
                detail:
                  error instanceof Error ? error.message : "Failed to install Devin MCP config.",
              }),
          });
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !devinSessionConfig
              ? Effect.void
              : Effect.promise(devinSessionConfig.cleanup),
          );

          let ctx!: DevinSessionContext;
          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isDevinAcpDebugEnabled(),
            provider: PROVIDER,
            marker: DEVIN_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: DEVIN_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: (payload) => payload.includes("devinShell"),
          });
          const providerDevinOptions = readDevinProviderStartOptions(input.providerOptions);
          const discoveryBinaryPath = resolveDevinBinaryPath(
            providerDevinOptions?.binaryPath?.trim() || devinSettings.binaryPath,
          );
          const effectiveModel = yield* resolveDevinStartModel({
            explicitModel: devinSettings.model,
            modelSelection: devinModelSelection,
            discoverModels: () => discoverDevinModels(discoveryBinaryPath),
          });
          const effectiveDevinSettings: DevinAcpRuntimeSettings = {
            ...(devinSettings.binaryPath !== undefined
              ? { binaryPath: devinSettings.binaryPath }
              : {}),
            ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
            ...(providerDevinOptions?.binaryPath !== undefined
              ? { binaryPath: providerDevinOptions.binaryPath }
              : {}),
          };

          yield* Effect.logInfo("devin.acp.start", {
            marker: DEVIN_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: DEVIN_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveDevinSettings.model,
            requestedModel: devinModelSelection?.model,
            modelVariant: devinModelSelection?.options?.modelVariant,
            reasoningEffort: devinModelSelection?.options?.reasoningEffort,
            apiKeyConfigured: hasDevinApiKeyEnv(),
            alwaysApprove: input.runtimeMode === "full-access",
            binaryPath: effectiveDevinSettings.binaryPath ?? "devin",
          });

          // stderr wedge tap runs before ctx is assigned — every access guards on the binding; startup lines carry no active turn
          const onChildStderrLine = (line: string) => {
            if (line.includes(DEVIN_STALL_WATCH_LOG_PATTERN)) {
              if (ctx?.activeTurnId !== undefined && ctx.devinStallWatchDetectedAt === undefined) {
                ctx.devinStallWatchDetectedAt = Date.now();
              }
              return;
            }
            const spawnStart = DEVIN_SPAWN_START_LOG_PATTERN.exec(line);
            if (spawnStart) {
              ctx?.devinSpawnStalls.set(spawnStart[1]!, Date.now());
              return;
            }
            const spawnReady = DEVIN_SPAWN_READY_LOG_PATTERN.exec(line);
            if (spawnReady) {
              ctx?.devinSpawnStalls.delete(spawnReady[1]!);
            }
          };

          const acp = yield* createAcpRuntime({
            devinSettings: effectiveDevinSettings,
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            clientInfo: { name: "Synara", version: "0.0.0" },
            clientCapabilities: { elicitation: { form: {} } },
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(devinSessionConfig ? { sessionConfig: devinSessionConfig } : {}),
            onChildStderrLine,
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(acpToAdapterError(input.threadId)),
          );

          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);

                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  return { outcome: policyOutcome };
                }

                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });

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

                if (resolved === "cancel") {
                  return { outcome: { outcome: "cancelled" } as const };
                }

                const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
                return selectedOptionId === undefined
                  ? { outcome: { outcome: "cancelled" } as const }
                  : {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: selectedOptionId,
                      },
                    };
              }),
            );

            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);

                if (!isFormElicitationRequest(params)) {
                  return {
                    action: "decline",
                  } satisfies Acp.CreateElicitationResponse;
                }

                const questions = elicitationQuestionsFromRequest(params);
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
                  payload: { questions },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
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
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });

                return elicitationResponseFromAnswers(params, resolved);
              }).pipe(
                Effect.catch(() =>
                  Effect.succeed({
                    action: "decline",
                  } as Acp.CreateElicitationResponse),
                ),
              ),
            );

            return yield* acp.start().pipe(
              Effect.mapError((cause) =>
                resumeSessionId !== undefined &&
                cause instanceof AcpRequestError &&
                cause.errorMessage.trim().toLowerCase() === "failed to load session data"
                  ? new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: cause.message,
                      reason: "resume-state-unavailable",
                      cause,
                    })
                  : acpToAdapterError(input.threadId)(cause),
              ),
            );
          });

          const resumeReplayReady =
            resumeSessionId !== undefined ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            // keep the family slug in the session projection — reporting the variant UID would make the reactor restart Devin on every turn
            model: devinModelSelection?.model ?? effectiveDevinSettings.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DEVIN_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            lifecycleGeneration: input.lifecycleGeneration,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            activePromptResolved: false,
            lastSettledTurnId: undefined,
            lastPlanFingerprint: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            devinToolCallLifecycleById: new Map(),
            devinStallWatchDetectedAt: undefined,
            devinSpawnStalls: new Map(),
            devinWedgeRecoveryAttemptedFor: undefined,
            devinWedgeRecoveryInFlight: false,
            devinStartModelSelection: input.modelSelection,
            devinStartProviderOptions: input.providerOptions,
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
            gatewaySessionLease,
            devinSessionConfig,
          };

          yield* forkDevinWedgeSupervisor(ctx);

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // only genuine turn-progress events reset the watchdog — mode/config/usage heartbeats must not mask a hung turn
                if (event._tag !== "ToolCallUpdated" && isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                  ctx.devinStallWatchDetectedAt = undefined;
                  // a wedged create_session emits no ACP events, so progress proves a recorded spawn stall is failed-not-hung — drop it before its timeout misfires
                  ctx.devinSpawnStalls.clear();
                }
                switch (event._tag) {
                  case "ModeChanged":
                    return;

                  case "AssistantItemStarted":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;

                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeDevinRuntimeItemIdForTurn(
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isDevinAcpDebugEnabled()) {
                          yield* Effect.logInfo("devin.acp.empty_assistant_item_suppressed", {
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
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;

                  case "ToolCallUpdated":
                    {
                      if (ctx.compactingThread) {
                        const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                        if (failedToolDetail !== undefined) {
                          ctx.compactionFailedToolDetail = failedToolDetail;
                        }
                        return;
                      }
                      const recordedTurnId = resolveDevinToolCallUpdatedTurnId({
                        toolCallId: event.toolCall.toolCallId,
                        activeTurnId: ctx.activeTurnId,
                        resumeReplayReady: ctx.resumeReplayReady !== undefined,
                        toolCallTurnIds: ctx.turnToolCallIds,
                      });
                      if (recordedTurnId !== undefined && recordedTurnId !== ctx.activeTurnId) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: recordedTurnId,
                            toolCall: scopeDevinToolCallStateForTurn(
                              recordedTurnId,
                              event.toolCall,
                            ),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.lastTurnActivityAt = Date.now();
                      ctx.devinStallWatchDetectedAt = undefined;
                      ctx.devinSpawnStalls.clear();
                      updateDevinToolCallIdleState(ctx, event.toolCall);
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
                          toolCall: scopeDevinToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;

                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeDevinRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableDevinAssistantDelta(event)) {
                        ctx.activeTurnHadAssistantContent = true;
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
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
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
                          method: "session/update",
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }).pipe(
                // bump the processed count only after the handler fully ran so drain-waiters can't observe an event as consumed mid-apply
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                    options?.onSessionUpdateProcessed?.();
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // startup finalization runs after the consumer fork while replay keeps draining — any failure/interruption of remaining steps must tear the session down explicitly
          yield* Effect.gen(function* () {
            yield* applyDevinSessionConfiguration({
              runtime: acp,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
            });
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // settle replay in the background: suppression stays until quiet while startup blocks briefly; sendTurn/compactThread await the deferred so the first turn stays gated
              yield* settleDevinResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(DEVIN_RESUME_REPLAY_MAX_WAIT_MS),
              );
            }

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
              payload: { state: "ready", reason: "Devin ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
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

    const failDevinTurnAsTimedOut = (ctx: DevinSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!settleDevinActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Devin stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({
          id: turnId,
          items: [{ prompt: turnId, timedOut: true, idleMs }],
        });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("devin.acp.turn_idle_timeout", {
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
        // best-effort abandon + unwind the prompt fiber; the cancel is forked not awaited — a hung session/cancel must not block the interrupt
        yield* Effect.ignore(ctx.acp.cancel).pipe(Effect.forkIn(ctx.scope));
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    // auto-recovery: settle the wedged turn cancelled, restart from resume cursor, dispatch a continuation — every destructive step re-validates first; user stop/interrupt/new turn always wins
    const recoverDevinWedgedTurn = (ctx: DevinSessionContext, signal: DevinWedgeSignal) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        const stillOwnsTurn = () =>
          !ctx.stopped && sessions.get(ctx.threadId) === ctx && ctx.activeTurnId === turnId;
        if (turnId === undefined || ctx.stopped) return;
        if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) return;
        if (ctx.devinWedgeRecoveryAttemptedFor === turnId) return;
        const threadRecoveries = wedgeRecoveryAtByThread.get(ctx.threadId) ?? [];
        if (
          !canRecoverDevinWedge({
            recoveryAt: threadRecoveries,
            now: Date.now(),
            maxPerWindow: wedge.maxPerThread,
            windowMs: wedge.windowMs,
          })
        ) {
          yield* Effect.logWarning("devin.acp.wedge_recovery_budget_exhausted", {
            threadId: ctx.threadId,
            turnId,
            reason: signal.kind,
          });
          yield* failDevinTurnAsTimedOut(
            ctx,
            turnId,
            signal.kind === "stall-watch" ? signal.silentMs : signal.stalledMs,
          );
          return;
        }
        if (!stillOwnsTurn()) return;
        const recovery = { turnId, cancelled: yield* Deferred.make<void>() };
        wedgeRecoveries.set(ctx.threadId, recovery);
        yield* Effect.gen(function* () {
          ctx.devinWedgeRecoveryAttemptedFor = turnId;
          wedgeRecoveryAtByThread.set(ctx.threadId, [...threadRecoveries, Date.now()].slice(-16));
          yield* Effect.logWarning("devin.acp.wedge_recovery_started", {
            threadId: ctx.threadId,
            turnId,
            reason: signal.kind,
          });
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { message: DEVIN_WEDGE_RECOVERY_WARNING },
          });
          const resumeCursor = ctx.session.resumeCursor;
          const cwd = ctx.session.cwd;
          const runtimeMode = ctx.session.runtimeMode;
          const interactionMode = ctx.activeInteractionMode;
          if (!stillOwnsTurn() || wedgeRecoveries.get(ctx.threadId) !== recovery) return;
          yield* interruptDevinTurn(ctx.threadId, turnId);
          if (
            wedgeRecoveries.get(ctx.threadId) !== recovery ||
            ctx.stopped ||
            sessions.get(ctx.threadId) !== ctx ||
            ctx.activeTurnId !== undefined ||
            ctx.turnStarting
          ) {
            return;
          }
          const started = yield* startDevinSession(
            {
              provider: PROVIDER,
              threadId: ctx.threadId,
              lifecycleGeneration: ctx.lifecycleGeneration,
              cwd,
              runtimeMode,
              ...(ctx.devinStartModelSelection
                ? { modelSelection: ctx.devinStartModelSelection }
                : {}),
              ...(ctx.devinStartProviderOptions
                ? { providerOptions: ctx.devinStartProviderOptions }
                : {}),
              resumeCursor,
            },
            ctx,
          );
          const restarted = sessions.get(ctx.threadId);
          if (
            wedgeRecoveries.get(ctx.threadId) !== recovery ||
            restarted === undefined ||
            restarted.stopped ||
            restarted.session !== started ||
            restarted.activeTurnId !== undefined ||
            restarted.turnStarting
          ) {
            return;
          }
          yield* sendDevinTurn({
            threadId: ctx.threadId,
            input: DEVIN_WEDGE_RECOVERY_CONTINUATION_PROMPT,
            attachments: [],
            ...(interactionMode ? { interactionMode } : {}),
          });
        }).pipe(
          Effect.raceFirst(
            Deferred.await(recovery.cancelled).pipe(Effect.andThen(Effect.interrupt)),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause) || wedgeRecoveries.get(ctx.threadId) !== recovery)
                return;
              const detail = `Devin automatic recovery failed: ${Cause.pretty(cause)}`;
              yield* Effect.logError("devin.acp.wedge_recovery_failed", {
                threadId: ctx.threadId,
                reason: signal.kind,
                cause: Cause.pretty(cause),
              });
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: {
                  message: detail,
                  class: "transport_error",
                  detail: { reason: "synara.devin.wedge-recovery" },
                },
              });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (wedgeRecoveries.get(ctx.threadId) === recovery)
                wedgeRecoveries.delete(ctx.threadId);
            }),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.devinWedgeRecoveryInFlight = false;
          }),
        ),
      );

    const forkDevinWedgeSupervisor = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        const loop = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(wedge.checkIntervalMs);
            if (ctx.stopped) return;
            if (ctx.devinWedgeRecoveryInFlight) continue;
            const signal = evaluateDevinWedgeSignal({
              activeTurnId: ctx.activeTurnId,
              awaitingHuman: ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
              stallWatchDetectedAt: ctx.devinStallWatchDetectedAt,
              spawnStalls: ctx.devinSpawnStalls,
              now: Date.now(),
              stallFuseMs: wedge.stallFuseMs,
              spawnStallTimeoutMs: wedge.spawnStallTimeoutMs,
            });
            if (signal === undefined) continue;
            ctx.devinWedgeRecoveryInFlight = true;
            yield* recoverDevinWedgedTurn(ctx, signal).pipe(Effect.forkIn(wedgeRecoveryScope));
          }
        });
        return yield* loop.pipe(Effect.forkIn(ctx.scope));
      });

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) => sendDevinTurn(input, true);

    const sendDevinTurn = (
      input: Parameters<DevinAdapterShape["sendTurn"]>[0],
      userInitiated = false,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // compactThread holds the thread lock but sendTurn doesn't — reject a second prompt whose events suppression would drop; setting turnStarting in the same sync block closes the reverse gap
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cannot start a turn while Devin context compaction is in progress.",
          });
        }
        // a second sendTurn while one is starting would clear pendingTurnInterrupted (dispatching a cancelled turn) and race two ACP prompts — reject it
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Devin turn is still starting for this thread.",
          });
        }
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Devin turn is already active for this thread.",
          });
        }
        // an accepted user turn owns the session — let startup finish for it but block recovery's automatic continuation
        if (userInitiated) wedgeRecoveries.delete(input.threadId);
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startDevinTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startDevinTurn = (
      ctx: DevinSessionContext,
      input: Parameters<DevinAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.await(ctx.resumeReplayReady);
        }
        yield* waitForAbandonedDevinCompaction(ctx);
        // the setup gates resolve on stop too — a turn unblocked by failed/stopped startup must fail here, not emit lifecycle events for a dead session
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        // Model selection rides the process-start `--model` flag; only the fail-closed mode gate applies per turn.
        yield* applyDevinSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
        });

        const promptParts = yield* buildDevinPromptParts({
          text: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          interactionMode,
          fileSystem,
        });

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const harnessPolicy = takeSynaraHarnessPolicyTextPartForProviderSession(ctx, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: ctx.devinSessionConfig?.installed === true,
        });
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        // a stop landing during pre-prompt work must not publish turn.started (and a phantom cancelled) for a session that already exited
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // interrupts during pre-prompt waits are honored by the dispatch guard — the turn completes via the normal cancelled path, not a turn-start failure
        const keptTurnId = ctx.lastSettledTurnId;
        ctx.lastSettledTurnId = undefined;
        ctx.activeTurnId = turnId;
        clearDevinActiveToolCallIdleState(ctx);
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // a new turn starts with an unresolved prompt — a late interrupt stays free to cancel until ctx.acp.prompt returns
        ctx.activePromptResolved = false;
        pruneDevinToolCallTurnIds(ctx.turnToolCallIds, keptTurnId);
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        ctx.devinStallWatchDetectedAt = undefined;
        ctx.devinSpawnStalls.clear();

        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(model ? { model } : {}),
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });

        const runPrompt = Effect.suspend(() =>
          // interrupts during pre-prompt waits or before fiber registration set pendingTurnInterrupted — honor it (and concurrent stop) so a cancelled turn is never prompted; self-interrupt completes as cancelled
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({
                prompt: promptParts,
                _meta: buildDevinPromptMeta(interactionMode),
              }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                ctx.activePromptResolved = true;
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!settleDevinActiveTurn(ctx, turnId)) return;
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
                // transport/prompt failures make the ACP child unusable — unroute immediately so ProviderService recovers on next send
                yield* stopSessionInternal(ctx);
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                ctx.activePromptResolved = true;
                // Drain BEFORE snapshotting turn state: queued events may still set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!settleDevinActiveTurn(ctx, turnId)) return;
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
                  yield* Effect.logWarning("devin.acp.turn_completed_without_content", {
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
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason:
                      completion.state === "cancelled" &&
                      wedgeRecoveries.get(input.threadId)?.turnId === turnId
                        ? "synara.devin.wedge-recovery"
                        : (result.stopReason ?? null),
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
              if (!settleDevinActiveTurn(ctx, turnId)) return;
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({
                id: turnId,
                items: [{ prompt: promptParts, interrupted: true }],
              });
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
                  stopReason:
                    wedgeRecoveries.get(input.threadId)?.turnId === turnId
                      ? "synara.devin.wedge-recovery"
                      : "cancelled",
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
          idleTimeoutMs: timeouts.turnIdleMs,
          currentIdleTimeoutMs: () => resolveDevinCurrentIdleTimeoutMs(ctx, timeouts),
          checkIntervalMs: watchdogIntervalMs,
          onIdleTimeout: (idleMs) => failDevinTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: DevinAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const cancelledRecovery = yield* cancelWedgeRecovery(threadId, turnId);
        const ctx = sessions.get(threadId);
        if (cancelledRecovery && (!ctx || (turnId !== undefined && ctx.activeTurnId !== turnId)))
          return;
        yield* interruptDevinTurn(threadId, turnId);
      });

    const interruptDevinTurn: DevinAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning("devin.acp.stale_interrupt_ignored", {
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
            if (activePromptFiber !== undefined && !ctx.activePromptResolved) {
              yield* Fiber.interrupt(activePromptFiber);
            }
          }),
        );
      });

    const respondToRequest: DevinAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: DevinAdapterShape["respondToUserInput"] = (
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
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: DevinAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: snapshotProviderTurns(ctx.turns),
          cwd: ctx.session.cwd ?? null,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: DevinAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin does not support conversation rollback.",
        });
      });

    const stopSession: DevinAdapterShape["stopSession"] = (threadId) =>
      cancelWedgeRecovery(threadId).pipe(
        Effect.andThen(
          withThreadLock(
            threadId,
            Effect.gen(function* () {
              const ctx = sessions.get(threadId);
              if (!ctx) return;
              yield* stopSessionInternal(ctx);
            }),
          ),
        ),
      );

    const listSessions: DevinAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<DevinAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listCommands: NonNullable<DevinAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) => {
      const cwd = resolveAcpSessionCwd({
        inputCwd: input.cwd,
        serverCwd: serverConfig.cwd,
        homeDir: serverConfig.homeDir,
      });
      const cacheKey =
        cwd === undefined
          ? undefined
          : `${input.binaryPath?.trim() || devinSettings.binaryPath?.trim() || "devin"}\u0000${cwd}`;
      const cached = cacheKey === undefined ? undefined : commandDiscoveryCache.get(cacheKey);
      if (
        cacheKey !== undefined &&
        input.forceReload !== true &&
        cached &&
        cached.expiresAt > Date.now()
      ) {
        return Effect.succeed({ ...cached.result, cached: true });
      }
      return discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listCommands",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const binaryPath =
            input.binaryPath?.trim() || devinSettings.binaryPath?.trim() || "devin";
          const cacheKey = `${binaryPath}\u0000${cwd}`;
          const cached = commandDiscoveryCache.get(cacheKey);
          if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }

          const runtime = yield* makeDevinDiscoveryRuntime({
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            cwd,
          });
          yield* runtime.start();
          let commands = yield* runtime.getAvailableCommands;
          const startedAt = Date.now();
          while (commands.length === 0 && Date.now() - startedAt < 500) {
            yield* Effect.sleep(25);
            commands = yield* runtime.getAvailableCommands;
          }
          const result = {
            commands: mapDevinAcpCommands(commands),
            source: "devin-acp",
            cached: false,
          } satisfies ProviderListCommandsResult;
          setDevinDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + DEVIN_COMMAND_DISCOVERY_CACHE_MS,
            result,
          });
          return result;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof ProviderAdapterValidationError
              ? cause
              : mapAcpToAdapterError(
                  PROVIDER,
                  ThreadId.makeUnsafe("devin-command-discovery"),
                  "command/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(DEVIN_COMMAND_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "command/list",
                    detail: "Timed out while discovering Devin commands over ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );
    };

    const compactThread: NonNullable<DevinAdapterShape["compactThread"]> = (threadId) =>
      Effect.gen(function* () {
        // wait for settling replay before taking the thread lock — stopping resolves the deferred early, so awaiting under the lock would stall stop/restart
        const preLockCtx = yield* requireSession(threadId);
        if (preLockCtx.sessionConfigReady !== undefined) {
          yield* Deferred.await(preLockCtx.sessionConfigReady);
        }
        if (preLockCtx.resumeReplayReady !== undefined) {
          yield* Deferred.await(preLockCtx.resumeReplayReady);
        }
        // claim the slot under the lock but run /compact outside it — a hung compaction must never block stopSessionInternal's cancel/kill
        const ctx = yield* withThreadLock(threadId, claimDevinCompactionSlot(threadId, preLockCtx));
        return yield* runDevinCompaction(ctx).pipe(
          // compactingThread stays set until this clears it — clearing early would let a new turn start then be trailed by stale compaction bookkeeping
          Effect.ensuring(
            Effect.sync(() => {
              ctx.compactingThread = false;
            }),
          ),
        );
      });

    const claimDevinCompactionSlot = (threadId: ThreadId, preLockCtx: DevinSessionContext) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // the pre-lock wait resolves early on stop — if a restart won the lock, this thread now maps to a session the compaction never targeted
        if (ctx !== preLockCtx) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue:
              "The Devin session was restarted while waiting to compact; retry once it settles.",
          });
        }
        if (ctx.resumeReplayReady !== undefined) {
          // the session restarted while waiting and its new replay window is still settling — reject instead of blocking the lock
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while the resumed Devin thread is still replaying history.",
          });
        }
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "A Devin context compaction is already in progress.",
          });
        }
        if (ctx.activeTurnId !== undefined || ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while a Devin turn is still active.",
          });
        }
        ctx.compactingThread = true;
        ctx.compactionFailedToolDetail = undefined;
        return ctx;
      });

    const failDevinCompaction = (ctx: DevinSessionContext, title: string, detail: string) =>
      Effect.gen(function* () {
        yield* emitDevinContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.completed",
          status: "failed",
          title,
          detail,
        });
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail,
          }),
        );
      });

    const runDevinCompaction = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        yield* waitForAbandonedDevinCompaction(ctx);
        yield* emitDevinContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.updated",
          status: "inProgress",
          title: "Compacting context",
        });

        const compactResult = yield* runDevinAcpCompactionCommand(ctx.acp).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/prompt", error),
          ),
          Effect.timeoutOption(DEVIN_COMPACT_TIMEOUT_MS),
          Effect.exit,
        );

        if (Exit.isFailure(compactResult)) {
          // Interruption (session stopping) is not a compaction failure; let it unwind.
          if (Cause.hasInterruptsOnly(compactResult.cause)) {
            return yield* Effect.failCause(compactResult.cause);
          }
          const squashed = Cause.squash(compactResult.cause);
          const detail = squashed instanceof Error ? squashed.message : String(squashed);
          return yield* failDevinCompaction(ctx, "Context compaction failed", detail);
        }

        const promptResponse = Option.getOrUndefined(compactResult.value);
        if (promptResponse === undefined) {
          // timed out: fork a best-effort cancel and suppress stragglers so the next turn can't inherit stale updates — the child just proved it can go silent, so a hung cancel must not wedge compactingThread
          ctx.compactionQuietUntil = Date.now() + DEVIN_COMPACT_ABANDON_QUIET_MS;
          ctx.compactionCancelFiber = yield* Effect.ignore(ctx.acp.cancel).pipe(
            Effect.forkIn(ctx.scope),
          );
          const detail = `Devin did not finish context compaction within ${Math.round(DEVIN_COMPACT_TIMEOUT_MS / 1000)}s; the compaction was abandoned.`;
          yield* Effect.logWarning("devin.acp.compact_timeout", {
            threadId: ctx.threadId,
            timeoutMs: DEVIN_COMPACT_TIMEOUT_MS,
          });
          return yield* failDevinCompaction(ctx, "Context compaction timed out", detail);
        }

        yield* settleDevinCompactionOutcome(ctx);

        // ACP can answer /compact successfully with stopReason "cancelled" — not a completed compaction, must not persist as one
        if (promptResponse.stopReason === "cancelled") {
          const detail = "Devin context compaction was cancelled before it completed.";
          return yield* failDevinCompaction(ctx, "Context compaction cancelled", detail);
        }

        // a compaction tool call can fail while /compact resolves — honor the recorded failure instead of persisting completion
        const failedToolDetail = ctx.compactionFailedToolDetail;
        if (failedToolDetail !== undefined) {
          return yield* failDevinCompaction(ctx, "Context compaction failed", failedToolDetail);
        }

        // success: thread.state.changed is the single terminal signal — an item.completed row here would duplicate it
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

    const listModels: NonNullable<DevinAdapterShape["listModels"]> = (input) =>
      discoverDevinModels(
        resolveDevinBinaryPath(input.binaryPath?.trim() || devinSettings.binaryPath),
      );

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.suspend(() =>
        Effect.forEach(new Set([...sessions.keys(), ...wedgeRecoveries.keys()]), stopSession, {
          discard: true,
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
        discard: true,
      }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );
    // registered after the stopAll finalizer so LIFO closes the recovery scope first — an in-flight recovery must not restart a session after stopAll
    yield* Effect.addFinalizer(() => Scope.close(wedgeRecoveryScope, Exit.void));

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
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
      listCommands,
      compactThread,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DevinAdapterShape;
  });
}

export const DevinAdapterLive = Layer.effect(DevinAdapter, makeDevinAdapter());

export function makeDevinAdapterLive(
  devinSettings: DevinAcpRuntimeSettings = {},
  options?: DevinAdapterLiveOptions,
) {
  return Layer.effect(DevinAdapter, makeDevinAdapter(devinSettings, options));
}
