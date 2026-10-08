// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Synara WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import { ServerBusyController, publishServerBusySnapshot } from "./serverBusyState";
import { recordRendererActivity, rendererRpcActivity } from "./lib/rendererErrorDiagnostics";

import {
  ORCHESTRATION_STREAM_OVERFLOW_CODE,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_CHANNELS,
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  WS_GIT_ACTION_RECOVERY_CAPABILITY,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  type ServerRuntimeStatus,
  type ClientOrchestrationCommand,
  type OrchestrationSettleTurnDispatchResult,
  DEVICE_WS_CHANNELS,
  DEVICE_WS_METHODS,
  COMPUTER_WS_CHANNELS,
  COMPUTER_WS_METHODS,
  WsBootstrapNegotiateResult,
  WsBootstrapRpcGroup,
  WsDeviceRpcGroup,
  WsComputerRpcGroup,
  WS_METHODS,
  WsCompatibilityError,
  WsFeatureRpcGroup,
  WsProjectAgentRpcGroup,
  type AutomationStreamEvent,
  type TodoStreamEvent,
  type GitActionProgressEvent,
  type GitCreateDetachedWorktreeResult,
  type GitRunStackedActionResult,
  type GitWorktreeSetupProgressEvent,
  type GitHubProjectProvisionProgressEvent,
  type GitHubProjectProvisionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectAgentStreamEvent,
  type ProjectDevServerEvent,
  type ProjectFileChangeEvent,
  type ProjectWatchFileInput,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerKeepAwakeUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type DeviceEvent,
  type ComputerEvent,
  type TerminalEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  TASKS_UNAVAILABLE_ERROR_CODE,
  ThreadId,
} from "@synara/contracts";
import {
  Cause,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { APP_VERSION } from "./branding";
import { isRequestOutcomeUnknown } from "./lib/requestOutcome";
import { useDeviceStateStore } from "./deviceStateStore";
import { useComputerStateStore } from "./computerStateStore";
import {
  getUnaryRpcCapacityRetryDelayMs,
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS,
} from "./lib/expensiveReadRetry";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
  resetThreadDetailResumeCursors,
} from "./threadDetailResumeCursors";
import { trackWsTurnSettlement, type WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

type ProjectFileChangeSubscription = {
  readonly input: ProjectWatchFileInput;
  readonly listeners: Set<(event: ProjectFileChangeEvent) => void>;
};

export function projectFileChangeStreamKey(input: ProjectWatchFileInput): string {
  return `projects.file-change:${input.cwd.length}:${input.cwd}${input.relativePath}`;
}

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WsTransportRequestInterruptedError extends Data.TaggedError(
  "WsTransportRequestInterruptedError",
)<{
  readonly message: string;
  readonly code:
    | "WS_REQUEST_TIMEOUT"
    | "WS_REQUEST_ABORTED"
    | "WS_REQUEST_RECONNECTED"
    | "WS_TURN_SETTLEMENT_UNAVAILABLE";
  readonly method: string;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
  /**
   * True when the request died for transport-lifecycle reasons rather than a
   * server verdict: it never (observably) completed, so an idempotent caller
   * can safely re-issue it once the transport recovers.
   */
  readonly retryable?: boolean;
}> {}

/**
 * True when a request failure is the transport's own doing — the Effect runtime
 * that carried the request was interrupted or disposed mid-flight (reconnect,
 * runtime swap) — rather than an error the server returned. Interrupts have no
 * typed channel out of `runPromise`; they surface as the squashed
 * "All fibers interrupted without error" Error or as runtime-disposal defects,
 * which is exactly the raw leakage this classification exists to stop.
 */
export function isRuntimeInterruptFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "All fibers interrupted without error" ||
    error.message === "Missing runtime for WebSocket RPC client" ||
    error.message.includes("ManagedRuntime disposed")
  );
}

export interface WsRequestOptions {
  readonly timeoutMs?: number | null;
  readonly signal?: AbortSignal;
}

interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
}

export function makeRequestAbortScope(options?: WsRequestOptions): RequestAbortScope {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("WebSocket RPC timeoutMs must be a finite non-negative number or null.");
    }
  }
  if (timeoutMs === undefined || timeoutMs === null) {
    return {
      signal: options?.signal,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const externalSignal = options?.signal;
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function awaitWithAbort<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// The device group is declared separately in contracts because its engine is
// macOS-only, but the client must carry the methods on every platform: the
// server is the authority that refuses them off darwin, and the pane needs a
// real RPC error (or an `unsupported-platform` availability) to render its
// blocked state. Merging here keeps one socket and one client.
const makeRpcClient = RpcClient.make(
  WsFeatureRpcGroup.merge(WsDeviceRpcGroup).merge(WsComputerRpcGroup).merge(WsProjectAgentRpcGroup),
);
const makeBootstrapRpcClient = RpcClient.make(WsBootstrapRpcGroup);
const REQUEST_TIMEOUT_MS = 60_000;
const INITIAL_RECONNECT_RETRY_MS = 500;
const MAX_RECONNECT_RETRY_MS = 5_000;

/** Keeps outages gentle on the backend while still recovering promptly. */
export function getReconnectRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt), 16));
  return Math.min(INITIAL_RECONNECT_RETRY_MS * 2 ** exponent, MAX_RECONNECT_RETRY_MS);
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delayMs(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal) return delayWithAbort(ms, signal);
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function resolveRpcUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.pathname = path;
  return url.toString();
}

function rawSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return explicitUrl;
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  return bridgeUrl && bridgeUrl.length > 0
    ? bridgeUrl
    : envUrl && envUrl.length > 0
      ? envUrl
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
}

export function makeSocketUrl(explicitUrl: string | null, path: string): string {
  return resolveRpcUrl(rawSocketUrl(explicitUrl), path);
}

export function makeFeatureSocketUrl(
  explicitUrl: string | null,
  compatibility: WsBootstrapNegotiateResult,
): string {
  const url = new URL(makeSocketUrl(explicitUrl, WS_FEATURE_PATH));
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, APP_VERSION);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  return url.toString();
}

export function makeNegotiateHttpUrl(explicitUrl: string | null): string {
  const url = new URL(makeSocketUrl(explicitUrl, WS_NEGOTIATE_HTTP_PATH));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, APP_VERSION);
  url.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  for (const capability of WS_CLIENT_REQUIRED_CAPABILITIES) {
    url.searchParams.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  }
  return url.toString();
}

/** Bounded so a stalled negotiate falls back to bootstrap instead of hanging. */
const NEGOTIATE_HTTP_TIMEOUT_MS = 5_000;

/**
 * Negotiates compatibility over plain HTTP so a connect costs exactly one
 * WebSocket handshake. Returns null when the server does not expose the
 * endpoint yet (older server) or the request failed transiently, letting the
 * caller fall back to the legacy `/ws/bootstrap` socket. A 426 is a terminal
 * compatibility verdict and is thrown as a typed WsCompatibilityError.
 */
export async function negotiateOverHttp(
  explicitUrl: string | null,
  lifetimeSignal?: AbortSignal,
): Promise<WsBootstrapNegotiateResult | null> {
  // Browsers apply no default fetch timeout. Without the deadline, a
  // connection that accepts and then stalls (the WAN/tunnel case this
  // endpoint exists to improve) never settles, so the bootstrap fallback
  // never runs and the transport wedges; the legacy socket path got that
  // backstop for free from the browser's WS handshake timeout. The caller's
  // lifetime signal is composed in so disposal aborts the request too.
  const deadline = AbortSignal.timeout(NEGOTIATE_HTTP_TIMEOUT_MS);
  const signal = lifetimeSignal ? AbortSignal.any([lifetimeSignal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(makeNegotiateHttpUrl(explicitUrl), { cache: "no-store", signal });
  } catch {
    return null;
  }
  if (response.status === 426) {
    const body: unknown = await response.json().catch(() => null);
    const issue = Schema.decodeUnknownOption(WsCompatibilityError)(body);
    if (Option.isSome(issue)) throw issue.value;
    throw new Error("WebSocket negotiation was refused with an unreadable 426 response.");
  }
  if (!response.ok) {
    // The legacy bootstrap can recover from this status without waiting for an
    // irrelevant (possibly stalled) error body. Release that body immediately.
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  const result = Schema.decodeUnknownOption(WsBootstrapNegotiateResult)(body);
  return Option.isSome(result) ? result.value : null;
}

// A 90s upgrade budget covers observed 45–60s stalls plus startup/transfer
// overhead. Open sockets tolerate long stalls but still recover half-open paths.
const SOCKET_OPEN_TIMEOUT_MS = 90_000;
const SOCKET_SILENCE_TIMEOUT_MS = 180_000;
const FEATURE_CONNECTION_PROBE_TIMEOUT_MS = 180_000;
const MAX_STREAM_OVERFLOW_RETRIES = 8;

function makeProtocolLayer(url: string, onFailure?: () => void) {
  const socketLayer = Socket.layerWebSocket(url, { openTimeout: SOCKET_OPEN_TIMEOUT_MS }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  return Layer.effect(RpcClient.Protocol)(
    RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse) {
        const socket = yield* Socket.Socket;
        const serialization = yield* RpcSerialization.RpcSerialization;
        const parser = serialization.makeUnsafe();
        const write = yield* socket.writer;
        let currentError: RpcClientError.RpcClientError | undefined;
        let lastServerFrameAt: number | undefined;
        const reportFailure = (error: RpcClientError.RpcClientError) => {
          if (currentError) return Effect.void;
          currentError = error;
          onFailure?.();
          return writeResponse({ _tag: "ClientProtocolError", error });
        };

        // Reuse Effect's socket, serialization and RPC buffering/acknowledgement
        // machinery. Its default protocol pinger replaces an open connection
        // after one missed 5s pong; a blocked server cannot answer that pong.
        // Any inbound frame proves liveness, even if a pong is queued behind
        // a snapshot. Three minutes of silence bounds half-open remote paths
        // without replacing connections during observed 45–60s stalls.
        yield* socket
          .runRaw(
            (message) => {
              lastServerFrameAt = performance.now();
              try {
                const responses = parser.decode(message) as Array<
                  Parameters<Parameters<RpcClient.Protocol["Service"]["run"]>[0]>[0]
                >;
                return Effect.forEach(responses, writeResponse, { discard: true });
              } catch (cause) {
                return reportFailure(
                  new RpcClientError.RpcClientError({
                    reason: new RpcClientError.RpcClientDefect({
                      message: "Error decoding message",
                      cause,
                    }),
                  }),
                );
              }
            },
            {
              onOpen: Effect.sync(() => {
                lastServerFrameAt = performance.now();
              }),
            },
          )
          .pipe(
            Effect.flatMap(() =>
              reportFailure(
                new RpcClientError.RpcClientError({
                  reason: new Socket.SocketCloseError({ code: 1000 }),
                }),
              ),
            ),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.void;
              const error = Cause.squash(cause);
              return reportFailure(
                new RpcClientError.RpcClientError({
                  reason: Schema.is(Socket.SocketError)(error)
                    ? error.reason
                    : new RpcClientError.RpcClientDefect({
                        message: "Socket protocol failed",
                        cause: error,
                      }),
                }),
              );
            }),
            Effect.forkScoped,
          );
        yield* Effect.suspend(() => {
          if (currentError) return Effect.void;
          if (
            lastServerFrameAt !== undefined &&
            performance.now() - lastServerFrameAt >= SOCKET_SILENCE_TIMEOUT_MS
          ) {
            return reportFailure(
              new RpcClientError.RpcClientError({
                reason: new Socket.SocketReadError({
                  cause: new Error("No server frames received for 180000ms"),
                }),
              }),
            );
          }
          const encoded = parser.encode({ _tag: "Ping" });
          return encoded === undefined ? Effect.void : write(encoded);
        }).pipe(Effect.delay("5 seconds"), Effect.ignore, Effect.forever, Effect.forkScoped);
        return {
          send(request) {
            if (currentError) return Effect.fail(currentError);
            const encoded = parser.encode(request);
            return encoded === undefined ? Effect.void : Effect.orDie(write(encoded));
          },
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

const STREAM_ADMISSION_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
  "THREAD_SNAPSHOT_NOT_FOUND",
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
  // A local filesystem watcher failure is scoped to its optional panel
  // subscription. Reconnecting every RPC stream cannot repair that path.
  "PROJECT_FILE_WATCH_FAILED",
  // Snapshot-fence failures are a property of one stream's read model, not of
  // the socket. Tearing the whole transport down for them interrupts every
  // unrelated in-flight request while fixing nothing — the same fence is
  // re-read on the next connect. RESNAPSHOT retries in place with a fresh
  // snapshot request; STALLED / STATE_INCOMPLETE surface as stream failures
  // and recover via the slow snapshot-fault retry (see startStream).
  "ORCHESTRATION_RESNAPSHOT_REQUIRED",
  "ORCHESTRATION_SNAPSHOT_STALLED",
  // Retry only the overflowing subscription, preserving its applied cursor.
  ORCHESTRATION_STREAM_OVERFLOW_CODE,
  "ORCHESTRATION_PROJECTION_STATE_INCOMPLETE",
  // A server that does not offer Tasks (Stable) refuses its stream for good;
  // reconnecting the socket would only be refused again.
  TASKS_UNAVAILABLE_ERROR_CODE,
]);

const RESNAPSHOT_REQUIRED_ERROR_CODE = "ORCHESTRATION_RESNAPSHOT_REQUIRED";

// Server-diagnosed snapshot faults: the projection fence is stalled or
// underivable, and only server-side recovery (a restart's bootstrap replay, a
// repair, or the deferred catch-up advancing the fence) can clear them. The
// stream must neither die permanently — the shell stream has no route-level
// fallback, so a dead stream means a silently stale sidebar — nor hammer the
// server; a slow in-place retry converges as soon as the server heals.
//
// RESNAPSHOT_REQUIRED belongs here too, but only as a fallback: this
// classifier is consulted after the bounded fast retries are exhausted (the
// admission-retry path returns first), which is precisely the
// advancing-but-still-behind fence — a projector working through a backlog
// larger than the replay limit. The server keeps that demand retryable
// because progress is real, so the stream must keep slow-retrying until the
// gap closes rather than dying while recovery is succeeding.
const SNAPSHOT_FAULT_ERROR_CODES = new Set([
  "ORCHESTRATION_SNAPSHOT_STALLED",
  "ORCHESTRATION_PROJECTION_STATE_INCOMPLETE",
  RESNAPSHOT_REQUIRED_ERROR_CODE,
]);
export const SNAPSHOT_FAULT_RETRY_MS = 30_000;

export function getSnapshotFaultRetryDelayMs(cause: Cause.Cause<unknown>): number | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && SNAPSHOT_FAULT_ERROR_CODES.has(code)) {
      return SNAPSHOT_FAULT_RETRY_MS;
    }
  }
  return null;
}
const TERMINAL_COMPATIBILITY_ERROR_CODES = new Set([
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);

export function isTerminalCompatibilityFailure(error: unknown): boolean {
  return (
    (Schema.is(WsCompatibilityError)(error) && error.retryable === false) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      TERMINAL_COMPATIBILITY_ERROR_CODES.has(error.code))
  );
}

/**
 * True when the server just reached is a different instance than the last one
 * reached — the signal that cached resume cursors may belong to another event
 * journal. Compared against the last *successful* identity rather than the
 * current negotiation, which a failed reconnect clears: an outage longer than
 * the first retry would otherwise erase the evidence of the change, which is
 * exactly the restore-with-downtime case this guards against.
 */
export function serverIdentityChanged(
  lastKnownServerInstanceId: string | null,
  negotiatedServerInstanceId: string,
): boolean {
  return (
    lastKnownServerInstanceId !== null && lastKnownServerInstanceId !== negotiatedServerInstanceId
  );
}

export function getTerminalCompatibilityError(error: unknown): WsCompatibilityError | null {
  return Schema.is(WsCompatibilityError)(error) && error.retryable === false ? error : null;
}

export function shouldReconnectAfterStreamFailure(cause: Cause.Cause<unknown>): boolean {
  return !cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && STREAM_ADMISSION_ERROR_CODES.has(code);
  });
}

const RETRYABLE_STREAM_CAPACITY_ERROR_CODES = new Set([
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
]);
const DEFAULT_STREAM_CAPACITY_RETRY_MS = 1_000;
const MAX_STREAM_CAPACITY_RETRY_MS = 10_000;
const INITIAL_UNEXPECTED_STREAM_COMPLETION_RETRY_MS = 100;
const MAX_UNEXPECTED_STREAM_COMPLETION_RETRY_MS = 5_000;
const STABLE_STREAM_LIFETIME_MS = 10_000;
const PROJECT_FILE_WATCH_FAILED_ERROR_CODE = "PROJECT_FILE_WATCH_FAILED";
const INITIAL_PROJECT_FILE_WATCH_RETRY_MS = 500;
const MAX_PROJECT_FILE_WATCH_RETRY_MS = 8_000;
export const MAX_PROJECT_FILE_WATCH_RETRY_ATTEMPTS = 5;

/**
 * A file watcher failure belongs to one optional visible panel, not the whole
 * socket. Retry that subscription with bounded exponential backoff so a
 * transient filesystem failure heals without reconnecting unrelated streams.
 */
export function getProjectFileWatchRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_PROJECT_FILE_WATCH_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (code !== PROJECT_FILE_WATCH_FAILED_ERROR_CODE) continue;
    return Math.min(
      INITIAL_PROJECT_FILE_WATCH_RETRY_MS * 2 ** previousAttempts,
      MAX_PROJECT_FILE_WATCH_RETRY_MS,
    );
  }
  return null;
}

/**
 * Infinite subscription streams should not complete successfully. A short,
 * exponential delay heals a dropped server subscription without allowing an
 * immediately-completing stream to spin the renderer's event loop.
 */
export function getUnexpectedStreamCompletionRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt) - 1, 16));
  return Math.min(
    INITIAL_UNEXPECTED_STREAM_COMPLETION_RETRY_MS * 2 ** exponent,
    MAX_UNEXPECTED_STREAM_COMPLETION_RETRY_MS,
  );
}

export { getUnaryRpcCapacityRetryDelayMs, MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS };

/**
 * Capacity rejections are admission failures the server marks retryable: the
 * budget frees up as soon as another lease releases, so the stream must be
 * retried in place rather than dropped or escalated to a socket reconnect.
 */
export function getStreamCapacityRetryDelayMs(cause: Cause.Cause<unknown>): number | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_CAPACITY_ERROR_CODES.has(code)) continue;
    if ("retryable" in error && error.retryable === false) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_CAPACITY_RETRY_MS;
  }
  return null;
}

const RETRYABLE_STREAM_DUPLICATE_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
]);
const DEFAULT_STREAM_DUPLICATE_RETRY_MS = 250;
export const MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS = 5;
const THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE = "THREAD_SNAPSHOT_NOT_FOUND";
const DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS = 100;
export const MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS = 12;

/**
 * Duplicate rejections arrive marked `retryable: false` because one socket may
 * not hold two leases for the same stream. A cancel→fast-resubscribe still
 * races the server-side lease release (the lease frees only when the server
 * stream scope closes), so a bounded in-place retry is required to let the
 * stale lease drain instead of leaving the stream permanently dead.
 */
export function getStreamDuplicateRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_DUPLICATE_ERROR_CODES.has(code)) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_DUPLICATE_RETRY_MS;
  }
  return null;
}

/**
 * A visible local draft subscribes before its `thread.create` projection exists
 * so it cannot miss the first provider events. The event journal and projection
 * commit independently, leaving a short window where that valid subscription
 * receives THREAD_SNAPSHOT_NOT_FOUND. Retry only that admission race in place;
 * bounded attempts still surface genuinely missing or deleted thread ids.
 */
export function getThreadSnapshotBootstrapRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (code !== THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS;
  }
  return null;
}

const DEFAULT_RESNAPSHOT_RETRY_MS = 250;
export const MAX_RESNAPSHOT_RETRY_ATTEMPTS = 2;

/**
 * The server asks for a stream restart because its snapshot fence trails the
 * journal beyond the replay limit. The remedy is scoped to this stream: retry
 * the subscription in place with a fresh full-snapshot request. The attempts
 * are deliberately few — the server escalates a non-advancing fence to the
 * non-retryable ORCHESTRATION_SNAPSHOT_STALLED on the repeat demand, so more
 * client-side patience only delays surfacing the fault.
 */
export function getResnapshotRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_RESNAPSHOT_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (code !== RESNAPSHOT_REQUIRED_ERROR_CODE) continue;
    if ("retryable" in error && error.retryable === false) continue;
    return DEFAULT_RESNAPSHOT_RETRY_MS;
  }
  return null;
}

export type StreamAdmissionRetry =
  | { readonly kind: "capacity"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "duplicate"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "thread-bootstrap"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "resnapshot"; readonly attempt: number; readonly delayMs: number };

export function resolveStreamAdmissionRetry(
  cause: Cause.Cause<unknown>,
  capacityAttempts: number,
  duplicateAttempts: number,
  threadBootstrapAttempts = 0,
  resnapshotAttempts = 0,
): StreamAdmissionRetry | null {
  const capacityDelayMs = getStreamCapacityRetryDelayMs(cause);
  if (capacityDelayMs !== null) {
    return {
      kind: "capacity",
      attempt: capacityAttempts + 1,
      delayMs: capacityDelayMs,
    };
  }
  const duplicateDelayMs = getStreamDuplicateRetryDelayMs(cause, duplicateAttempts);
  if (duplicateDelayMs !== null) {
    return {
      kind: "duplicate",
      attempt: duplicateAttempts + 1,
      delayMs: duplicateDelayMs,
    };
  }
  const threadBootstrapDelayMs = getThreadSnapshotBootstrapRetryDelayMs(
    cause,
    threadBootstrapAttempts,
  );
  if (threadBootstrapDelayMs !== null) {
    return {
      kind: "thread-bootstrap",
      attempt: threadBootstrapAttempts + 1,
      delayMs: threadBootstrapDelayMs,
    };
  }
  const resnapshotDelayMs = getResnapshotRetryDelayMs(cause, resnapshotAttempts);
  if (resnapshotDelayMs === null) return null;
  return {
    kind: "resnapshot",
    attempt: resnapshotAttempts + 1,
    delayMs: resnapshotDelayMs,
  };
}

function getStreamFailureCode(cause: Cause.Cause<unknown>): string | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string") return code;
  }
  return null;
}

const THREAD_STREAM_KEY_PREFIX = "orchestration.thread:";

function threadIdFromStreamKey(key: string): string | null {
  return key.startsWith(THREAD_STREAM_KEY_PREFIX)
    ? key.slice(THREAD_STREAM_KEY_PREFIX.length)
    : null;
}

export function threadStreamInputsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => (right as Record<string, unknown>)[key] === value);
}

export type WsShellStreamFailure = Omit<WsThreadStreamFailure, "threadId">;

export interface WsThreadStreamFailure {
  readonly threadId: string;
  readonly code: string | null;
  readonly error: Error;
}

function omitNullUserInputAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const command = input as { type?: unknown; answers?: unknown };
  if (command.type !== "thread.user-input.respond" || !command.answers) {
    return input;
  }
  if (typeof command.answers !== "object") {
    return input;
  }
  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

export class WsTransport {
  private readonly serverBusy = new ServerBusyController({ onChange: publishServerBusySnapshot });
  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly compatibilityListeners = new Set<(issue: WsCompatibilityError | null) => void>();
  private readonly compatibilityResultListeners = new Set<
    (compatibility: WsBootstrapNegotiateResult | null) => void
  >();
  private readonly shellStreamFailureListeners = new Set<(failure: WsShellStreamFailure) => void>();
  private readonly threadStreamFailureListeners = new Set<
    (failure: WsThreadStreamFailure) => void
  >();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private sessionVersion = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private readonly runtimeByClient = new WeakMap<
    RpcClientInstance,
    ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>
  >();
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null = null;
  private clientScope: Scope.Closeable | null = null;
  // Aborted by dispose() so an in-flight HTTP negotiation cannot outlive the
  // transport and resurrect a runtime after teardown returned.
  private readonly lifetime = new AbortController();
  private clientPromise: Promise<RpcClientInstance>;
  private reconnectPromise: Promise<RpcClientInstance> | null = null;
  private reconnectFailures = 0;
  private readonly streamCleanups = new Map<string, () => void>();
  private readonly streamSettled = new Map<string, Promise<void>>();
  private readonly streamCapacityRetries = new Map<string, number>();
  private readonly streamDuplicateRetries = new Map<string, number>();
  private readonly streamThreadBootstrapRetries = new Map<string, number>();
  private readonly streamResnapshotRetries = new Map<string, number>();
  private readonly projectFileWatchRetries = new Map<string, number>();
  private readonly streamCapacityRetryTimers = new Map<string, number>();
  private readonly streamOverflowRetries = new Map<string, number>();
  private readonly streamCompletionRetries = new Map<string, number>();
  private readonly streamCompletionRetryTimers = new Map<string, number>();
  private readonly activeThreadStreamInputs = new Map<string, unknown>();
  private shellSubscribed = false;
  // Whether the active shell stream has already delivered its snapshot item.
  // An explicit subscribeShell while this is true must restart the stream (the
  // caller reset its fence and needs a new snapshot); while false, the pending
  // snapshot of the just-started stream will satisfy the caller, so the call
  // is absorbed (bootstrap coalescing).
  private shellSnapshotDelivered = false;
  private readonly threadSubscriptions = new Map<string, unknown>();
  private readonly projectFileSubscriptions = new Map<string, ProjectFileChangeSubscription>();
  private readonly projectAgentSubscriptions = new Map<string, unknown>();
  private compatibility: WsBootstrapNegotiateResult | null = null;
  private compatibilityIssue: WsCompatibilityError | null = null;
  // Tracks the last server generation this transport observed so cross-restart
  // reconnects still reset replayed push state even after the negotiation
  // cache was cleared by an intervening failure.
  private lastServerInstanceId: string | null = null;

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.serverBusy.visibilityChanged);
    this.clientPromise = this.createSession().clientPromise;
    void this.clientPromise.catch((error) => {
      if (this.disposed || isTerminalCompatibilityFailure(error)) return;
      void this.reconnect().catch((reconnectError) => {
        if (!this.disposed && !isTerminalCompatibilityFailure(reconnectError)) {
          console.warn("WebSocket reconnect loop stopped unexpectedly", reconnectError);
        }
      });
    });
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: WsRequestOptions,
  ): Promise<T> {
    const finish = this.serverBusy?.trackRequest(method, options);
    const activity = rendererRpcActivity(method, params);
    if (activity) recordRendererActivity(activity, "started");
    try {
      const result = await this.requestInternal<T>(method, params, options);
      if (activity) recordRendererActivity(activity, "succeeded");
      return result;
    } catch (error) {
      if (activity) recordRendererActivity(activity, "failed");
      throw error;
    } finally {
      finish?.();
    }
  }

  private async requestInternal<T = unknown>(
    method: string,
    params?: unknown,
    options?: WsRequestOptions,
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const requestOptions: WsRequestOptions =
      options?.timeoutMs === undefined ? { ...options, timeoutMs: REQUEST_TIMEOUT_MS } : options;
    const abortScope = makeRequestAbortScope(requestOptions);
    let uncertainTurn: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> | null =
      null;
    try {
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
        this.shellSubscribed = false;
        await awaitWithAbort(this.stopStream("orchestration.shell"), abortScope.signal);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.threadSubscriptions.delete(threadId);
        await awaitWithAbort(
          this.stopStream(`orchestration.thread:${threadId}`),
          abortScope.signal,
        );
        return undefined as T;
      }

      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        const wasSubscribed = this.shellSubscribed;
        this.shellSubscribed = true;
        this.resetStreamCapacityRetry("orchestration.shell");
        this.resetStreamCompletionRetry("orchestration.shell");
        const client = await awaitWithAbort(this.getClient(), abortScope.signal);
        await this.startShellStream(client, wasSubscribed && this.shellSnapshotDelivered);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.resetStreamCapacityRetry(`orchestration.thread:${threadId}`);
        this.resetStreamCompletionRetry(`orchestration.thread:${threadId}`);
        // Preserve the stored input identity across explicit refreshes so stale
        // restart callbacks cannot supersede the newly requested stream.
        const existingInput = this.threadSubscriptions.get(threadId);
        const wasSubscribed = existingInput !== undefined;
        const input = threadStreamInputsEqual(existingInput, params) ? existingInput : params;
        this.threadSubscriptions.set(threadId, input);
        const client = await awaitWithAbort(this.getClient(), abortScope.signal);
        await this.startThreadStream(client, threadId, input as never, wasSubscribed);
        return undefined as T;
      }
      if (method === WS_METHODS.subscribeProjectAgentEvents) {
        const projectId = (params as { projectId: string }).projectId;
        const streamKey = `projectAgent.events:${projectId}`;
        this.resetStreamCapacityRetry(streamKey);
        this.resetStreamCompletionRetry(streamKey);
        this.projectAgentSubscriptions.set(projectId, params);
        const client = await awaitWithAbort(this.getClient(), abortScope.signal);
        // An unsubscribe that landed during the connect wait already dropped the
        // registration (and a resubscribe replaced it) — only stream when this
        // request is still the registered one.
        if (this.projectAgentSubscriptions.get(projectId) !== params) {
          return undefined as T;
        }
        this.startProjectAgentEventStream(client, projectId, params);
        return undefined as T;
      }

      const client = await awaitWithAbort(this.getClient(), abortScope.signal);
      if (
        method === ORCHESTRATION_WS_METHODS.settleTurnDispatch &&
        !this.compatibility?.capabilities.includes(WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY)
      ) {
        throw new WsTransportRequestInterruptedError({
          message:
            "This server cannot check message delivery. Reconnect to an updated server and check the conversation before sending again.",
          code: "WS_TURN_SETTLEMENT_UNAVAILABLE",
          method,
          retryable: false,
        });
      }

      if (method === WS_METHODS.gitRunStackedAction) {
        return (await this.runRecoverableGitAction(client, params, abortScope.signal)) as T;
      }
      if (method === WS_METHODS.gitCreateDetachedWorktree) {
        return (await this.runWorktreeSetupStream(client, params, abortScope.signal)) as T;
      }
      if (method === WS_METHODS.projectsProvisionFromGitHub) {
        return (await this.runProjectProvisionStream(client, params, abortScope.signal)) as T;
      }

      const rpcInput =
        method === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? (params as { command: unknown }).command
          : (params ?? {});
      const normalizedRpcInput = omitNullUserInputAnswers(rpcInput);
      if (
        method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
        this.compatibility?.capabilities.includes(WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY)
      ) {
        const command = normalizedRpcInput as ClientOrchestrationCommand;
        if (command.type === "thread.turn.start") uncertainTurn = command;
      }
      const call = (
        client as unknown as Record<
          string,
          (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
        >
      )[method];
      if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
      const clientRuntime = this.getClientRuntime(client);
      const runOptions = abortScope.signal ? { signal: abortScope.signal } : undefined;
      let capacityAttempts = 0;
      while (true) {
        try {
          return (await clientRuntime.runPromise(call(normalizedRpcInput), runOptions)) as T;
        } catch (error) {
          const retryDelayMs = getUnaryRpcCapacityRetryDelayMs(error, capacityAttempts);
          if (retryDelayMs === null) throw error;
          capacityAttempts += 1;
          await delayMs(retryDelayMs, abortScope.signal);
        }
      }
    } catch (error) {
      let failure = error;
      if (abortScope.didTimeout()) {
        failure = new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} timed out after ${requestOptions.timeoutMs}ms. ${this.serverBusy?.getSnapshot().reason === "unresponsive" ? "Synara server is not responding. " : "The server did not finish this request in time. "}${method === ORCHESTRATION_WS_METHODS.dispatchCommand ? "Check the result before retrying; the command may have been applied." : "Try again when the server responds."}`,
          code: "WS_REQUEST_TIMEOUT",
          method,
          ...(requestOptions.timeoutMs !== undefined && requestOptions.timeoutMs !== null
            ? { timeoutMs: requestOptions.timeoutMs }
            : {}),
          cause: error,
        });
      } else if (requestOptions.signal?.aborted) {
        failure = new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} was cancelled.`,
          code: "WS_REQUEST_ABORTED",
          method,
          cause: requestOptions.signal.reason ?? error,
        });
      } else if (
        isRuntimeInterruptFailure(error) ||
        Schema.is(RpcClientError.RpcClientError)(error)
      ) {
        recordRendererActivity("transport.reconnect", "started");
        failure = new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} was interrupted by a transport reconnect.`,
          code: "WS_REQUEST_RECONNECTED",
          method,
          cause: error,
          retryable: true,
        });
      }
      if (
        uncertainTurn &&
        isRequestOutcomeUnknown(failure) &&
        !this.disposed &&
        !requestOptions.signal?.aborted
      ) {
        // Keep composer ownership and staged attachments until the server gives
        // a durable verdict. A failed acknowledgement is not a failed send.
        const finishSettlement = trackWsTurnSettlement(uncertainTurn.threadId);
        try {
          return (await this.settleTurnDispatch(uncertainTurn, requestOptions.signal)) as T;
        } finally {
          finishSettlement();
        }
      }
      throw failure;
    } finally {
      abortScope.cleanup();
    }
  }

  private async settleTurnDispatch(
    command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
    callerSignal?: AbortSignal,
  ): Promise<{ sequence: number }> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.lifetime.signal])
      : this.lifetime.signal;
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      let result: OrchestrationSettleTurnDispatchResult;
      try {
        result = await this.request<OrchestrationSettleTurnDispatchResult>(
          ORCHESTRATION_WS_METHODS.settleTurnDispatch,
          { command },
          { signal },
        );
      } catch (error) {
        if (
          signal.aborted ||
          isTerminalCompatibilityFailure(error) ||
          (error instanceof WsTransportRequestInterruptedError &&
            error.code === "WS_TURN_SETTLEMENT_UNAVAILABLE")
        )
          throw error;
        // Repeating settlement is safe even if its own acknowledgement was
        // lost: it only reads or rejects the original identity, never starts it.
        await delayMs(Math.max(500, getReconnectRetryDelayMs(attempt++)), signal);
        continue;
      }
      if (result.status === "accepted") return { sequence: result.sequence };
      throw new WsTransportRpcError({ message: result.message });
    }
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  subscribeProjectFileChange(
    input: ProjectWatchFileInput,
    listener: (event: ProjectFileChangeEvent) => void,
  ): () => void {
    const key = projectFileChangeStreamKey(input);
    let subscription = this.projectFileSubscriptions.get(key);
    const isNewSubscription = subscription === undefined;
    if (!subscription) {
      subscription = { input, listeners: new Set() };
      this.projectFileSubscriptions.set(key, subscription);
    }
    subscription.listeners.add(listener);
    const desiredSubscription = subscription;
    if (isNewSubscription) {
      void this.getClient()
        .then((client) => this.startProjectFileChangeStream(client, key, desiredSubscription))
        .catch(() => undefined);
    }

    return () => {
      desiredSubscription.listeners.delete(listener);
      if (
        desiredSubscription.listeners.size > 0 ||
        this.projectFileSubscriptions.get(key) !== desiredSubscription
      ) {
        return;
      }
      this.projectFileSubscriptions.delete(key);
      void this.stopStream(key);
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  getCompatibility(): WsBootstrapNegotiateResult | null {
    return this.compatibility;
  }

  onCompatibilityChange(
    listener: (compatibility: WsBootstrapNegotiateResult | null) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.compatibilityResultListeners.add(listener);
    if (options?.replayCurrent) listener(this.compatibility);
    return () => {
      this.compatibilityResultListeners.delete(listener);
    };
  }

  onCompatibilityIssue(
    listener: (issue: WsCompatibilityError | null) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.compatibilityListeners.add(listener);
    if (options?.replayCurrent) listener(this.compatibilityIssue);
    return () => {
      this.compatibilityListeners.delete(listener);
    };
  }

  /** Fires when a per-thread stream dies with no retry or reconnect left. */
  onThreadStreamFailure(listener: (failure: WsThreadStreamFailure) => void): () => void {
    this.threadStreamFailureListeners.add(listener);
    return () => {
      this.threadStreamFailureListeners.delete(listener);
    };
  }

  /** Fires when the shell subscription exhausts its local overflow retries. */
  onShellStreamFailure(listener: (failure: WsShellStreamFailure) => void): () => void {
    this.shellStreamFailureListeners.add(listener);
    return () => {
      this.shellStreamFailureListeners.delete(listener);
    };
  }

  private emitThreadStreamFailure(failure: WsThreadStreamFailure): void {
    for (const listener of this.threadStreamFailureListeners) {
      try {
        listener(failure);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private emitShellStreamFailure(failure: WsShellStreamFailure): void {
    for (const listener of this.shellStreamFailureListeners) {
      try {
        listener(failure);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Abort before anything else: a pending negotiate must fail now rather
    // than resolve later and build a runtime this teardown will not see.
    this.lifetime.abort(new Error("Transport disposed"));
    this.setState("disposed");
    this.serverBusy?.dispose();
    if (typeof document !== "undefined" && this.serverBusy)
      document.removeEventListener("visibilitychange", this.serverBusy.visibilityChanged);
    this.resetAllStreamCapacityRetries();
    this.resetAllStreamCompletionRetries();
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.activeThreadStreamInputs.clear();
    this.projectFileSubscriptions.clear();
    this.projectAgentSubscriptions.clear();
    this.threadStreamFailureListeners.clear();
    this.shellStreamFailureListeners.clear();
    // Dispose can race with initial connection or reconnect promises. Mark them
    // handled before closing the runtime so test/browser teardown stays quiet.
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const resources = this.takeCurrentRuntime();
    if (resources) await this.closeRuntime(resources);
  }

  /**
   * Resolves negotiation without burning a WebSocket handshake: the HTTP
   * endpoint answers directly on current servers, and only servers predating
   * it fall back to the legacy `/ws/bootstrap` socket round trip.
   */
  private async negotiateCompatibility(): Promise<WsBootstrapNegotiateResult> {
    const httpResult = await negotiateOverHttp(this.explicitUrl, this.lifetime.signal);
    if (httpResult) return httpResult;
    // dispose() may have run while the request was in flight; it captured a
    // null runtime and returned, so building one here would strand it.
    if (this.disposed) {
      throw new Error("WebSocket transport was disposed during negotiation.");
    }
    const runtime = ManagedRuntime.make(
      makeProtocolLayer(makeSocketUrl(this.explicitUrl, WS_BOOTSTRAP_PATH)),
    );
    const clientScope = runtime.runSync(Scope.make());
    // Track the bootstrap runtime so dispose() during negotiation aborts it.
    this.runtime = runtime;
    this.clientScope = clientScope;
    try {
      const bootstrapClient = await runtime.runPromise(
        Scope.provide(clientScope)(makeBootstrapRpcClient),
      );
      return await runtime.runPromise(
        bootstrapClient[WS_BOOTSTRAP_METHOD]({
          protocolEpoch: WS_PROTOCOL_EPOCH,
          minRevision: WS_PROTOCOL_MIN_REVISION,
          maxRevision: WS_PROTOCOL_MAX_REVISION,
          clientBuild: APP_VERSION,
          requiredCapabilities: [...WS_CLIENT_REQUIRED_CAPABILITIES],
        }),
      );
    } finally {
      await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      if (this.runtime === runtime) {
        this.runtime = null;
        this.clientScope = null;
      }
    }
  }

  private adoptNegotiation(compatibility: WsBootstrapNegotiateResult): void {
    if (serverIdentityChanged(this.lastServerInstanceId, compatibility.serverInstanceId)) {
      this.latestPushByChannel.clear();
      this.sequence = 0;
      // A resume cursor is only valid against the journal that issued its
      // sequences. A new server instance may serve a different journal (fresh
      // install, restored backup), so every cursor must reset to force full
      // snapshots. `lastServerInstanceId` survives failed reconnects, unlike
      // `compatibility`, so an outage longer than the first retry still
      // detects the change. Interim tradeoff: this also drops resume across
      // plain restarts of the same journal, acceptable until the protocol
      // carries a durable journal epoch.
      resetThreadDetailResumeCursors();
      // Device thread state is gated on a per-thread version that the server
      // restarts at 0. A stale higher version would reject the new instance's
      // snapshots as stragglers and leave the pane showing pre-restart devices
      // and attachments forever, so the cache is dropped with the cursors.
      useDeviceStateStore.getState().clear();
      useComputerStateStore.getState().clear();
    }
    this.lastServerInstanceId = compatibility.serverInstanceId;
    this.setCompatibility(compatibility);
    this.setCompatibilityIssue(null);
  }

  /**
   * A cached-negotiation session skips the negotiation round trip, so nothing
   * has yet proven the server is alive on the cached generation. Probe with a
   * no-op RPC: a restarted server refuses the stale `/ws` upgrade (426) and
   * the probe fails, clearing the cache so the next attempt renegotiates.
   */
  private async probeFeatureConnection(
    client: RpcClientInstance,
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
  ): Promise<void> {
    const probe = (
      client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, WsTransportRpcError>
      >
    )[ORCHESTRATION_WS_METHODS.unsubscribeShell];
    if (!probe) return;
    await runtime.runPromise(probe({}).pipe(Effect.timeout(FEATURE_CONNECTION_PROBE_TIMEOUT_MS)));
  }

  private createSession() {
    const sessionVersion = ++this.sessionVersion;
    // Reconnects reuse the cached negotiation while the server generation is
    // unchanged, so a reconnect costs exactly one WebSocket handshake.
    const cachedCompatibility = this.compatibility;
    const clientPromise = (async () => {
      const compatibility = cachedCompatibility ?? (await this.negotiateCompatibility());
      if (this.disposed || this.sessionVersion !== sessionVersion) {
        throw new Error("WebSocket session superseded during compatibility negotiation.");
      }

      const featureRuntime = ManagedRuntime.make(
        makeProtocolLayer(makeFeatureSocketUrl(this.explicitUrl, compatibility), () => {
          // Defer teardown out of the failing protocol fiber, and fence failures
          // from an old socket so they cannot replace a newer healthy session.
          queueMicrotask(() => {
            const recover = () => {
              if (this.disposed || this.sessionVersion !== sessionVersion) return;
              if (this.state !== "open") this.setCompatibility(null);
              void this.reconnect().catch(() => undefined);
            };
            // A close may arrive just after the probe sets "open", before an
            // active recovery promise has settled. Recheck after it settles;
            // otherwise that new socket can remain closed without a retry.
            if (this.reconnectPromise) {
              void this.reconnectPromise.then(recover, () => undefined);
            } else {
              recover();
            }
          });
        }),
      );
      const featureScope = featureRuntime.runSync(Scope.make());
      this.runtime = featureRuntime;
      this.clientScope = featureScope;
      const client = await featureRuntime.runPromise(Scope.provide(featureScope)(makeRpcClient));
      this.runtimeByClient.set(client, featureRuntime);
      // Negotiation does not prove that the feature socket has opened. Keep
      // initial sends behind the same liveness check used by reconnects.
      await this.probeFeatureConnection(client, featureRuntime);
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.adoptNegotiation(compatibility);
        this.setState("open");
      }
      return client;
    })().catch((error) => {
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.setCompatibility(null);
        const compatibilityError = getTerminalCompatibilityError(error);
        if (compatibilityError) {
          this.setCompatibilityIssue(compatibilityError);
          this.setState("incompatible");
        } else {
          this.setState("closed");
        }
      }
      throw error;
    });
    return { clientPromise };
  }

  private async getClient(): Promise<RpcClientInstance> {
    // Once recovery starts, the last fulfilled client belongs to a runtime
    // that reconnect() has detached. New work must join the shared recovery
    // promise instead of briefly reusing that stale socket.
    if (this.reconnectPromise) return this.reconnectPromise;
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.disposed) throw new Error("Transport disposed");
      if (isTerminalCompatibilityFailure(error)) throw error;
      return this.reconnect();
    }
  }

  private getClientRuntime(
    client: RpcClientInstance,
  ): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    const runtime = this.runtimeByClient.get(client);
    if (!runtime) {
      throw new Error("Missing runtime for WebSocket RPC client");
    }
    return runtime;
  }

  private takeCurrentRuntime(): {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientScope: Scope.Closeable | null;
  } | null {
    const runtime = this.runtime;
    if (!runtime) return null;
    const clientScope = this.clientScope;
    this.runtime = null;
    this.clientScope = null;
    return { runtime, clientScope };
  }

  private async closeRuntime(resources: {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientScope: Scope.Closeable | null;
  }): Promise<void> {
    if (resources.clientScope) {
      await resources.runtime
        .runPromise(Scope.close(resources.clientScope, Exit.void))
        .catch(() => undefined);
    }
    await resources.runtime.dispose().catch(() => undefined);
  }

  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;

    // Fence detached probe/stream continuations before asynchronous teardown.
    this.sessionVersion += 1;
    const oldResources = this.takeCurrentRuntime();
    this.resetAllStreamCapacityRetries();
    this.resetAllStreamCompletionRetries();
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.activeThreadStreamInputs.clear();

    this.setState("connecting");

    this.reconnectPromise = (async () => {
      if (oldResources) await this.closeRuntime(oldResources);
      return this.openReconnectSession();
    })().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.serverBusy?.stopHeartbeat();
    if (
      state === "open" &&
      this.compatibility?.capabilities.includes(WS_SERVER_RUNTIME_STATUS_CAPABILITY)
    ) {
      this.serverBusy?.startHeartbeat((signal) =>
        this.request<ServerRuntimeStatus>(
          WS_METHODS.serverGetRuntimeStatus,
          {},
          { signal, timeoutMs: null },
        ),
      );
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private clearStreamCapacityRetryTimer(key: string): void {
    const timeoutId = this.streamCapacityRetryTimers.get(key);
    if (timeoutId === undefined) return;
    window.clearTimeout(timeoutId);
    this.streamCapacityRetryTimers.delete(key);
  }

  private resetStreamCapacityRetry(key: string): void {
    this.clearStreamCapacityRetryTimer(key);
    this.streamCapacityRetries.delete(key);
    this.streamDuplicateRetries.delete(key);
    this.streamThreadBootstrapRetries.delete(key);
    this.streamResnapshotRetries.delete(key);
    this.projectFileWatchRetries.delete(key);
    this.streamOverflowRetries.delete(key);
  }

  private resetAllStreamCapacityRetries(): void {
    for (const timeoutId of this.streamCapacityRetryTimers.values()) {
      window.clearTimeout(timeoutId);
    }
    this.streamCapacityRetryTimers.clear();
    this.streamCapacityRetries.clear();
    this.streamDuplicateRetries.clear();
    this.streamThreadBootstrapRetries.clear();
    this.streamResnapshotRetries.clear();
    this.projectFileWatchRetries.clear();
    this.streamOverflowRetries.clear();
  }

  private clearStreamCompletionRetryTimer(key: string): void {
    const timeoutId = this.streamCompletionRetryTimers.get(key);
    if (timeoutId === undefined) return;
    window.clearTimeout(timeoutId);
    this.streamCompletionRetryTimers.delete(key);
  }

  private resetStreamCompletionRetry(key: string): void {
    this.clearStreamCompletionRetryTimer(key);
    this.streamCompletionRetries.delete(key);
  }

  private resetAllStreamCompletionRetries(): void {
    for (const timeoutId of this.streamCompletionRetryTimers.values()) {
      window.clearTimeout(timeoutId);
    }
    this.streamCompletionRetryTimers.clear();
    this.streamCompletionRetries.clear();
  }

  private scheduleUnexpectedStreamCompletionReconnect(
    key: string,
    streamSessionVersion: number,
    streamStartedAt: number,
    restart: () => void,
  ): void {
    if (this.sessionVersion !== streamSessionVersion) return;

    // Subscription streams send an initial snapshot, so receiving an event
    // does not prove the stream is healthy. Only a stream that remained alive
    // for a meaningful interval resets the backoff.
    const streamLifetimeMs = performance.now() - streamStartedAt;
    const previousAttempt =
      streamLifetimeMs >= STABLE_STREAM_LIFETIME_MS
        ? 0
        : (this.streamCompletionRetries.get(key) ?? 0);
    const attempt = previousAttempt + 1;
    this.streamCompletionRetries.set(key, attempt);
    this.clearStreamCompletionRetryTimer(key);

    const timeoutId = window.setTimeout(() => {
      if (this.streamCompletionRetryTimers.get(key) !== timeoutId) return;
      this.streamCompletionRetryTimers.delete(key);
      if (
        this.disposed ||
        this.sessionVersion !== streamSessionVersion ||
        this.streamCleanups.has(key)
      ) {
        return;
      }

      // An infinite subscription completing successfully usually means the
      // RPC feature socket became a zombie. Reopening the stream on that same
      // client can complete immediately forever. A full reconnect restores all
      // registered subscriptions and lets the server replay the persisted tail.
      void this.reconnect().catch((error) => {
        if (!this.disposed && !this.streamCleanups.has(key)) {
          console.warn("WebSocket RPC stream reconnect failed", error);
          // getClient() inside the registered restart applies the normal
          // reconnect backoff after a failed reconnect.
          restart();
        }
      });
    }, getUnexpectedStreamCompletionRetryDelayMs(attempt));
    this.streamCompletionRetryTimers.set(key, timeoutId);
  }

  private setCompatibilityIssue(issue: WsCompatibilityError | null): void {
    if (this.compatibilityIssue === issue) return;
    this.compatibilityIssue = issue;
    for (const listener of this.compatibilityListeners) {
      try {
        listener(issue);
      } catch {
        // Compatibility UI listeners must not break transport teardown.
      }
    }
  }

  private setCompatibility(compatibility: WsBootstrapNegotiateResult | null): void {
    if (this.compatibility === compatibility) return;
    this.compatibility = compatibility;
    for (const listener of this.compatibilityResultListeners) {
      try {
        listener(compatibility);
      } catch {
        // Capability listeners must not break transport connection lifecycle.
      }
    }
  }

  private async openReconnectSession(): Promise<RpcClientInstance> {
    for (;;) {
      if (this.disposed) throw new Error("Transport disposed");
      this.setState("connecting");
      const delayMs = getReconnectRetryDelayMs(this.reconnectFailures);
      this.reconnectFailures += 1;
      await delayWithAbort(delayMs, this.lifetime.signal);

      const session = this.createSession();
      this.clientPromise = session.clientPromise;
      try {
        const client = await session.clientPromise;
        for (const channel of this.listeners.keys()) {
          this.startChannelStream(channel as WsPushChannel);
        }
        if (this.shellSubscribed) {
          await this.startShellStream(client);
        }
        // Refreshing only overwrites existing keys, so iterating the live key
        // set is safe here. Each stream starts at most once for this session.
        for (const threadId of this.threadSubscriptions.keys()) {
          const input = this.refreshThreadSubscriptionInput(threadId);
          if (input === undefined) continue;
          await this.startThreadStream(client, threadId, input);
        }
        for (const [key, subscription] of this.projectFileSubscriptions) {
          this.startProjectFileChangeStream(client, key, subscription);
        }
        for (const [projectId, params] of this.projectAgentSubscriptions) {
          this.startProjectAgentEventStream(client, projectId, params);
        }
        this.reconnectFailures = 0;
        return client;
      } catch (error) {
        const failedResources = this.takeCurrentRuntime();
        if (failedResources) await this.closeRuntime(failedResources);
        if (this.disposed) throw new Error("Transport disposed");
        if (isTerminalCompatibilityFailure(error)) throw error;
        // The backend may still be starting. Continue with bounded backoff;
        // the transport lifetime aborts this loop immediately on disposal.
      }
    }
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    const requestedSessionVersion = this.sessionVersion;
    void this.getClient()
      .then((client) => {
        if (
          this.disposed ||
          this.sessionVersion !== requestedSessionVersion ||
          !this.listeners.has(channel)
        ) {
          return;
        }
        const restartChannel = () => {
          if (this.listeners.has(channel)) {
            this.startChannelStream(channel);
          }
        };

        if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(client);
        } else if (channel === WS_CHANNELS.serverConfigUpdated) {
          this.startStream(
            client,
            "server.config",
            client[WS_METHODS.subscribeServerConfig]({}),
            (event: ServerConfigStreamEvent) => {
              if (event.type === "snapshot") {
                this.emit(WS_CHANNELS.serverConfigUpdated, {
                  issues: event.config.issues,
                  providers: event.config.providers,
                });
              } else if (event.type === "configUpdated") {
                this.emit(WS_CHANNELS.serverConfigUpdated, event.payload);
              }
            },
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            client,
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            client,
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverKeepAwakeUpdated) {
          this.startStream(
            client,
            "server.keep-awake",
            client[WS_METHODS.subscribeServerKeepAwake]({}),
            (payload: ServerKeepAwakeUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverKeepAwakeUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          this.startStream(
            client,
            "terminal.events",
            client[WS_METHODS.subscribeTerminalEvents]({}),
            (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            client,
            "project.devServers",
            client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            client,
            "automation.events",
            client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.todoEvent) {
          this.startStream(
            client,
            "todo.events",
            client[WS_METHODS.subscribeTodoEvents]({}),
            (event: TodoStreamEvent) => this.emit(WS_CHANNELS.todoEvent, event),
            restartChannel,
          );
        } else if (channel === DEVICE_WS_CHANNELS.event) {
          this.startStream(
            client,
            "device.events",
            client[DEVICE_WS_METHODS.subscribeEvents]({}),
            (event: DeviceEvent) => this.emit(DEVICE_WS_CHANNELS.event, event),
            restartChannel,
          );
        } else if (channel === COMPUTER_WS_CHANNELS.event) {
          this.startStream(
            client,
            "computer.events",
            client[COMPUTER_WS_METHODS.subscribeEvents]({}),
            (event: ComputerEvent) => this.emit(COMPUTER_WS_CHANNELS.event, event),
            restartChannel,
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            client,
            "orchestration.domain",
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
            restartChannel,
          );
        }
      })
      .catch((error) => {
        if (
          !this.disposed &&
          this.sessionVersion === requestedSessionVersion &&
          this.listeners.has(channel) &&
          !isTerminalCompatibilityFailure(error)
        ) {
          console.warn("WebSocket RPC channel failed to start", error);
          window.setTimeout(() => this.startChannelStream(channel), 500);
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.serverKeepAwakeUpdated) this.stopStream("server.keep-awake");
    else if (channel === WS_CHANNELS.terminalEvent) this.stopStream("terminal.events");
    else if (channel === WS_CHANNELS.projectDevServerEvent) this.stopStream("project.devServers");
    else if (channel === WS_CHANNELS.automationEvent) this.stopStream("automation.events");
    else if (channel === WS_CHANNELS.todoEvent) this.stopStream("todo.events");
    else if (channel === DEVICE_WS_CHANNELS.event) this.stopStream("device.events");
    else if (channel === COMPUTER_WS_CHANNELS.event) this.stopStream("computer.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private startLifecycleStream(client: RpcClientInstance): void {
    if (this.disposed || !this.shouldKeepLifecycleStream()) return;
    const restartLifecycle = () => {
      if (!this.shouldKeepLifecycleStream()) return;
      void this.getClient()
        .then((nextClient) => this.startLifecycleStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC lifecycle stream failed to restart", error));
    };
    this.startStream(
      client,
      "server.lifecycle",
      client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      restartLifecycle,
    );
  }

  private async startShellStream(client: RpcClientInstance, forceRestart = false): Promise<void> {
    if (this.disposed || !this.shellSubscribed) return;
    if (forceRestart) {
      // An explicit resubscribe expects a fresh snapshot: the caller has reset
      // its shell fence and buffers events until one arrives. A surviving
      // stream whose snapshot was already delivered would dedupe the start and
      // leave the caller buffering forever.
      const sessionVersion = this.sessionVersion;
      await this.stopStream("orchestration.shell", { resetCapacityRetry: false });
      if (this.disposed || this.sessionVersion !== sessionVersion || !this.shellSubscribed) {
        return;
      }
    }
    const restartShell = () => {
      if (!this.shellSubscribed) return;
      void this.getClient()
        .then((nextClient) => this.startShellStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC shell stream failed to restart", error));
    };
    if (!this.streamCleanups.has("orchestration.shell")) {
      this.shellSnapshotDelivered = false;
    }
    this.startStream(
      client,
      "orchestration.shell",
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) => {
        if (event.kind === "snapshot") {
          this.shellSnapshotDelivered = true;
        }
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event);
      },
      restartShell,
    );
  }

  /**
   * Rebuilds a subscribed thread's stream input from the current resume-cursor
   * state and stores it as the desired input. Transport-managed restarts
   * (reconnects, stream retries) must not replay the input captured at
   * subscribe time: a thread first subscribed without a cursor would keep
   * requesting full snapshots forever, and a cursor cleared since then would
   * be resent stale. Returns undefined when the thread is no longer subscribed.
   */
  private refreshThreadSubscriptionInput(threadId: string): unknown {
    if (!this.threadSubscriptions.has(threadId)) return undefined;
    const existingInput = this.threadSubscriptions.get(threadId);
    const rebuiltInput: unknown = buildThreadSubscribeInput(ThreadId.makeUnsafe(threadId));
    const input = threadStreamInputsEqual(existingInput, rebuiltInput)
      ? existingInput
      : rebuiltInput;
    this.threadSubscriptions.set(threadId, input);
    return input;
  }

  private async startThreadStream(
    client: RpcClientInstance,
    threadId: string,
    input: unknown,
    forceRestart = false,
  ): Promise<void> {
    const key = `orchestration.thread:${threadId}`;
    if (this.disposed || this.threadSubscriptions.get(threadId) !== input) {
      return;
    }
    if (
      !forceRestart &&
      this.streamCleanups.has(key) &&
      this.activeThreadStreamInputs.get(key) === input
    ) {
      return;
    }
    const sessionVersion = this.sessionVersion;
    await this.stopStream(key, { resetCapacityRetry: false });
    if (
      this.disposed ||
      this.sessionVersion !== sessionVersion ||
      this.threadSubscriptions.get(threadId) !== input
    ) {
      return;
    }
    const restartThread = () => {
      const desiredInput = this.refreshThreadSubscriptionInput(threadId);
      if (desiredInput === undefined) return;
      void this.getClient()
        .then((nextClient) => this.startThreadStream(nextClient, threadId, desiredInput))
        .catch((error) => console.warn("WebSocket RPC thread stream failed to restart", error));
    };
    this.activeThreadStreamInputs.set(key, input);
    this.startStream(
      client,
      key,
      client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
      restartThread,
    );
  }

  private startProjectFileChangeStream(
    client: RpcClientInstance,
    key: string,
    subscription: ProjectFileChangeSubscription,
  ): void {
    if (
      this.disposed ||
      this.projectFileSubscriptions.get(key) !== subscription ||
      !this.compatibility?.capabilities.includes(WS_PROJECT_FILE_WATCH_CAPABILITY)
    ) {
      return;
    }
    const restart = () => {
      if (this.projectFileSubscriptions.get(key) !== subscription) return;
      void this.getClient()
        .then((nextClient) => this.startProjectFileChangeStream(nextClient, key, subscription))
        .catch(() => undefined);
    };
    this.startStream<ProjectFileChangeEvent>(
      client,
      key,
      client[WS_METHODS.projectsSubscribeFileChange](subscription.input),
      (event) => {
        for (const subscribedListener of subscription.listeners) {
          try {
            subscribedListener(event);
          } catch {
            // One panel listener must not prevent another from revalidating.
          }
        }
      },
      restart,
    );
  }

  private startStream<T>(
    client: RpcClientInstance,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: (() => void) | undefined,
  ): void {
    if (this.streamCleanups.has(key)) return;
    this.clearStreamCapacityRetryTimer(key);
    this.clearStreamCompletionRetryTimer(key);
    const streamSessionVersion = this.sessionVersion;
    const streamStartedAt = performance.now();
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const cancel = this.getClientRuntime(client).runCallback(
      Stream.runForEach(runnableStream, (event) =>
        Effect.sync(() => {
          if (this.streamCapacityRetries.has(key)) {
            this.streamCapacityRetries.delete(key);
          }
          if (this.streamDuplicateRetries.has(key)) {
            this.streamDuplicateRetries.delete(key);
          }
          if (this.streamThreadBootstrapRetries.has(key)) {
            this.streamThreadBootstrapRetries.delete(key);
          }
          if (this.streamResnapshotRetries.has(key)) {
            this.streamResnapshotRetries.delete(key);
          }
          listener(event);
        }),
      ),
      {
        onExit: (exit) => {
          if (this.streamSettled.get(key) === settled) {
            this.streamSettled.delete(key);
          }
          resolveSettled();
          const wasReplacedOrStopped = this.streamCleanups.get(key) !== cancel;
          if (!wasReplacedOrStopped) {
            this.streamCleanups.delete(key);
            this.activeThreadStreamInputs.delete(key);
          }
          if (wasReplacedOrStopped || this.disposed) {
            return;
          }
          if (Exit.isSuccess(exit) && restart) {
            this.scheduleUnexpectedStreamCompletionReconnect(
              key,
              streamSessionVersion,
              streamStartedAt,
              restart,
            );
            return;
          }
          if (Exit.isFailure(exit)) {
            this.streamCompletionRetries.delete(key);
          }
          if (restart && Exit.isFailure(exit)) {
            const admissionRetry = resolveStreamAdmissionRetry(
              exit.cause,
              this.streamCapacityRetries.get(key) ?? 0,
              this.streamDuplicateRetries.get(key) ?? 0,
              this.streamThreadBootstrapRetries.get(key) ?? 0,
              this.streamResnapshotRetries.get(key) ?? 0,
            );
            if (admissionRetry !== null) {
              const retries =
                admissionRetry.kind === "capacity"
                  ? this.streamCapacityRetries
                  : admissionRetry.kind === "duplicate"
                    ? this.streamDuplicateRetries
                    : admissionRetry.kind === "thread-bootstrap"
                      ? this.streamThreadBootstrapRetries
                      : this.streamResnapshotRetries;
              retries.set(key, admissionRetry.attempt);
              if (admissionRetry.kind === "resnapshot") {
                // The server refused the stream because its snapshot trails the
                // journal beyond the replay limit. A resume cursor makes the
                // retry ask for the same gap replay again; dropping it makes
                // the restart request a full fresh snapshot instead. The store
                // discards its cached detail when the new snapshot arrives, so
                // the cursor's coherence invariant is preserved.
                const threadId = threadIdFromStreamKey(key);
                if (threadId !== null) {
                  clearThreadDetailResumeCursor(ThreadId.makeUnsafe(threadId));
                }
              }
              this.clearStreamCapacityRetryTimer(key);
              const timeoutId = window.setTimeout(
                () => {
                  if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                  this.streamCapacityRetryTimers.delete(key);
                  if (!this.disposed && !this.streamCleanups.has(key)) {
                    restart();
                  }
                },
                Math.min(
                  admissionRetry.delayMs * admissionRetry.attempt,
                  MAX_STREAM_CAPACITY_RETRY_MS,
                ),
              );
              this.streamCapacityRetryTimers.set(key, timeoutId);
              return;
            }

            if (getStreamFailureCode(exit.cause) === ORCHESTRATION_STREAM_OVERFLOW_CODE) {
              const attempt =
                performance.now() - streamStartedAt >= STABLE_STREAM_LIFETIME_MS
                  ? 0
                  : (this.streamOverflowRetries.get(key) ?? 0);
              if (attempt < MAX_STREAM_OVERFLOW_RETRIES) {
                this.streamOverflowRetries.set(key, attempt + 1);
                // A snapshot alone does not establish recovery. Back off repeated
                // overflow up to 16s, without dropping the last applied cursor.
                const delay = Math.min(16_000, 250 * 2 ** Math.min(attempt, 6));
                this.clearStreamCapacityRetryTimer(key);
                const timeoutId = window.setTimeout(() => {
                  if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                  this.streamCapacityRetryTimers.delete(key);
                  if (
                    !this.disposed &&
                    this.sessionVersion === streamSessionVersion &&
                    !this.streamCleanups.has(key)
                  )
                    restart();
                }, delay);
                this.streamCapacityRetryTimers.set(key, timeoutId);
                return;
              }
            }

            const previousFileWatchAttempts =
              performance.now() - streamStartedAt >= STABLE_STREAM_LIFETIME_MS
                ? 0
                : (this.projectFileWatchRetries.get(key) ?? 0);
            const fileWatchRetryDelayMs = getProjectFileWatchRetryDelayMs(
              exit.cause,
              previousFileWatchAttempts,
            );
            if (fileWatchRetryDelayMs !== null) {
              this.projectFileWatchRetries.set(key, previousFileWatchAttempts + 1);
              this.clearStreamCapacityRetryTimer(key);
              const timeoutId = window.setTimeout(() => {
                if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                this.streamCapacityRetryTimers.delete(key);
                if (!this.disposed && !this.streamCleanups.has(key)) {
                  restart();
                }
              }, fileWatchRetryDelayMs);
              this.streamCapacityRetryTimers.set(key, timeoutId);
              return;
            }
          }
          if (restart && Exit.isFailure(exit) && shouldReconnectAfterStreamFailure(exit.cause)) {
            window.setTimeout(
              () => {
                if (
                  !this.disposed &&
                  this.sessionVersion === streamSessionVersion &&
                  !this.streamCleanups.has(key)
                ) {
                  void this.reconnect()
                    .then(() => restart())
                    .catch((error) => {
                      if (!this.disposed) {
                        console.warn("WebSocket RPC stream reconnect failed", error);
                      }
                    });
                }
              },
              Cause.hasInterruptsOnly(exit.cause) ? 0 : 500,
            );
            return;
          }
          if (Exit.isFailure(exit) && !this.disposed && !Cause.hasInterruptsOnly(exit.cause)) {
            const error = causeToError(exit.cause);
            console.warn("WebSocket RPC stream failed", error);
            const threadId = threadIdFromStreamKey(key);
            if (threadId !== null && this.threadSubscriptions.has(threadId)) {
              this.emitThreadStreamFailure({
                threadId,
                code: getStreamFailureCode(exit.cause),
                error,
              });
            }
            if (
              key === "orchestration.shell" &&
              getStreamFailureCode(exit.cause) === ORCHESTRATION_STREAM_OVERFLOW_CODE
            ) {
              this.emitShellStreamFailure({ code: ORCHESTRATION_STREAM_OVERFLOW_CODE, error });
            }
            // Server-diagnosed snapshot faults clear only when the server
            // heals (restart bootstrap, repair, deferred catch-up). Surfacing
            // the failure above is not enough for streams with no route-level
            // fallback (the shell stream): keep a slow in-place retry armed so
            // the subscription recovers without user action once the fence
            // advances, without hammering a server that said "stop retrying".
            if (restart && getSnapshotFaultRetryDelayMs(exit.cause) !== null) {
              this.clearStreamCapacityRetryTimer(key);
              const timeoutId = window.setTimeout(() => {
                if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                this.streamCapacityRetryTimers.delete(key);
                if (!this.disposed && !this.streamCleanups.has(key)) {
                  restart();
                }
              }, SNAPSHOT_FAULT_RETRY_MS);
              this.streamCapacityRetryTimers.set(key, timeoutId);
            }
          }
        },
      },
    );
    this.streamCleanups.set(key, cancel);
    this.streamSettled.set(key, settled);
  }

  /**
   * Detach a project-agent event stream entirely: drop the resubscribe-on-reconnect
   * registration and cancel the live stream scope. `subscribeProjectAgentEvents`
   * re-registers from scratch when needed.
   */
  async unsubscribeProjectAgentEvents(projectId: string): Promise<void> {
    this.projectAgentSubscriptions.delete(projectId);
    await this.stopStream(`projectAgent.events:${projectId}`);
  }

  /**
   * Start (or restart) a project-agent event stream. The restart closure keeps the
   * standard stream recovery paths alive — unexpected-completion reconnects and
   * admission retries run through startStream, and the recursion means a restarted
   * stream can itself restart instead of dying after one completion.
   */
  private startProjectAgentEventStream(
    client: RpcClientInstance,
    projectId: string,
    params: unknown,
  ): void {
    const streamKey = `projectAgent.events:${projectId}`;
    this.startStream<ProjectAgentStreamEvent>(
      client,
      streamKey,
      client[WS_METHODS.subscribeProjectAgentEvents](params as never),
      (event) => this.emit(WS_CHANNELS.projectAgentEvent, event),
      () => {
        if (!this.projectAgentSubscriptions.has(projectId)) return;
        void this.getClient().then((nextClient) => {
          if (!this.projectAgentSubscriptions.has(projectId)) return;
          this.startProjectAgentEventStream(nextClient, projectId, params);
        });
      },
    );
  }

  private stopStream(
    key: string,
    options?: { readonly resetCapacityRetry?: boolean },
  ): Promise<void> {
    this.clearStreamCapacityRetryTimer(key);
    this.clearStreamCompletionRetryTimer(key);
    if (options?.resetCapacityRetry !== false) {
      this.streamCapacityRetries.delete(key);
      this.streamDuplicateRetries.delete(key);
      this.streamThreadBootstrapRetries.delete(key);
      this.streamResnapshotRetries.delete(key);
      this.projectFileWatchRetries.delete(key);
      this.streamOverflowRetries.delete(key);
    }
    this.streamCompletionRetries.delete(key);
    this.activeThreadStreamInputs.delete(key);
    const cleanup = this.streamCleanups.get(key);
    const settled = this.streamSettled.get(key) ?? Promise.resolve();
    if (!cleanup) return settled;
    this.streamCleanups.delete(key);
    cleanup();
    return settled;
  }

  private async runRecoverableGitAction(
    initialClient: RpcClientInstance,
    params: unknown,
    callerSignal?: AbortSignal,
  ): Promise<GitRunStackedActionResult> {
    const canRecover = this.compatibility?.capabilities.includes(WS_GIT_ACTION_RECOVERY_CAPABILITY);
    const command = canRecover ? { ...(params as object), recoverable: true } : params;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.lifetime.signal])
      : this.lifetime.signal;
    let client = initialClient;
    let resume = false;
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        if (resume) {
          client = await awaitWithAbort(this.getClient(), signal);
          // An older server would ignore `resume` and execute the mutation again.
          if (!this.compatibility?.capabilities.includes(WS_GIT_ACTION_RECOVERY_CAPABILITY)) {
            throw new WsTransportRpcError({
              message:
                "This server cannot recover the Git action. Check the repository status before trying again.",
            });
          }
        }
        return await this.runGitActionStream(
          client,
          resume ? { ...(command as object), resume: true } : command,
          signal,
        );
      } catch (error) {
        if (
          !canRecover ||
          signal.aborted ||
          this.disposed ||
          !(isRuntimeInterruptFailure(error) || Schema.is(RpcClientError.RpcClientError)(error))
        ) {
          throw error;
        }
        resume = true;
        await delayMs(Math.max(500, getReconnectRetryDelayMs(attempt++)), signal);
      }
    }
  }

  private async runGitActionStream(
    client: RpcClientInstance,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    try {
      await this.getClientRuntime(client).runPromise(
        Stream.runForEach(client[WS_METHODS.gitRunStackedAction](params as never), (event) =>
          Effect.sync(() => {
            this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
            if ((event as GitActionProgressEvent).kind === "action_finished") {
              result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>)
                .result;
            }
          }),
        ),
        signal ? { signal } : undefined,
      );
    } catch (error) {
      if (!result) throw error;
    }
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }

  private async runWorktreeSetupStream(
    client: RpcClientInstance,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<GitCreateDetachedWorktreeResult> {
    let result: GitCreateDetachedWorktreeResult | null = null;
    await this.getClientRuntime(client).runPromise(
      Stream.runForEach(client[WS_METHODS.gitCreateDetachedWorktree](params as never), (event) =>
        Effect.sync(() => {
          const progressEvent = event as GitWorktreeSetupProgressEvent;
          this.emit(WS_CHANNELS.gitWorktreeSetupProgress, progressEvent);
          if (progressEvent.kind === "completed") {
            result = progressEvent.result;
          }
        }),
      ),
      signal ? { signal } : undefined,
    );
    if (!result) throw new Error("Worktree creation completed without a final result.");
    return result;
  }

  private async runProjectProvisionStream(
    client: RpcClientInstance,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<GitHubProjectProvisionResult> {
    let result: GitHubProjectProvisionResult | null = null;
    await this.getClientRuntime(client).runPromise(
      Stream.runForEach(client[WS_METHODS.projectsProvisionFromGitHub](params as never), (event) =>
        Effect.sync(() => {
          const progressEvent = event as GitHubProjectProvisionProgressEvent;
          this.emit(WS_CHANNELS.projectProvisionProgress, progressEvent);
          if (progressEvent.kind === "completed") {
            result = progressEvent.result;
          }
        }),
      ),
      signal ? { signal } : undefined,
    );
    if (!result) throw new Error("Project provisioning completed without a final result.");
    return result;
  }
}
