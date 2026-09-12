// FILE: rateLimits.ts
// Purpose: Centralizes rate-limit parsing, normalization, formatting, and row derivation
// for provider runtime events so UI components can stay presentation-only.

import type { OrchestrationThread } from "@synara/contracts";
import { providerUsageLearnMoreHref } from "@synara/shared/providerUsage";

export interface RateLimitWindow {
  window: string;
  usedPercent?: number | undefined;
  utilization?: number | undefined;
  resetsAt?: string | undefined;
  windowDurationMins?: number | undefined;
}

export interface ProviderRateLimit {
  provider: string;
  updatedAt: string;
  limits?: ReadonlyArray<RateLimitWindow>;
  usedPercent?: number;
  utilization?: number;
  resetsAt?: string;
  windowDurationMins?: number;
  status?: string;
}

export interface VisibleRateLimitRow {
  id: string;
  label: string;
  remainingPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

/** Activity kinds that carry account rate-limit payloads. Shared with the store selector
 *  that narrows usage subscribers to these activities, so the two stay in sync. */
export const ACCOUNT_RATE_LIMIT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
]);

const WINDOW_ORDER = new Map([
  ["5h", 0],
  ["Daily", 1],
  ["Weekly", 2],
  ["Fable", 3],
  ["Sonnet", 4],
  ["Opus", 5],
  ["Weekly (overage)", 6],
  ["Usage credits", 20],
  ["Current", 30],
]);

// Unmapped provider labels keep their identity and sort together before the paid-credits
// bucket, so an account window always stays ahead of an unrecognized provider-specific row.
const UNKNOWN_WINDOW_ORDER = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function toUsedPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampPercent(value <= 1 ? value * 100 : value);
}

function resolveUsedPercent(values: {
  usedPercent?: unknown;
  utilization?: unknown;
}): number | undefined {
  if (typeof values.usedPercent === "number") return clampPercent(values.usedPercent);
  if (typeof values.utilization === "number") return toUsedPercent(values.utilization);
  return undefined;
}

function isUpcomingReset(resetsAt: string | undefined, nowMs: number): boolean {
  if (!resetsAt) return true;
  const resetMs = Date.parse(resetsAt);
  return Number.isNaN(resetMs) || resetMs >= nowMs;
}

function toResetString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function toIsoReset(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  return toResetString(value);
}

// Single source of truth for the duration behind a canonical window identity. Claude's
// per-model weekly windows share 10080 with the account Weekly window on purpose; keeping
// the identity separate even when the duration matches is the whole point of this table.
const WINDOW_DURATION_MINS = new Map<string, number>([
  ["5h", 5 * 60],
  ["Daily", 24 * 60],
  ["Weekly", 7 * 24 * 60],
  ["Fable", 7 * 24 * 60],
  ["Sonnet", 7 * 24 * 60],
  ["Opus", 7 * 24 * 60],
  ["Weekly (overage)", 7 * 24 * 60],
]);

export function windowDurationMinsForWindowLabel(label: string | undefined): number | undefined {
  return label ? WINDOW_DURATION_MINS.get(label) : undefined;
}

function windowLabelFromDuration(windowDurationMins: number | undefined): string | undefined {
  if (windowDurationMins === 5 * 60) return "5h";
  // Reverse inference stays limited to the account session/weekly windows. `Daily = 1440`
  // intentionally has no reverse mapping, matching the previous fallback behavior.
  if (windowDurationMins === 7 * 24 * 60) return "Weekly";
  return undefined;
}

// Exact-match aliases, normalized as `lowercase` with `_`/spaces/dashes collapsed to `_`.
// Resolved before the duration fallback so model-scoped windows keep their identity even
// when they share the account window's duration.
const WINDOW_LABEL_ALIASES = new Map<string, string>([
  ["fable", "Fable"],
  ["seven_day_fable", "Fable"],
  ["weekly_fable", "Fable"],
  ["sonnet", "Sonnet"],
  ["seven_day_sonnet", "Sonnet"],
  ["weekly_sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["seven_day_opus", "Opus"],
  ["weekly_opus", "Opus"],
  // Claude Code reports its included overage allowance as `*_overage_included`. Its model
  // scope is not proven, so it stays an independent window here; paid overage stays separate.
  ["seven_day_overage_included", "Weekly (overage)"],
  ["weekly_overage_included", "Weekly (overage)"],
  ["weekly_overage", "Weekly (overage)"],
  ["weekly_(overage)", "Weekly (overage)"],
  ["overage", "Usage credits"],
  ["usage_credits", "Usage credits"],
]);

// Provider-generic keys whose identity comes from the duration first, then from a canonical
// fallback name. Any key outside this set and the aliases keeps its own trimmed identity.
const GENERIC_WINDOW_KEYS = new Map<string, string>([
  ["session", "5h"],
  ["five_hour", "5h"],
  ["5h", "5h"],
  ["seven_day", "Weekly"],
  ["7d", "Weekly"],
  ["weekly", "Weekly"],
  ["daily", "Daily"],
  ["current", "Current"],
  ["primary", "Primary"],
  ["secondary", "Secondary"],
]);

export function normalizeRateLimitLabel(
  label: string | undefined,
  windowDurationMins?: number,
): string {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) {
    return windowLabelFromDuration(windowDurationMins) ?? "Current";
  }

  const normalizedKey = trimmed.toLowerCase().replace(/[_\s-]+/g, "_");
  // Named pools can share the same duration as standard limits. Keep the pool prefix so
  // `Core 5h` and `5h` render as separate meters instead of collapsing into one row.
  if (normalizedKey.startsWith("core_")) {
    return humanizeLabel(trimmed);
  }

  const alias = WINDOW_LABEL_ALIASES.get(normalizedKey);
  if (alias) {
    return alias;
  }

  const generic = GENERIC_WINDOW_KEYS.get(normalizedKey);
  if (generic) {
    return windowLabelFromDuration(windowDurationMins) ?? generic;
  }

  // Unmapped provider labels keep their trimmed identity so model-scoped or pool-scoped
  // windows never collapse into a generic duration bucket. `Opus 4.5` stays `Opus 4.5`.
  return trimmed;
}

/**
 * Display-only formatting for a normalized window identity. Pure machine keys (`snake_case`)
 * are humanized; every other identity is shown exactly as reported. Identity itself never
 * changes here, so display text cannot re-trigger merging or lose the raw label.
 */
export function formatRateLimitDisplayLabel(identity: string): string {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/u.test(identity) ? humanizeLabel(identity) : identity;
}

function humanizeLabel(label: string): string {
  return label
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function compareWindowLabels(a: string, b: string): number {
  const orderA = WINDOW_ORDER.get(a) ?? UNKNOWN_WINDOW_ORDER;
  const orderB = WINDOW_ORDER.get(b) ?? UNKNOWN_WINDOW_ORDER;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  // Deterministic code-unit comparison: stable across machines and locales, and consistent
  // with treating the identity (including its case) as meaningful.
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function normalizeLimitWindow(
  label: string,
  rawWindow: Record<string, unknown>,
): RateLimitWindow | null {
  const usedPercent = resolveUsedPercent(rawWindow);
  const windowDurationMins =
    typeof rawWindow.windowDurationMins === "number" ? rawWindow.windowDurationMins : undefined;
  const resetsAt = toIsoReset(rawWindow.resetsAt);

  if (usedPercent === undefined && !resetsAt) return null;

  const window: RateLimitWindow = {
    window: normalizeRateLimitLabel(label, windowDurationMins),
  };
  if (usedPercent !== undefined) {
    window.usedPercent = usedPercent;
  }
  if (resetsAt) {
    window.resetsAt = resetsAt;
  }
  if (windowDurationMins !== undefined) {
    window.windowDurationMins = windowDurationMins;
  }
  return window;
}

function extractLimitsFromById(payload: Record<string, unknown>): RateLimitWindow[] | undefined {
  const rateLimitsByLimitId = asRecord(payload.rateLimitsByLimitId);
  if (!rateLimitsByLimitId) return undefined;

  const limits = Object.values(rateLimitsByLimitId)
    .map((entry) => asRecord(entry))
    .flatMap((entry) => {
      if (!entry) return [];
      const primary = asRecord(entry.primary);
      if (!primary) return [];
      const label =
        typeof entry.label === "string"
          ? entry.label
          : typeof entry.window === "string"
            ? entry.window
            : "";
      const normalized = normalizeLimitWindow(label, primary);
      return normalized ? [normalized] : [];
    });

  return limits.length > 0 ? limits : undefined;
}

function extractLimitsFromArray(payload: Record<string, unknown>): RateLimitWindow[] | undefined {
  if (!Array.isArray(payload.limits)) return undefined;

  const limits = payload.limits
    .map((entry) => asRecord(entry))
    .flatMap((entry) => {
      if (!entry || typeof entry.window !== "string") return [];
      const normalized = normalizeLimitWindow(entry.window, entry);
      return normalized ? [normalized] : [];
    });

  return limits.length > 0 ? limits : undefined;
}

function extractLimitsFromCodexPayload(
  payload: Record<string, unknown>,
): RateLimitWindow[] | undefined {
  const rateLimitsRoot = asRecord(payload.rateLimits);
  const nestedRateLimits =
    rateLimitsRoot && asRecord(rateLimitsRoot.rateLimits)
      ? asRecord(rateLimitsRoot.rateLimits)
      : (rateLimitsRoot ?? payload);
  if (!nestedRateLimits) return undefined;

  const primary = asRecord(nestedRateLimits.primary);
  const secondary = asRecord(nestedRateLimits.secondary);
  const limits: RateLimitWindow[] = [];

  if (primary) {
    const normalized = normalizeLimitWindow("Session", {
      usedPercent: primary.usedPercent,
      resetsAt: primary.resetsAt,
      windowDurationMins: primary.windowDurationMins,
    });
    if (normalized) limits.push(normalized);
  }

  if (secondary) {
    const normalized = normalizeLimitWindow("Weekly", {
      usedPercent: secondary.usedPercent,
      resetsAt: secondary.resetsAt,
      windowDurationMins: secondary.windowDurationMins,
    });
    if (normalized) limits.push(normalized);
  }

  return limits.length > 0 ? limits : undefined;
}

function extractLimitsFromClaudePayload(
  payload: Record<string, unknown>,
): { limits?: RateLimitWindow[]; status?: string } | undefined {
  const info = asRecord(payload.rate_limit_info);
  if (!info) return undefined;

  const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  // Normalize the identity first, then resolve a known duration from that identity. Claude
  // per-model weekly windows share 10080 with the account Weekly window without collapsing.
  const label = normalizeRateLimitLabel(rateLimitType);
  const windowDurationMins = windowDurationMinsForWindowLabel(label);
  const normalized = normalizeLimitWindow(label, {
    utilization: info.utilization,
    resetsAt: info.resetsAt,
    windowDurationMins,
  });

  return {
    ...(normalized ? { limits: [normalized] } : {}),
    ...(typeof info.status === "string" ? { status: info.status } : {}),
  };
}

function extractFallbackLimits(payload: Record<string, unknown>): RateLimitWindow[] | undefined {
  const usedPercent = resolveUsedPercent(payload);
  const resetsAt = toIsoReset(payload.resetsAt);
  const windowDurationMins =
    typeof payload.windowDurationMins === "number" ? payload.windowDurationMins : undefined;

  if (usedPercent === undefined && !resetsAt) return undefined;

  return [
    {
      window: normalizeRateLimitLabel(undefined, windowDurationMins),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    },
  ];
}

export function deriveAccountRateLimits(
  threads: ReadonlyArray<Pick<OrchestrationThread, "activities">>,
): ProviderRateLimit[] {
  const byProvider = new Map<string, ProviderRateLimit>();
  const nowMs = Date.now();

  for (const thread of threads) {
    for (const activity of thread.activities) {
      if (!ACCOUNT_RATE_LIMIT_ACTIVITY_KINDS.has(activity.kind)) {
        continue;
      }

      const payload = asRecord(activity.payload);
      if (!payload) continue;

      const provider = typeof payload.provider === "string" ? payload.provider : "unknown";
      const existing = byProvider.get(provider);
      if (existing && existing.updatedAt > activity.createdAt) continue;

      const claudePayload = extractLimitsFromClaudePayload(payload);
      const limits = (
        extractLimitsFromById(payload) ??
        extractLimitsFromArray(payload) ??
        extractLimitsFromCodexPayload(payload) ??
        claudePayload?.limits ??
        extractFallbackLimits(payload)
      )
        ?.filter((limit) => isUpcomingReset(limit.resetsAt, nowMs))
        .toSorted((a, b) => compareWindowLabels(a.window, b.window));

      if (!limits || limits.length === 0) continue;

      byProvider.set(provider, {
        provider,
        updatedAt: activity.createdAt,
        limits,
        ...(claudePayload?.status ? { status: claudePayload.status } : {}),
      });
    }
  }

  return Array.from(byProvider.values());
}

export function deriveVisibleRateLimitRows(
  rateLimits: ReadonlyArray<ProviderRateLimit>,
): VisibleRateLimitRow[] {
  const rowsByLabel = new Map<string, VisibleRateLimitRow & { usedPercent: number }>();

  for (const rateLimit of rateLimits) {
    const limits =
      rateLimit.limits && rateLimit.limits.length > 0
        ? rateLimit.limits
        : [
            {
              window: normalizeRateLimitLabel(undefined, rateLimit.windowDurationMins),
              ...(() => {
                const usedPercent = resolveUsedPercent(rateLimit);
                return usedPercent !== undefined ? { usedPercent } : {};
              })(),
              ...(rateLimit.resetsAt ? { resetsAt: rateLimit.resetsAt } : {}),
              ...(typeof rateLimit.windowDurationMins === "number"
                ? { windowDurationMins: rateLimit.windowDurationMins }
                : {}),
            },
          ];

    for (const limit of limits) {
      const usedPercent = resolveUsedPercent(limit);
      if (usedPercent === undefined) continue;

      const label = normalizeRateLimitLabel(limit.window, limit.windowDurationMins);
      const row = {
        id: `${rateLimit.provider}-${label}`,
        label,
        remainingPercent: Math.round(100 - usedPercent),
        ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
        ...(typeof limit.windowDurationMins === "number"
          ? { windowDurationMins: limit.windowDurationMins }
          : {}),
        usedPercent,
      };

      const existing = rowsByLabel.get(label);
      if (!existing || usedPercent > existing.usedPercent) {
        rowsByLabel.set(label, row);
      }
    }
  }

  return Array.from(rowsByLabel.values())
    .toSorted((a, b) => compareWindowLabels(a.label, b.label))
    .map(({ usedPercent: _usedPercent, ...row }) => row);
}

export function formatRateLimitRemainingPercent(remainingPercent: number | undefined): string {
  if (remainingPercent === undefined) return "—";
  return `${Math.round(Math.min(100, Math.max(0, remainingPercent)))}%`;
}

/** Relative reset countdown, e.g. "Resets in 2h 16m" / "Resets in 5d 11h". */
export function formatRateLimitResetCountdown(resetsAt: string): string {
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) {
    return "";
  }
  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) {
    return "Resets soon";
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `Resets in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `Resets in ${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `Resets in ${minutes}m`;
  }
  return "Resets soon";
}

export function deriveRateLimitLearnMoreHref(
  rateLimits: ReadonlyArray<ProviderRateLimit>,
): string | null {
  const providers = new Set(rateLimits.map((rateLimit) => rateLimit.provider));
  if (providers.size !== 1) return null;

  const [provider] = providers;
  return deriveProviderUsageLearnMoreHref(provider);
}

export function deriveProviderUsageLearnMoreHref(
  provider: string | null | undefined,
): string | null {
  return providerUsageLearnMoreHref(provider);
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function mergeRateLimitWindowSets(
  preferred: ReadonlyArray<RateLimitWindow>,
  fallback: ReadonlyArray<RateLimitWindow>,
  preferredUpdatedAt?: string,
  fallbackUpdatedAt?: string,
): RateLimitWindow[] {
  const merged = new Map<string, RateLimitWindow>();
  const preferredIsNewerOrSame = timestampMs(preferredUpdatedAt) >= timestampMs(fallbackUpdatedAt);

  for (const limit of fallback) {
    const label = normalizeRateLimitLabel(limit.window, limit.windowDurationMins);
    merged.set(label, {
      ...limit,
      window: label,
    });
  }

  for (const limit of preferred) {
    const label = normalizeRateLimitLabel(limit.window, limit.windowDurationMins);
    const existing = merged.get(label);
    if (existing && !preferredIsNewerOrSame) {
      merged.set(label, {
        ...limit,
        ...existing,
        window: label,
      });
      continue;
    }
    merged.set(label, {
      ...existing,
      ...limit,
      window: label,
    });
  }

  return Array.from(merged.values()).toSorted((a, b) => compareWindowLabels(a.window, b.window));
}

function mergeProviderRateLimit(
  preferred: ProviderRateLimit,
  fallback: ProviderRateLimit | undefined,
): ProviderRateLimit {
  if (!fallback) return preferred;

  return {
    provider: preferred.provider,
    updatedAt:
      timestampMs(preferred.updatedAt) >= timestampMs(fallback.updatedAt)
        ? preferred.updatedAt
        : fallback.updatedAt,
    limits: mergeRateLimitWindowSets(
      preferred.limits ?? [],
      fallback.limits ?? [],
      preferred.updatedAt,
      fallback.updatedAt,
    ),
    ...((preferred.status ?? fallback.status)
      ? { status: preferred.status ?? fallback.status }
      : {}),
  };
}

export function mergeProviderRateLimits(
  preferred: ReadonlyArray<ProviderRateLimit>,
  fallback: ReadonlyArray<ProviderRateLimit>,
): ProviderRateLimit[] {
  const merged = new Map<string, ProviderRateLimit>();

  for (const rateLimit of fallback) {
    merged.set(rateLimit.provider, rateLimit);
  }

  for (const rateLimit of preferred) {
    merged.set(
      rateLimit.provider,
      mergeProviderRateLimit(rateLimit, merged.get(rateLimit.provider)),
    );
  }

  return Array.from(merged.values());
}
