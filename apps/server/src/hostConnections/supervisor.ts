import type { HostConnectionState } from "@synara/contracts";
import { isAccountRefusal } from "../accountRefusal";
import { exponentialBackoffMs, jitterMs } from "../backoff";
import { classifyConnectionFailure } from "./failure";
import type { HostConnectionsPort } from "./port";
import type { HostConnectionRegistry } from "./registry";

/** Background retries keep today's 30 s cap through this many failures in a row. */
const FAST_RETRY_FAILURES = 10;
/** A host down for minutes, or one the account refuses, is retried no less often than this. */
const SLOW_RETRY_MAX_MS = 5 * 60_000;

const ATTENTION_STATES: ReadonlySet<HostConnectionState> = new Set([
  "needs-sign-in",
  "revoked",
  "incompatible",
  "stopped",
]);

/** Delay before the next background dial; explicit connects never wait on it. */
export function backgroundRetryDelayMs(failures: number, error: unknown): number {
  if (isAccountRefusal(error)) return exponentialBackoffMs(failures, 60_000, SLOW_RETRY_MAX_MS);
  if (failures <= FAST_RETRY_FAILURES) return exponentialBackoffMs(failures + 1, 1_000, 30_000);
  return exponentialBackoffMs(failures - FAST_RETRY_FAILURES + 1, 30_000, SLOW_RETRY_MAX_MS);
}

/**
 * States that usually need the owner (sign-in, revoked trust, incompatible builds) are
 * still retried slowly, because a sleeping or restarting host and an auto-updating build
 * can produce them too.
 */
export function attentionRetryDelayMs(failures: number): number {
  return exponentialBackoffMs(failures, 60_000, SLOW_RETRY_MAX_MS);
}

/** Restores persisted intent and retries failures without a renderer.
 * Idle verified relationships need no open RPC stream. At most two background
 * dials compete with interactive attachments. An explicit Connect retries immediately. */
export function superviseHostConnections(
  port: HostConnectionsPort,
  registry: HostConnectionRegistry,
): () => void {
  const pending = new Set<string>();
  const failures = new Map<
    string,
    { count: number; retryAt: number; state: HostConnectionState }
  >();
  const recordFailure = (hostId: string, state: HostConnectionState, error?: unknown) => {
    const previous = failures.get(hostId);
    // Each failure state keeps its own backoff, so a woken host is not held at the slow cadence.
    const count = previous?.state === state ? previous.count + 1 : 1;
    const delay = jitterMs(
      ATTENTION_STATES.has(state)
        ? attentionRetryDelayMs(count)
        : backgroundRetryDelayMs(count, error),
    );
    failures.set(hostId, { count, retryAt: Date.now() + delay, state });
    // One line per state change keeps the local log useful without repeating every retry.
    if (previous?.state !== state)
      console.warn(
        `[synara] Remote computer ${hostId} is ${state}; retrying in the background in ${Math.round(delay / 1000)}s.`,
      );
  };
  // A successful explicit probe can return to idle and fail again between ticks.
  const stopObserving = registry.onChange(() => {
    for (const id of failures.keys()) {
      const { state } = registry.status(id);
      if (state === "connected" || state === "idle") failures.delete(id);
    }
  });
  let stopped = false;
  let reading = false;
  const reconcile = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const { desiredHosts = [] } = await port.list();
      if (stopped) return;
      const desiredIds = new Set(desiredHosts.map((host) => host.hostId));
      for (const id of failures.keys()) if (!desiredIds.has(id)) failures.delete(id);
      for (const host of desiredHosts.slice(0, 32)) {
        if (pending.size >= 2) break;
        if (pending.has(host.hostId) || (failures.get(host.hostId)?.retryAt ?? 0) > Date.now())
          continue;
        const status = registry.status(host.hostId);
        if (registry.hasConnector(host.hostId)) {
          if (ATTENTION_STATES.has(status.state)) {
            // A live renderer or tool reached this state; wait one slow interval before
            // replacing the relationship so an owner action is not raced.
            if (!failures.has(host.hostId)) {
              recordFailure(host.hostId, status.state);
              continue;
            }
          } else if (
            status.state !== "reconnecting" ||
            (status.nextRetryAt && Date.parse(status.nextRetryAt) > Date.now())
          )
            continue;
        }
        pending.add(host.hostId);
        void port
          .connect({ hostId: host.hostId })
          .then(
            () => {
              failures.delete(host.hostId);
              if (stopped) registry.remove(host.hostId);
            },
            (error) => {
              if (!stopped) recordFailure(host.hostId, classifyConnectionFailure(error), error);
            },
          )
          .finally(() => pending.delete(host.hostId));
      }
    } catch {
      /* Local account/trust storage may be temporarily unavailable. */
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void reconcile(), 1_000);
  timer.unref();
  void reconcile();
  return () => {
    stopped = true;
    clearInterval(timer);
    stopObserving();
    registry.closeAll();
  };
}
