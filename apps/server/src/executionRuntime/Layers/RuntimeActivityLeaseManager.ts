/**
 * RuntimeActivityLeaseManagerLive - In-memory activity-lease bookkeeping.
 *
 * A lease is taken on active work (turn, terminal, preview) and released on
 * exit/close. This v1 keeps the leases in memory and hides the per-provider
 * keepalive shape behind acquire / renew / release; real providers later plug
 * their refresh call (Daytona refresh, Vercel timeout-extend, Modal idle-timeout
 * respect, Cloudflare renew) behind these same three operations. The
 * orchestration seam never sees provider-specific keepalive.
 *
 * @module RuntimeActivityLeaseManagerLive
 */
import { Effect, Layer } from "effect";

import {
  RuntimeActivityLeaseId,
  type ExecutionInstanceId,
  type RuntimeActivityLeaseSummary,
} from "@t3tools/contracts";

import {
  RuntimeActivityLeaseManager,
  type RuntimeActivityLeaseManagerShape,
} from "../Services/RuntimeActivityLeaseManager.ts";

interface LeaseRecord {
  /** Null when a renew re-established a lease whose prior record was gone. */
  readonly instanceId: ExecutionInstanceId | null;
  readonly summary: RuntimeActivityLeaseSummary;
}

const makeRuntimeActivityLeaseManager = Effect.sync(() => {
  const leases = new Map<RuntimeActivityLeaseId, LeaseRecord>();

  const acquire: RuntimeActivityLeaseManagerShape["acquire"] = (input) =>
    Effect.sync(() => {
      const id = RuntimeActivityLeaseId.makeUnsafe(`lease-${crypto.randomUUID()}`);
      const summary: RuntimeActivityLeaseSummary = {
        id,
        reason: input.reason,
        acquiredAt: new Date().toISOString(),
        renewedAt: null,
        expiresAt: null,
      };
      leases.set(id, { instanceId: input.instanceId, summary });
      return summary;
    });

  const renew: RuntimeActivityLeaseManagerShape["renew"] = (leaseId) =>
    Effect.sync(() => {
      const record = leases.get(leaseId);
      // Renewing a released lease re-establishes it as active rather than
      // failing: a keepalive that races a release should keep work alive, not
      // crash. The original acquire time is preserved when known.
      const acquiredAt = record?.summary.acquiredAt ?? new Date().toISOString();
      const reason = record?.summary.reason ?? "turn";
      const summary: RuntimeActivityLeaseSummary = {
        id: leaseId,
        reason,
        acquiredAt,
        renewedAt: new Date().toISOString(),
        expiresAt: null,
      };
      leases.set(leaseId, { instanceId: record?.instanceId ?? null, summary });
      return summary;
    });

  const release: RuntimeActivityLeaseManagerShape["release"] = (leaseId) =>
    Effect.sync(() => {
      leases.delete(leaseId);
    });

  return { acquire, renew, release } satisfies RuntimeActivityLeaseManagerShape;
});

export const RuntimeActivityLeaseManagerLive = Layer.effect(
  RuntimeActivityLeaseManager,
  makeRuntimeActivityLeaseManager,
);
