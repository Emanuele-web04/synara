/**
 * DroidAdapterLive - Factory Droid CLI (`droid exec --output-format acp`) via ACP.
 *
 * @module DroidAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
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
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { filterProviderPromptImageAttachments } from "../promptAttachments.ts";
import { listFactoryPlugins, readFactoryPlugin } from "../FactoryPluginDiscovery.ts";
import { readFactorySessionHistory } from "../FactorySessionHistory.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
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
import {
  readAcpUsdCost,
  makeAcpThreadLock,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
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
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  discoverDroidAcpModels,
  makeDroidAcpRuntime,
  type DroidAcpRuntimeSettings,
} from "../acp/DroidAcpSupport.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
} from "../acp/AcpElicitationSupport.ts";
import { DroidAdapter, type DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "droid" as const;
const DROID_RESUME_VERSION = 1 as const;
const DROID_ACP_TRANSPORT_DEBUG_MARKER = "droid-acp-meta-stripper-v2";
const DROID_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const DROID_ACP_DEBUG_ENV = "SYNARA_DROID_ACP_DEBUG";
const DPCODE_DROID_ACP_DEBUG_ENV = "DPCODE_DROID_ACP_DEBUG";
const LEGACY_DROID_ACP_DEBUG_ENV = "DP_DROID_ACP_DEBUG";
const DROID_RESUME_REPLAY_QUIET_MS = 350;
// Bounds how long startSession blocks on the replay settling; the background
// settle loop keeps suppression alive past this until the hard timeout.
const DROID_RESUME_REPLAY_MAX_WAIT_MS = 3_000;
const DROID_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
const DROID_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DROID_TURN_SETTLE_DRAIN_POLL_MS = 25;
// Backstop for an alive-but-silent droid child: if a turn produces no ACP
// activity for this long, force-fail it instead of showing "Working" forever.
// Generous by design so legitimate long, quiet tool runs are not killed;
// override with SYNARA_DROID_TURN_IDLE_TIMEOUT_MS when a workload needs longer.
const DROID_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DROID_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const DROID_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const DROID_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const DROID_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const DROID_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Droid plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

function summarizeDroidAcpLogPayload(payload: unknown): unknown {
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
  if (text.length <= DROID_ACP_LOG_PAYLOAD_LIMIT) {
    return text;
  }
  return `${text.slice(0, DROID_ACP_LOG_PAYLOAD_LIMIT)}... [truncated ${text.length - DROID_ACP_LOG_PAYLOAD_LIMIT} chars]`;
}

function summarizeDroidAcpRequestPayload(method: string, payload: unknown): unknown {
  if (method === "session/prompt") {
    return "[redacted session/prompt payload]";
  }
  return summarizeDroidAcpLogPayload(payload);
}

function isDroidAcpDebugEnabled(): boolean {
  return (
    process.env[DROID_ACP_DEBUG_ENV] === "1" ||
    process.env[DPCODE_DROID_ACP_DEBUG_ENV] === "1" ||
    process.env[LEGACY_DROID_ACP_DEBUG_ENV] === "1"
  );
}

function shouldMirrorDroidAcpProtocolLog(event: {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed" | "dropped";
  readonly payload: unknown;
}): boolean {
  if (event.stage === "decode_failed") return true;
  if (event.stage === "dropped") return true;
  if (event.direction !== "incoming" || event.stage !== "raw") return false;
  const payload = summarizeDroidAcpLogPayload(event.payload);
  if (typeof payload !== "string") return false;
  return payload.includes("droidShell");
}

function makeDroidAcpRuntimeLoggers(
  base: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">,
): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  const debugEnabled = isDroidAcpDebugEnabled();
  const requestLogger: AcpSessionRuntimeOptions["requestLogger"] =
    base.requestLogger || debugEnabled
      ? (event) =>
          Effect.gen(function* () {
            if (base.requestLogger) {
              yield* base.requestLogger(event);
            }
            if (debugEnabled && event.status === "failed") {
              yield* Effect.logWarning("droid.acp.request_failed", {
                marker: DROID_ACP_TRANSPORT_DEBUG_MARKER,
                method: event.method,
                payload: summarizeDroidAcpRequestPayload(event.method, event.payload),
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
              if (!debugEnabled || !shouldMirrorDroidAcpProtocolLog(event)) {
                return;
              }
              yield* Effect.logWarning("droid.acp.protocol", {
                marker: DROID_ACP_TRANSPORT_DEBUG_MARKER,
                direction: event.direction,
                stage: event.stage,
                payload: summarizeDroidAcpLogPayload(event.payload),
              });
            }),
        }
      : undefined;

  return {
    ...(requestLogger ? { requestLogger } : {}),
    ...(protocolLogging ? { protocolLogging } : {}),
  };
}

export interface DroidAdapterLiveOptions {
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

interface DroidSessionContext {
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
  // its originating turn instead of dropping it as an orphan. Cleared when the
  // next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // Pending until startSession has applied the requested model/effort config.
  // The session is registered in `sessions` before the config RPCs run (so
  // replay keeps draining), which means sendTurn can route to it mid-startup;
  // turns await this gate so the first prompt never runs with provider
  // defaults. Resolved by stopSessionInternal too, like resumeReplayReady, so
  // a failed startup never strands waiters.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  latestSessionCostUsd: number | undefined;
  // Count of ACP session/update events fully handled by the notification
  // consumer. Compared against acp.sessionUpdatesEnqueuedCount to detect when
  // events received before a prompt response have all been processed —
  // in-flight handlers and stream chunk buffering included.
  sessionUpdatesProcessed: number;
  // True while sendTurn is between its entry check and prompt dispatch; lets
  // interruptTurn flag a turn that has no prompt fiber to interrupt yet.
  turnStarting: boolean;
  // Set by interruptTurn when the turn is still starting; the prompt dispatch
  // guard honors it so a cancelled turn is never prompted.
  pendingTurnInterrupted: boolean;
  stopped: boolean;
}

function clearDroidActiveTurn(ctx: DroidSessionContext, turnId: TurnId): boolean {
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

export function scopeDroidRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

// Droid can close a stale assistant segment before any visible text arrives.
export function isRenderableDroidAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

// Droid may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeDroidToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function parseDroidResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DROID_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function recordDroidSessionCost(
  ctx: DroidSessionContext,
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd !== undefined) {
    ctx.latestSessionCostUsd = sessionCostUsd;
  }
}

function finalizeDroidActiveTurnCost(ctx: DroidSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function withDroidPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${DROID_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : DROID_PLAN_MODE_PROMPT_PREFIX;
}

function resolveDroidSessionCwd(
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

function setDroidDiscoveryCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DROID_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function makeDroidAdapter(
  droidSettings: DroidAcpRuntimeSettings,
  options?: DroidAdapterLiveOptions,
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

    const sessions = new Map<ThreadId, DroidSessionContext>();
    const modelDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListModelsResult }
    >();
    const commandDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListCommandsResult }
    >();
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    // Discovery sessions are disposable and never enter the live session directory.
    const makeDroidDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
      readonly clientName: string;
    }) =>
      makeDroidAcpRuntime({
        droidSettings: {
          ...(droidSettings.binaryPath ? { binaryPath: droidSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        clientInfo: { name: input.clientName, version: "0.0.0" },
      });

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
      ctx: DroidSessionContext,
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
    ): Effect.Effect<DroidSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
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

    const noteSuppressedDroidRuntimeEvent = (
      ctx: DroidSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isDroidAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("droid.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const activeTurnIdForDroidRuntimeEvent = (ctx: DroidSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedDroidRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedDroidRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    // Holds the active-turn window open until session/update events that were
    // already enqueued when the prompt response resolved have been fully
    // handled by the notification consumer, so they settle with their turn
    // attribution (and recorded failed-tool detail) intact. Snapshotting the
    // runtime's enqueued count and waiting for the adapter's processed count
    // to catch up is immune to stream chunk buffering and in-flight handlers,
    // unlike a queue-size probe. Returns immediately when the consumer kept
    // up; bounded so a chatty stream cannot stall settlement past the cap.
    const waitForDroidQueuedTurnEventsDrained = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < DROID_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(DROID_TURN_SETTLE_DRAIN_POLL_MS);
        }
      });

    // On session/load, Droid can replay old ACP updates after the session is "ready".
    // Keep suppression active until that stream actually goes quiet — clearing it
    // on a fixed timeout lets late historical deltas leak into the first turn as
    // its content. The hard cap only guards against a replay that never settles.
    const settleDroidResumeReplayWhenQuiet = (ctx: DroidSessionContext) =>
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
            quietForMs >= DROID_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= DROID_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= DROID_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning("droid.acp.resume_replay_quiet_wait_timeout", {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(DROID_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
      });

    const startSession: DroidAdapterShape["startSession"] = (input) =>
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
          const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const droidModelSelection =
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
          let ctx!: DroidSessionContext;

          const resumeSessionId = parseDroidResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeDroidAcpRuntimeLoggers(acpNativeLoggers);
          const providerDroidOptions = input.providerOptions?.droid;
          const effectiveDroidSettings: DroidAcpRuntimeSettings = {
            ...(droidSettings.binaryPath !== undefined
              ? { binaryPath: droidSettings.binaryPath }
              : {}),
            ...(providerDroidOptions?.binaryPath !== undefined
              ? { binaryPath: providerDroidOptions.binaryPath }
              : {}),
            ...(droidModelSelection?.model ? { model: droidModelSelection.model } : {}),
            ...(droidModelSelection?.options?.reasoningEffort
              ? { reasoningEffort: droidModelSelection.options.reasoningEffort }
              : {}),
            ...(input.runtimeMode === "full-access" ? { skipPermissionsUnsafe: true } : {}),
          };

          yield* Effect.logInfo("droid.acp.start", {
            marker: DROID_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: DROID_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveDroidSettings.model,
            reasoningEffort: effectiveDroidSettings.reasoningEffort,
            skipPermissionsUnsafe: effectiveDroidSettings.skipPermissionsUnsafe === true,
            binaryPath: effectiveDroidSettings.binaryPath ?? "droid",
          });

          const acp = yield* makeDroidAcpRuntime({
            droidSettings: effectiveDroidSettings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientCapabilities: { elicitation: { form: {} } },
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
                    if (isDroidAcpDebugEnabled()) {
                      yield* Effect.logInfo("droid.acp.permission_auto_approved", {
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
                  yield* Effect.logWarning("droid.acp.permission_auto_approve_unavailable", {
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
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (params.mode !== "form") {
                  return { action: { action: "decline" as const } };
                }
                const questions = elicitationQuestionsFromRequest(params);
                if (questions.length === 0) {
                  return { action: { action: "decline" as const } };
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent({
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
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return elicitationResponseFromAnswers(params, resolved);
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          // `session/resume` does not replay history; only legacy `session/load`
          // needs the replay-suppression gate below.
          const resumeReplayReady =
            started.sessionSetupMethod === "load" ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: droidModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DROID_RESUME_VERSION,
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
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady !== undefined ? Date.now() : undefined,
            sessionConfigReady,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            turnStarting: false,
            pendingTurnInterrupted: false,
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeDroidRuntimeItemIdForTurn(
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isDroidAcpDebugEnabled()) {
                          yield* Effect.logInfo("droid.acp.empty_assistant_item_suppressed", {
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;
                  case "ToolCallUpdated":
                    {
                      // A queued update for a tool call the just-settled turn
                      // already rendered belongs to that turn; emit it with the
                      // originating turn id so the existing tool row resolves in
                      // place instead of being dropped as an orphan. Resume
                      // replay stays suppressed like every other event.
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeDroidToolCallStateForTurn(lateTurnId, event.toolCall),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
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
                          toolCall: scopeDroidToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeDroidRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableDroidAssistantDelta(event)) {
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
                      const activeTurnId = yield* activeTurnIdForDroidRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      recordDroidSessionCost(ctx, event.cost);
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
                // waitForDroidQueuedTurnEventsDrained cannot observe an event as
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

          // Config RPCs run after the consumer fork so replay emitted while they
          // are in flight keeps draining. The session is already registered and
          // the start-scope finalizer no longer owns the session scope, so any
          // failure OR interruption of the remaining startup steps must tear the
          // session down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            if (droidModelSelection?.model) {
              yield* applyDroidAcpModelSelection({
                runtime: acp,
                model: droidModelSelection.model,
                reasoningEffort: droidModelSelection.options?.reasoningEffort,
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
            }
            // The requested model/effort are applied; turns gated on this
            // deferred can now prompt without inheriting provider defaults.
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // Settle the replay in the background: suppression stays active until
              // the stream is genuinely quiet, while startup only blocks briefly so
              // a long replay cannot hold session startup hostage. sendTurn awaits
              // the deferred, so the first turn stays gated until the replay has
              // actually finished.
              yield* settleDroidResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(DROID_RESUME_REPLAY_MAX_WAIT_MS),
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
              payload: { state: "ready", reason: "Droid ACP session ready" },
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

    // Idle-progress watchdog escape hatch: force-fail a turn whose droid child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via clearDroidActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failDroidTurnAsTimedOut = (ctx: DroidSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearDroidActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeDroidActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Droid stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("droid.acp.turn_idle_timeout", {
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

    const sendTurn: DroidAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A second sendTurn entering while another turn is still starting would
        // clear that turn's pendingTurnInterrupted flag (letting a cancelled
        // turn dispatch anyway) and race two ACP prompts; reject it instead.
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Droid turn is still starting for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startDroidTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startDroidTurn = (
      ctx: DroidSessionContext,
      input: Parameters<DroidAdapterShape["sendTurn"]>[0],
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
        // Selection changes normally arrive via a session restart, but a turn
        // can still carry an explicit selection; re-assert it over ACP (the
        // shared runtime skips the RPC when the value already matches).
        if (model !== undefined) {
          yield* applyDroidAcpModelSelection({
            runtime: ctx.acp,
            model,
            reasoningEffort: turnModelSelection?.options?.reasoningEffort,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });
        }
        yield* applyDroidAcpInteractionMode({
          runtime: ctx.acp,
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          runtimeMode: ctx.session.runtimeMode,
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
        });
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: appendProviderReferencesPromptBlock({
            text: input.input?.trim()
              ? withDroidPlanModePrompt({
                  text: input.input.trim(),
                  ...(input.interactionMode !== undefined
                    ? { interactionMode: input.interactionMode }
                    : {}),
                })
              : undefined,
            mentions: input.mentions,
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

        // A stop can land while the replay gate or attachment reads above were
        // in flight; opening the turn now would publish turn.started (and a
        // phantom cancelled completion) for a session that already exited.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
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
          // interruptTurn during the pre-prompt waits (resume replay, attachment
          // reads) or between turn.started publishing and this fiber being
          // registered sets pendingTurnInterrupted; honor it (and a concurrent
          // stop) here so a cancelled turn is never prompted. Self-interrupting
          // routes through the onInterrupt branch below, which completes the
          // turn as cancelled rather than as a provider failure.
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
                yield* waitForDroidQueuedTurnEventsDrained(ctx);
                if (!clearDroidActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeDroidActiveTurnCost(ctx);
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
                yield* waitForDroidQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearDroidActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeDroidActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning("droid.acp.turn_completed_without_content", {
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
              if (!clearDroidActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeDroidActiveTurnCost(ctx);
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
          idleTimeoutMs: DROID_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: DROID_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failDroidTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: DroidAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // A turn that is still starting has no prompt fiber to interrupt yet
        // (it may be gated on resume replay); flag it so startDroidTurn aborts
        // before prompting instead of running the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
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
      });

    const respondToRequest: DroidAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: DroidAdapterShape["respondToUserInput"] = (
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

    const readThread: DroidAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const readExternalThread: NonNullable<DroidAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () => readFactorySessionHistory(serverConfig.homeDir, input.externalThreadId),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: cause instanceof Error ? cause.message : "Failed to read the Droid session.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((history) =>
          history
            ? Effect.succeed({
                threadId: ThreadId.makeUnsafe(history.sessionId),
                ...(history.cwd ? { cwd: history.cwd } : {}),
                turns: history.messages.map((message, index) => ({
                  id: TurnId.makeUnsafe(`factory:${message.id}:${index}`),
                  items: [{ type: "factoryMessage", ...message }],
                })),
              })
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/read",
                  detail: `Droid session '${input.externalThreadId}' was not found locally.`,
                }),
              ),
        ),
      );

    const rollbackThread: DroidAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "Droid does not expose a native rewind cursor; rollback must restart the session with retained transcript context.",
        });
      });

    const forkThread: NonNullable<DroidAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveDroidSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveDroidSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork a Droid session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          Effect.gen(function* () {
            if (!(yield* runtime.supportsSessionFork)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "forkThread",
                issue:
                  "This Droid ACP version does not advertise session/fork; Synara will rebuild the fork from its retained transcript.",
              });
            }
            return yield* runtime.forkSession({ cwd: targetCwd, mcpServers: [] });
          });

        const activeSource = sessions.get(input.sourceThreadId);
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseDroidResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Droid session has no resumable native cursor.",
                });
              }
              const runtime = yield* makeDroidAcpRuntime({
                droidSettings: {
                  ...(droidSettings.binaryPath ? { binaryPath: droidSettings.binaryPath } : {}),
                  ...(input.providerOptions?.droid?.binaryPath
                    ? { binaryPath: input.providerOptions.droid.binaryPath }
                    : {}),
                  ...(input.runtimeMode === "full-access" ? { skipPermissionsUnsafe: true } : {}),
                },
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Synara Fork", version: "0.0.0" },
              });
              yield* runtime.start();
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        const resumeCursor = {
          schemaVersion: DROID_RESUME_VERSION,
          sessionId: forked.sessionId,
        };
        yield* startSession({
          threadId: input.threadId,
          provider: PROVIDER,
          cwd: targetCwd,
          runtimeMode: input.runtimeMode,
          resumeCursor,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        });
        return { threadId: input.threadId, resumeCursor };
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

    const stopSession: DroidAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DroidAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: DroidAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<DroidAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        // Droid's TUI has /compact, but ACP currently exposes no compaction RPC
        // and treats that text as an ordinary model prompt.
        supportsThreadCompaction: false,
        supportsThreadImport: true,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<DroidAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "listModels",
            issue: "cwd is required and no server cwd fallback is available.",
          });
        }
        const cacheKey = `${input.binaryPath?.trim() || droidSettings.binaryPath?.trim() || "droid"}\u0000${cwd}`;
        const cached = modelDiscoveryCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return { ...cached.result, cached: true };
        }
        const runtime = yield* makeDroidDiscoveryRuntime({
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
          cwd,
          clientName: "Synara Model Discovery",
        });
        yield* runtime.start();
        const result = yield* discoverDroidAcpModels(runtime);
        const commands = yield* runtime.getAvailableCommands;
        setDroidDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
          expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
          result: {
            commands: commands.map((command) => ({
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
            })),
            source: "droid-acp",
            cached: false,
          },
        });
        setDroidDiscoveryCacheEntry(modelDiscoveryCache, cacheKey, {
          expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
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
                ThreadId.makeUnsafe("droid-model-discovery"),
                "model/list",
                cause,
              ),
        ),
        Effect.timeoutOption(DROID_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/list",
                  detail: "Timed out while discovering Droid models over ACP.",
                }),
              ),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );

    const listPlugins: NonNullable<DroidAdapterShape["listPlugins"]> = (input) =>
      Effect.tryPromise({
        try: () => listFactoryPlugins(serverConfig.homeDir, input.cwd),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: cause instanceof Error ? cause.message : "Failed to read Factory plugins.",
            cause,
          }),
      });

    const readPlugin: NonNullable<DroidAdapterShape["readPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          readFactoryPlugin({
            homeDir: serverConfig.homeDir,
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: cause instanceof Error ? cause.message : "Failed to read the Factory plugin.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          result
            ? Effect.succeed(result)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "plugin/read",
                  detail: `Factory plugin '${input.pluginName}' was not found.`,
                }),
              ),
        ),
      );

    const listCommands: NonNullable<DroidAdapterShape["listCommands"]> = (input) =>
      Effect.gen(function* () {
        const cwd = resolveDroidSessionCwd(input.cwd, serverConfig);
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "listCommands",
            issue: "cwd is required and no server cwd fallback is available.",
          });
        }
        const cacheKey = `${input.binaryPath?.trim() || droidSettings.binaryPath?.trim() || "droid"}\u0000${cwd}`;
        const cached = commandDiscoveryCache.get(cacheKey);
        if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
          return { ...cached.result, cached: true };
        }
        const runtime = yield* makeDroidDiscoveryRuntime({
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
          cwd,
          clientName: "Synara Command Discovery",
        });
        yield* runtime.start();
        let commands = yield* runtime.getAvailableCommands;
        const startedAt = Date.now();
        while (commands.length === 0 && Date.now() - startedAt < 500) {
          yield* Effect.sleep(25);
          commands = yield* runtime.getAvailableCommands;
        }
        const result = {
          commands: commands.map((command) => ({
            name: command.name,
            ...(command.description ? { description: command.description } : {}),
          })),
          source: "droid-acp",
          cached: false,
        } satisfies ProviderListCommandsResult;
        setDroidDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
          expiresAt: Date.now() + DROID_MODEL_DISCOVERY_CACHE_MS,
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
                ThreadId.makeUnsafe("droid-command-discovery"),
                "command/list",
                cause,
              ),
        ),
        Effect.timeoutOption(DROID_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "command/list",
                  detail: "Timed out while discovering Droid commands over ACP.",
                }),
              ),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );

    const stopAll: DroidAdapterShape["stopAll"] = () =>
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
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      readExternalThread,
      rollbackThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listCommands,
      listModels,
      listPlugins,
      readPlugin,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DroidAdapterShape;
  });
}

export const DroidAdapterLive = Layer.effect(DroidAdapter, makeDroidAdapter({}));

export function makeDroidAdapterLive(
  droidSettings: DroidAcpRuntimeSettings = {},
  options?: DroidAdapterLiveOptions,
) {
  return Layer.effect(DroidAdapter, makeDroidAdapter(droidSettings, options));
}
