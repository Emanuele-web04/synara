import { classifyConnectionFailure } from "./failure";
import type { HostConnectionsPort } from "./port";
import type { HostConnectionRegistry } from "./registry";

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
                    ? Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(count, 5))
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
