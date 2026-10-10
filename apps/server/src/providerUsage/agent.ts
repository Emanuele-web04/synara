// FILE: providerUsage/agent.ts
// Purpose: Interpret existing provider-usage snapshots for agents without creating a second
// accounting source. Only fresh, authoritative percentage limits become actionable quota windows;
// token totals, spend lines, missing data, and stale observations remain explicitly unavailable.

import type {
  AgentProviderUsageUnavailableReason,
  ProviderKind,
  ServerAgentProviderUsage,
  ServerAgentProviderUsageWindow,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

export const AGENT_PROVIDER_USAGE_MAX_AGE_MS = 5 * 60 * 1000;

const EMAIL_PATTERN = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.]+/u;
const EMAIL_PATTERN_GLOBAL = new RegExp(EMAIL_PATTERN.source, "gu");

export const redactProviderUsageAccountText = (value: string): string =>
  value.replace(EMAIL_PATTERN_GLOBAL, "[account]");

// Agents can address configured accounts by their safe instance IDs, without account emails.
function scrubAccountMetadata(snapshot: ServerProviderUsageSnapshot): ServerProviderUsageSnapshot {
  return {
    ...snapshot,
    detail:
      snapshot.detail === undefined ? undefined : redactProviderUsageAccountText(snapshot.detail),
    planName:
      snapshot.planName === undefined
        ? undefined
        : redactProviderUsageAccountText(snapshot.planName),
    source: redactProviderUsageAccountText(snapshot.source),
    limits: snapshot.limits.map((limit) => ({
      ...limit,
      window: redactProviderUsageAccountText(limit.window),
    })),
    ...(snapshot.resetCredits
      ? {
          resetCredits: {
            ...snapshot.resetCredits,
            ...(snapshot.resetCredits.accountId === undefined
              ? {}
              : { accountId: redactProviderUsageAccountText(snapshot.resetCredits.accountId) }),
            ...(snapshot.resetCredits.credits === undefined
              ? {}
              : {
                  credits: snapshot.resetCredits.credits.map((credit) => ({
                    ...credit,
                    id: redactProviderUsageAccountText(credit.id),
                    ...(credit.title === undefined
                      ? {}
                      : { title: redactProviderUsageAccountText(credit.title) }),
                    ...(credit.description === undefined
                      ? {}
                      : { description: redactProviderUsageAccountText(credit.description) }),
                  })),
                }),
          },
        }
      : {}),
    usageLines: snapshot.usageLines.filter(
      (line) =>
        line.label.trim().toLowerCase() !== "account" &&
        !EMAIL_PATTERN.test(line.label) &&
        !EMAIL_PATTERN.test(line.value) &&
        !(line.subtitle !== undefined && EMAIL_PATTERN.test(line.subtitle)),
    ),
  };
}

function snapshotUnavailableReason(
  snapshot: ServerProviderUsageSnapshot,
): AgentProviderUsageUnavailableReason | null {
  switch (snapshot.status ?? "ok") {
    case "needs-auth":
      return "needs-auth";
    case "unsupported":
      return "unsupported";
    case "error":
      return "provider-error";
    case "ok":
      return null;
  }
}

function unavailableResult(input: {
  provider: ProviderKind;
  checkedAt: string;
  reason: AgentProviderUsageUnavailableReason;
  snapshot: ServerProviderUsageSnapshot | null;
  ageMs?: number;
  stale?: boolean;
}): ServerAgentProviderUsage {
  return {
    provider: input.provider,
    availability: "unavailable",
    unavailableReason: input.reason,
    checkedAt: input.checkedAt,
    freshness: {
      stale: input.stale === true || input.reason === "stale" || input.snapshot === null,
      ageMs: input.ageMs ?? 0,
      maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS,
    },
    snapshot: input.snapshot,
    quotaWindows: [],
  };
}

/** Pure conversion kept separate from fetching so every transport applies identical safety rules. */
export function summarizeProviderUsageForAgent(input: {
  provider: ProviderKind;
  enabled: boolean;
  snapshot: ServerProviderUsageSnapshot | null;
  checkedAtMs?: number;
  unavailableReason?: "timed-out" | "provider-error" | "unsupported";
}): ServerAgentProviderUsage {
  const checkedAtMs = input.checkedAtMs ?? Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  if (!input.enabled) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "disabled",
      snapshot: null,
    });
  }
  if (input.unavailableReason) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: input.unavailableReason,
      snapshot: null,
    });
  }
  if (!input.snapshot) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "missing-snapshot",
      snapshot: null,
    });
  }

  const originalSnapshot = scrubAccountMetadata(input.snapshot);
  const observedAtMs = Date.parse(originalSnapshot.updatedAt);
  const ageMs = Number.isFinite(observedAtMs) ? Math.max(0, checkedAtMs - observedAtMs) : 0;
  const snapshot: ServerProviderUsageSnapshot = {
    ...originalSnapshot,
    usageLines: originalSnapshot.usageLines.map((line) => ({
      ...line,
      source: redactProviderUsageAccountText(line.source ?? originalSnapshot.source),
      observedAt: line.observedAt ?? originalSnapshot.updatedAt,
    })),
  };
  const statusReason = snapshotUnavailableReason(snapshot);
  const stale =
    snapshot.stale === true ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs > checkedAtMs ||
    ageMs > AGENT_PROVIDER_USAGE_MAX_AGE_MS;
  if (statusReason) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: statusReason,
      snapshot,
      ageMs,
      stale,
    });
  }
  if (stale) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "stale",
      snapshot,
      ageMs,
    });
  }

  const quotaWindows: ServerAgentProviderUsageWindow[] = snapshot.limits.map((limit) => {
    const common = {
      window: limit.window,
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
      source: snapshot.source,
      observedAt: snapshot.updatedAt,
    };
    const resetAtMs = limit.resetsAt ? Date.parse(limit.resetsAt) : null;
    if (resetAtMs !== null && Number.isFinite(resetAtMs) && resetAtMs <= checkedAtMs) {
      return { ...common, availability: "unavailable", unavailableReason: "expired-window" };
    }
    if (limit.usedPercent === undefined) {
      return { ...common, availability: "unavailable", unavailableReason: "missing-quota" };
    }
    return {
      ...common,
      availability: "available",
      usedPercent: limit.usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - limit.usedPercent)),
    };
  });
  const availableCount = quotaWindows.filter(
    (window) => window.availability === "available",
  ).length;
  if (availableCount === 0) {
    return {
      provider: input.provider,
      availability: "unavailable",
      unavailableReason:
        quotaWindows[0]?.unavailableReason === "expired-window"
          ? "expired-window"
          : "missing-quota",
      checkedAt,
      freshness: { stale: false, ageMs, maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS },
      snapshot,
      quotaWindows,
    };
  }

  return {
    provider: input.provider,
    availability: availableCount === quotaWindows.length ? "available" : "partial",
    checkedAt,
    freshness: { stale: false, ageMs, maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS },
    snapshot,
    quotaWindows,
  };
}
