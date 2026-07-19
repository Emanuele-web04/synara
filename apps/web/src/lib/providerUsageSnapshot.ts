// FILE: providerUsageSnapshot.ts
// Purpose: Normalize provider usage snapshots returned by the server into the
// same shapes consumed by the shared usage/rate-limit UI in the web app.

import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

import type { OpenUsageUsageLine } from "./openUsageRateLimits";
import type { ProviderRateLimit } from "./rateLimits";

const EMPTY_PROVIDER_USAGE_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export function createUnavailableProviderUsageSnapshot(
  provider: ProviderKind,
  source: string,
): ServerProviderUsageSnapshot {
  return {
    provider,
    updatedAt: EMPTY_PROVIDER_USAGE_UPDATED_AT,
    limits: [],
    usageLines: [],
    source,
    status: "error",
    detail: "Usage is currently unavailable.",
  };
}

export function isProviderUsageSnapshotNonOk(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): boolean {
  return snapshot?.status !== undefined && snapshot.status !== "ok";
}

export function normalizeServerProviderUsageRateLimit(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): ProviderRateLimit | null {
  if (!snapshot || snapshot.limits.length === 0) {
    return null;
  }

  return {
    provider: snapshot.provider,
    updatedAt: snapshot.updatedAt,
    limits: snapshot.limits.map((limit) => ({
      window: limit.window,
      ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
    })),
  };
}

export function normalizeServerProviderUsageLines(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): OpenUsageUsageLine[] {
  if (!snapshot || snapshot.usageLines.length === 0) {
    return [];
  }

  return snapshot.usageLines.map((line) => ({
    label: line.label,
    value: line.value,
    ...(line.subtitle ? { subtitle: line.subtitle } : {}),
  }));
}
