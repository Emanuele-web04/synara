import {
  ClaudeCacheObservation,
  type ProviderKind,
  type OrchestrationThreadActivity,
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "@synara/shared/model";
import { Schema } from "effect";

const decodeClaudeCacheObservation = Schema.decodeUnknownOption(ClaudeCacheObservation);

function readClaudeCacheObservation(value: unknown): ClaudeCacheObservation | null {
  const decoded = decodeClaudeCacheObservation(value);
  return decoded._tag === "Some" ? decoded.value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asContextWindowPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  if (percent === null) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export interface ContextWindowState {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly invalidatedByCompaction: boolean;
}

export interface ContextWindowSelectionStatus {
  readonly activeLabel: string | null;
  readonly selectedLabel: string | null;
  readonly pendingSelectedLabel: string | null;
}

export interface ContextWindowMeterDisplay {
  readonly usedPercentageLabel: string | null;
  readonly tokenUsageLabel: string;
  readonly hasReliableTokenRatio: boolean;
  readonly normalizedPercentage: number;
  readonly compactLabel: string;
  readonly ariaLabel: string;
}

const KNOWN_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

export function isCompletedContextCompaction(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-compaction") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.state === "compacted" || payload?.status === "completed";
}

// Read the latest token-usage snapshot emitted by the runtime.
export function deriveLatestContextWindowState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowState {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) {
      continue;
    }
    // A new configuration starts a new reporting epoch. Old usage cannot
    // establish the effective threshold of a resumed or switched session.
    if (activity.kind === "context-window.configured") {
      return { snapshot: null, invalidatedByCompaction: false };
    }
    if (isCompletedContextCompaction(activity)) {
      return { snapshot: null, invalidatedByCompaction: true };
    }
    if (activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const rawUsedTokens = asFiniteNumber(payload?.usedTokens);
    const usedTokens = rawUsedTokens ?? 0;
    const payloadUsedPercent = asContextWindowPercent(payload?.usedPercent);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (usedTokens <= 0 && payloadUsedPercent === null && (maxTokens === null || maxTokens <= 0)) {
      continue;
    }

    const usedPercentage =
      payloadUsedPercent ??
      (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
    const hasReliableTokenUsage =
      rawUsedTokens !== null &&
      (usedTokens > 0 || payloadUsedPercent === null || (maxTokens !== null && maxTokens > 0));
    const remainingTokens =
      maxTokens !== null && hasReliableTokenUsage
        ? Math.max(0, Math.round(maxTokens - usedTokens))
        : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      snapshot: {
        claudeCache: readClaudeCacheObservation(payload?.claudeCache),
        usedTokens,
        usedPercent: payloadUsedPercent,
        // Older Claude totals counted completed content blocks repeatedly.
        // Keep the context meter, but withhold an unverifiable lifetime counter.
        totalProcessedTokens:
          payload?.provider === "claudeAgent" && payload.tokenAccountingVersion !== 1
            ? null
            : asFiniteNumber(payload?.totalProcessedTokens),
        tokenAccountingVersion: payload?.tokenAccountingVersion === 1 ? 1 : null,
        maxTokens,
        remainingTokens,
        usedPercentage,
        remainingPercentage,
        inputTokens: asFiniteNumber(payload?.inputTokens),
        cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
        outputTokens: asFiniteNumber(payload?.outputTokens),
        reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
        lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
        lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
        lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
        lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
        lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
        toolUses: asFiniteNumber(payload?.toolUses),
        durationMs: asFiniteNumber(payload?.durationMs),
        compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
        updatedAt: activity.createdAt,
      },
      invalidatedByCompaction: false,
    };
  }

  return { snapshot: null, invalidatedByCompaction: false };
}

export interface ObservedClaudeContextBudget {
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * The context budget the runtime reported for the newest observed Claude model, held at
 * the largest value seen since the session was configured (or last compacted).
 *
 * Within a turn the runtime first reports a provisional budget from the model catalog
 * (e.g. 200k) and corrects it from the live session at the end of the turn (e.g. 1M);
 * usage events without a cache observation (task usage) carry no model at all. Reading
 * each snapshot on its own made the composer label flip between "(200k)" and "(1M)" for
 * the same model while a turn ran. The server only ever raises its corrected window, so
 * the largest report for one model in an epoch is the stable answer.
 */
export function deriveObservedClaudeContextBudget(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ObservedClaudeContextBudget | null {
  let model: string | null = null;
  let maxTokens = 0;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    if (activity.kind === "context-window.configured" || isCompletedContextCompaction(activity)) {
      break;
    }
    if (activity.kind !== "context-window.updated") continue;
    const payload = asRecord(activity.payload);
    const observedModel = readClaudeCacheObservation(payload?.claudeCache)?.model;
    const reportedMaxTokens = asFiniteNumber(payload?.maxTokens);
    if (!observedModel || reportedMaxTokens === null || reportedMaxTokens <= 0) continue;
    if (model === null) model = observedModel;
    if (observedModel === model) maxTokens = Math.max(maxTokens, reportedMaxTokens);
  }
  return model === null ? null : { model, maxTokens };
}

// Configuration identifies the applied target, never the runtime denominator.
export function deriveAppliedContextWindowSelection(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  const activity = activities.findLast((item) => item.kind === "context-window.configured");
  const payload = asRecord(activity?.payload);
  if (payload?.cleared === true) return "auto";
  const maxTokens = asFiniteNumber(payload?.maxTokens);
  return (
    Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).find(
      ([, tokens]) => tokens === maxTokens,
    )?.[0] ?? null
  );
}

export function deriveSelectedContextWindowSnapshot(
  selectedValue: string | null | undefined,
): ContextWindowSnapshot | null {
  const normalized = selectedValue?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const maxTokens =
    KNOWN_CONTEXT_WINDOW_MAX_TOKENS[normalized as keyof typeof KNOWN_CONTEXT_WINDOW_MAX_TOKENS] ??
    null;
  if (maxTokens === null) {
    return null;
  }

  return {
    claudeCache: null,
    usedTokens: 0,
    usedPercent: null,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens: maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "",
  };
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function deriveContextWindowMeterDisplay(
  usage: ContextWindowSnapshot,
): ContextWindowMeterDisplay {
  const usedPercentageLabel = formatPercentage(usage.usedPercentage);
  const tokenUsageLabel = formatContextWindowTokens(usage.usedTokens);
  const hasReliableTokenRatio =
    usage.maxTokens !== null &&
    (usage.usedTokens > 0 || usage.usedPercent === null || usage.remainingTokens !== null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  return {
    usedPercentageLabel,
    tokenUsageLabel,
    hasReliableTokenRatio,
    normalizedPercentage,
    compactLabel:
      usage.usedPercentage !== null ? `${Math.round(usage.usedPercentage)}%` : tokenUsageLabel,
    ariaLabel: usedPercentageLabel
      ? `Context window ${usedPercentageLabel} used`
      : `Context window ${tokenUsageLabel} tokens used`,
  };
}

/** 16-unit meter glyph: a pie inside an outline ring (1.5 stroke) with a one-unit gap. */
export const CONTEXT_WINDOW_METER_GEOMETRY = {
  center: 8,
  pieRadius: 5.25,
  outlineRadius: 7,
} as const;

/**
 * Filled pie sector for a usage percentage, starting at 12 o'clock and running clockwise.
 * A filled sector inside a closed outline reads as a gauge; the open stroked arc it replaces
 * looked like a loading spinner.
 */
export function contextWindowMeterSectorPath(percentage: number): string | null {
  const fraction = Math.max(0, Math.min(100, percentage)) / 100;
  if (fraction <= 0) return null;
  const c = CONTEXT_WINDOW_METER_GEOMETRY.center;
  const r = CONTEXT_WINDOW_METER_GEOMETRY.pieRadius;
  if (fraction >= 1) {
    return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z`;
  }
  const angle = fraction * 2 * Math.PI;
  const x = c + r * Math.sin(angle);
  const y = c - r * Math.cos(angle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

export function deriveCumulativeCostUsd(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let turnDeltaTotal = 0;
  let latestCumulative: number | null = null;
  let foundTurnDelta = false;
  for (const activity of activities) {
    if (activity.kind !== "turn.completed") continue;
    const payload = asRecord(activity.payload);
    const cumulativeCost = asFiniteNumber(payload?.cumulativeCostUsd);
    if (cumulativeCost !== null) {
      latestCumulative = cumulativeCost;
      continue;
    }
    const cost = asFiniteNumber(payload?.totalCostUsd);
    if (cost === null) continue;
    turnDeltaTotal += cost;
    foundTurnDelta = true;
  }
  if (latestCumulative !== null) {
    return latestCumulative + turnDeltaTotal;
  }
  return foundTurnDelta ? turnDeltaTotal : null;
}

function formatContextWindowSelectionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "auto") return "Auto";
  if (normalized === "1m") {
    return "1M";
  }
  if (normalized === "200k") {
    return "200k";
  }
  return normalized.replace(/m$/u, "M");
}

export function inferContextWindowSelectionValue(
  maxTokens: number | null | undefined,
): string | null {
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return null;
  }
  const bestMatch = Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).reduce<{
    value: string | null;
    relativeDistance: number;
  }>(
    (best, [value, knownMaxTokens]) => {
      const relativeDistance = Math.abs(maxTokens - knownMaxTokens) / knownMaxTokens;
      return relativeDistance < best.relativeDistance ? { value, relativeDistance } : best;
    },
    { value: null, relativeDistance: Number.POSITIVE_INFINITY },
  );
  return bestMatch.relativeDistance <= 0.2 ? bestMatch.value : null;
}

export function deriveContextWindowSelectionStatus(input: {
  activeSnapshot: ContextWindowSnapshot | null;
  appliedValue?: string | null;
  selectedValue: string | null | undefined;
}): ContextWindowSelectionStatus {
  const activeValue =
    input.appliedValue === undefined
      ? inferContextWindowSelectionValue(input.activeSnapshot?.maxTokens ?? null)
      : input.appliedValue;
  const selectedValue = input.selectedValue?.trim().toLowerCase() ?? null;
  const activeLabel =
    formatContextWindowSelectionLabel(activeValue) ??
    (input.appliedValue === undefined && input.activeSnapshot?.maxTokens != null
      ? formatContextWindowTokens(input.activeSnapshot.maxTokens)
      : null);
  const selectedLabel = formatContextWindowSelectionLabel(selectedValue);
  const pendingSelectedLabel =
    selectedLabel !== null && activeValue !== null && selectedValue !== activeValue
      ? selectedLabel
      : null;

  return {
    activeLabel,
    selectedLabel,
    pendingSelectedLabel,
  };
}

// Budget is runtime evidence; the configured mode remains a separate target.
export function deriveComposerContextWindowLabel(input: {
  provider: ProviderKind;
  model: string;
  snapshot: ContextWindowSnapshot | null;
  status: ContextWindowSelectionStatus;
  /** Stable budget from `deriveObservedClaudeContextBudget`; preferred over the snapshot's. */
  observedBudget?: ObservedClaudeContextBudget | null;
}): string | null {
  if (input.provider !== "claudeAgent") return null;
  const observedModel =
    input.observedBudget === undefined
      ? input.snapshot?.claudeCache?.model
      : input.observedBudget?.model;
  const observedMaxTokens =
    input.observedBudget === undefined
      ? input.snapshot?.maxTokens
      : input.observedBudget?.maxTokens;
  const sameModel =
    observedModel !== undefined &&
    stripClaudeContextWindowSuffix(normalizeModelSlug(observedModel, "claudeAgent") ?? "") ===
      stripClaudeContextWindowSuffix(normalizeModelSlug(input.model, "claudeAgent") ?? "");
  const budget = sameModel
    ? formatContextWindowSelectionLabel(inferContextWindowSelectionValue(observedMaxTokens))
    : null;
  const { selectedLabel, activeLabel, pendingSelectedLabel } = input.status;
  const pending = pendingSelectedLabel ?? (!sameModel ? selectedLabel : null);
  if (budget) return pending ? `(${budget} · ${pending} next)` : `(${budget})`;
  if (selectedLabel === null || (selectedLabel === "Auto" && !pendingSelectedLabel)) return null;
  return `(${selectedLabel} ${pending || activeLabel === null ? "next" : "target"})`;
}

export function formatCostUsd(value: number): string {
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
