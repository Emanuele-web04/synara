/**
 * RuntimeActivityLeaseManager - Server-internal boundary hiding per-provider
 * keepalive (Daytona refresh, Vercel timeout-extend, Modal idle-timeout
 * respect, Cloudflare renew) behind acquire/renew/release.
 *
 * A lease is taken on active work (turn, terminal, preview) and released on
 * exit/close. The orchestration seam never sees provider-specific keepalive.
 *
 * @module RuntimeActivityLeaseManager
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ExecutionInstanceId,
  RuntimeActivityLeaseId,
  RuntimeActivityLeaseSummary,
} from "@t3tools/contracts";

export type RuntimeActivityLeaseReason = RuntimeActivityLeaseSummary["reason"];

export interface RuntimeActivityLeaseAcquireInput {
  readonly instanceId: ExecutionInstanceId;
  readonly reason: RuntimeActivityLeaseReason;
}

export interface RuntimeActivityLeaseManagerShape {
  readonly acquire: (
    input: RuntimeActivityLeaseAcquireInput,
  ) => Effect.Effect<RuntimeActivityLeaseSummary>;
  readonly renew: (leaseId: RuntimeActivityLeaseId) => Effect.Effect<RuntimeActivityLeaseSummary>;
  readonly release: (leaseId: RuntimeActivityLeaseId) => Effect.Effect<void>;
}

export class RuntimeActivityLeaseManager extends ServiceMap.Service<
  RuntimeActivityLeaseManager,
  RuntimeActivityLeaseManagerShape
>()("t3/executionRuntime/Services/RuntimeActivityLeaseManager") {}
