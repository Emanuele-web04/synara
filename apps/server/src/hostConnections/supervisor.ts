import { isAccountRefusal } from "../accountRefusal";
import { exponentialBackoffMs, jitterMs } from "../backoff";
import { classifyConnectionFailure } from "./failure";
import type { HostConnectionsPort } from "./port";
import type { HostConnectionRegistry } from "./registry";

/** Background retries keep today's 30 s cap through this many failures in a row. */
const FAST_RETRY_FAILURES = 10;
/** A host down for minutes, or one the account refuses, is retried no less often than this. */
const SLOW_RETRY_MAX_MS = 5 * 60_000;

/** Delay before the next background dial; explicit connects never wait on it. */
export function backgroundRetryDelayMs(failures: number, error: unknown): number {
  if (isAccountRefusal(error)) return exponentialBackoffMs(failures, 60_000, SLOW_RETRY_MAX_MS);
  if (failures <= FAST_RETRY_FAILURES) return exponentialBackoffMs(failures + 1, 1_000, 30_000);
  return exponentialBackoffMs(failures - FAST_RETRY_FAILURES + 1, 30_000, SLOW_RETRY_MAX_MS);
}

/** Restores persisted intent and retries transient failures without a renderer.
 * Idle verified relationships need no open RPC stream. At most two background
 * dials compete with interactive attachments; terminal failures wait for Retry. */
export function superviseHostConnections(
  port: HostConnectionsPort,
  registry: HostConnectionRegistry,
): () => void {
  const pending = new Set<string>();
  const failures = new Map<string, { count: number; retryAt: number }>();
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
        if (
          registry.hasConnector(host.hostId) &&
          (status.state !== "reconnecting" ||
            (status.nextRetryAt && Date.parse(status.nextRetryAt) > Date.now()))
        )
          continue;
        pending.add(host.hostId);
        void port
          .connect({ hostId: host.hostId })
          .then(
            () => {
              failures.delete(host.hostId);
              if (stopped) registry.remove(host.hostId);
            },
            (error) => {
              const count = (failures.get(host.hostId)?.count ?? 0) + 1;
              failures.set(host.hostId, {
                count,
                retryAt:
                  classifyConnectionFailure(error) === "reconnecting"
                    ? Date.now() + jitterMs(backgroundRetryDelayMs(count, error))
                    : Infinity,
              });
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
