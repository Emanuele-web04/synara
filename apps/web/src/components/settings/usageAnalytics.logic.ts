// FILE: usageAnalytics.logic.ts
// Purpose: Turns the server's UTC-hour usage rows into the Analytics tab's local
//          days, provider and model totals, projects, and weekday-by-hour rhythm.
// Layer: Web settings logic (pure)
// Exports: range windows, buildUsageAnalyticsView, provider series colors

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type StatsGetUsageAnalyticsResult,
  type StatsUsageAnalyticsCostSource,
} from "@synara/contracts";

export type UsageAnalyticsRange = "7d" | "30d" | "90d" | "1y";
export type UsageAnalyticsMetric = "cost" | "tokens";
export type UsageAnalyticsProvider = ProviderKind | "unknown";

export const USAGE_ANALYTICS_RANGE_DAYS: Record<UsageAnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

/** One series color per provider, the same in every chart. */
export const PROVIDER_SERIES_COLOR: Record<UsageAnalyticsProvider, string> = {
  claudeAgent: "#D97757",
  codex: "var(--foreground)",
  cursor: "#7C93C9",
  antigravity: "#4F9D8C",
  grok: "#9B8BD0",
  droid: "#D4A13A",
  opencode: "#6FA86B",
  pi: "#C77DA6",
  devin: "#5E9BD6",
  omp: "#B0855A",
  unknown: "#A3A3A3",
};

export function providerLabel(provider: UsageAnalyticsProvider): string {
  return provider === "unknown" ? "Other" : PROVIDER_DISPLAY_NAMES[provider];
}

/** Local `YYYY-MM-DD` for an instant. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export interface UsageAnalyticsWindow {
  /** First local day shown, inclusive. */
  readonly from: Date;
  /** The local midnight after today, exclusive. */
  readonly to: Date;
  /** Start of the equal-length period before `from`, when it fits in one request. */
  readonly previousFrom: Date | null;
  readonly days: ReadonlyArray<Date>;
}

/**
 * Whole local days ending today. Up to 90 days the request also covers the
 * period before, so totals can show their change; a year is fetched alone.
 */
export function usageAnalyticsWindow(range: UsageAnalyticsRange, now: Date): UsageAnalyticsWindow {
  const count = USAGE_ANALYTICS_RANGE_DAYS[range];
  const today = startOfLocalDay(now);
  const from = addLocalDays(today, -(count - 1));
  const to = addLocalDays(today, 1);
  return {
    from,
    to,
    previousFrom: count <= 90 ? addLocalDays(from, -count) : null,
    days: Array.from({ length: count }, (_, index) => addLocalDays(from, index)),
  };
}

export interface ProviderAmount {
  tokens: number;
  costUsd: number;
}

export interface UsageAnalyticsDay {
  readonly key: string;
  readonly date: Date;
  readonly byProvider: Partial<Record<UsageAnalyticsProvider, ProviderAmount>>;
  tokens: number;
  costUsd: number;
}

export interface UsageAnalyticsProviderTotal {
  readonly provider: UsageAnalyticsProvider;
  tokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
  /** Where its cost comes from; null when it has none. */
  costSource: StatsUsageAnalyticsCostSource | null;
}

export interface UsageAnalyticsModelTotal {
  readonly provider: UsageAnalyticsProvider;
  readonly model: string;
  tokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

export interface UsageAnalyticsProjectTotal {
  /** Null for chats outside a real project. */
  readonly projectId: string | null;
  readonly title: string;
  tokens: number;
  costUsd: number;
  turns: number;
}

export interface UsageAnalyticsTotals {
  tokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
  failedTurns: number;
}

export interface UsageAnalyticsView {
  readonly days: ReadonlyArray<UsageAnalyticsDay>;
  readonly totals: UsageAnalyticsTotals;
  /** Null when the previous period was not fetched. */
  readonly previous: UsageAnalyticsTotals | null;
  readonly activeDays: number;
  readonly providers: ReadonlyArray<UsageAnalyticsProviderTotal>;
  readonly models: ReadonlyArray<UsageAnalyticsModelTotal>;
  readonly projects: ReadonlyArray<UsageAnalyticsProjectTotal>;
  readonly origins: Readonly<Record<"user" | "automation" | "agent", number>>;
  /** Tokens by local weekday (0 = Monday) and hour. */
  readonly rhythm: ReadonlyArray<ReadonlyArray<number>>;
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
  readonly pricing: StatsGetUsageAnalyticsResult["pricing"];
  /** Tokens in this period that needed an estimate and got none. */
  readonly unpriced: {
    /** No API list price for these models. */
    readonly tokens: number;
    readonly models: ReadonlyArray<string>;
    /** No input/output split recorded (deleted or older chats). */
    readonly unsplitTokens: number;
    readonly providers: ReadonlySet<UsageAnalyticsProvider>;
  };
}

function emptyTotals(): UsageAnalyticsTotals {
  return { tokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0, failedTurns: 0 };
}

/** Monday-first weekday index for a local date. */
function mondayWeekday(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** Most tokens first, then cost, then turns. */
function byActivity<T extends { tokens: number; costUsd: number; turns: number }>(
  left: T,
  right: T,
): number {
  return right.tokens - left.tokens || right.costUsd - left.costUsd || right.turns - left.turns;
}

export function buildUsageAnalyticsView(
  result: StatsGetUsageAnalyticsResult,
  window: UsageAnalyticsWindow,
): UsageAnalyticsView {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const previousFromMs = window.previousFrom?.getTime() ?? null;
  const days = window.days.map<UsageAnalyticsDay>((date) => ({
    key: localDayKey(date),
    date,
    byProvider: {},
    tokens: 0,
    costUsd: 0,
  }));
  const dayByKey = new Map(days.map((day) => [day.key, day]));
  const totals = emptyTotals();
  const previous = previousFromMs === null ? null : emptyTotals();
  const providers = new Map<UsageAnalyticsProvider, UsageAnalyticsProviderTotal>();
  const models = new Map<string, UsageAnalyticsModelTotal>();
  const projectTitles = new Map(
    result.projects.map((project) => [project.projectId, project.title]),
  );
  const projects = new Map<string, UsageAnalyticsProjectTotal>();
  const origins = { user: 0, automation: 0, agent: 0 };
  const rhythm = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const unpricedModels = new Set<string>();
  const unpricedProviders = new Set<UsageAnalyticsProvider>();
  let unpricedTokens = 0;
  let unsplitTokens = 0;

  const period = (hour: string): "current" | "previous" | null => {
    const ms = Date.parse(hour);
    if (ms >= fromMs && ms < toMs) return "current";
    if (previousFromMs !== null && ms >= previousFromMs && ms < fromMs) return "previous";
    return null;
  };
  const providerFor = (provider: UsageAnalyticsProvider) => {
    let total = providers.get(provider);
    if (!total) {
      total = { provider, tokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0, costSource: null };
      providers.set(provider, total);
    }
    return total;
  };
  const modelFor = (provider: UsageAnalyticsProvider, model: string) => {
    const key = `${provider}\u0000${model}`;
    let total = models.get(key);
    if (!total) {
      total = { provider, model, tokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0 };
      models.set(key, total);
    }
    return total;
  };
  const projectFor = (projectId: string | null) => {
    const title = projectId ? projectTitles.get(projectId) : undefined;
    const id = title ? projectId : null;
    const key = id ?? "";
    let total = projects.get(key);
    if (!total) {
      total = { projectId: id, title: title ?? "Chats", tokens: 0, costUsd: 0, turns: 0 };
      projects.set(key, total);
    }
    return total;
  };
  const dayFor = (hour: string, provider: UsageAnalyticsProvider) => {
    const day = dayByKey.get(localDayKey(new Date(hour)));
    if (!day) return null;
    const amount = (day.byProvider[provider] ??= { tokens: 0, costUsd: 0 });
    return { day, amount };
  };

  for (const row of result.tokens) {
    const when = period(row.hour);
    if (when === "previous" && previous) {
      previous.tokens += row.tokens;
      previous.cacheReadTokens += row.cacheReadTokens;
    }
    if (when !== "current") continue;
    totals.tokens += row.tokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    origins[row.origin] += row.tokens;
    if (row.unpricedTokens > 0) {
      unpricedTokens += row.unpricedTokens;
      if (row.model !== "unknown") unpricedModels.add(row.model);
    }
    unsplitTokens += row.unsplitTokens;
    if (row.unpricedTokens > 0 || row.unsplitTokens > 0) unpricedProviders.add(row.provider);
    const provider = providerFor(row.provider);
    provider.tokens += row.tokens;
    provider.cacheReadTokens += row.cacheReadTokens;
    const model = modelFor(row.provider, row.model);
    model.tokens += row.tokens;
    model.cacheReadTokens += row.cacheReadTokens;
    projectFor(row.projectId).tokens += row.tokens;
    const slot = dayFor(row.hour, row.provider);
    if (slot) {
      slot.amount.tokens += row.tokens;
      slot.day.tokens += row.tokens;
    }
    const date = new Date(row.hour);
    const weekday = rhythm[mondayWeekday(date)];
    if (weekday) weekday[date.getHours()] = (weekday[date.getHours()] ?? 0) + row.tokens;
  }

  for (const row of result.turns) {
    const when = period(row.hour);
    if (when === "previous" && previous) {
      previous.turns += row.turns;
      previous.failedTurns += row.failedTurns;
    }
    if (when !== "current") continue;
    totals.turns += row.turns;
    totals.failedTurns += row.failedTurns;
    providerFor(row.provider).turns += row.turns;
    modelFor(row.provider, row.model).turns += row.turns;
    projectFor(row.projectId).turns += row.turns;
  }

  for (const row of result.costs) {
    const when = period(row.hour);
    if (when === "previous" && previous) previous.costUsd += row.costUsd;
    if (when !== "current") continue;
    totals.costUsd += row.costUsd;
    const provider = providerFor(row.provider);
    provider.costUsd += row.costUsd;
    // A provider's own figure outranks an estimate.
    if (provider.costSource !== "reported") provider.costSource = row.source;
    modelFor(row.provider, row.model).costUsd += row.costUsd;
    projectFor(row.projectId).costUsd += row.costUsd;
    const slot = dayFor(row.hour, row.provider);
    if (slot) {
      slot.amount.costUsd += row.costUsd;
      slot.day.costUsd += row.costUsd;
    }
  }

  return {
    days,
    totals,
    previous,
    activeDays: days.filter((day) => day.tokens > 0 || day.costUsd > 0).length,
    providers: [...providers.values()]
      .filter((provider) => provider.tokens > 0 || provider.costUsd > 0 || provider.turns > 0)
      .toSorted(byActivity),
    models: [...models.values()]
      .filter((model) => model.tokens > 0 || model.costUsd > 0 || model.turns > 0)
      .toSorted(byActivity),
    projects: [...projects.values()]
      .filter((project) => project.tokens > 0 || project.costUsd > 0)
      .toSorted(byActivity),
    origins,
    rhythm,
    unavailableProviders: result.unavailableProviders,
    pricing: result.pricing,
    unpriced: {
      tokens: unpricedTokens,
      models: [...unpricedModels].toSorted(),
      unsplitTokens,
      providers: unpricedProviders,
    },
  };
}

/** Percent change from `previous` to `current`, or null when there is no base. */
export function percentChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
