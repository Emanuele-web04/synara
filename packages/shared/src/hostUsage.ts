// Shared product host-usage file names and closed-boundary normalization.
// Runtime scheduling, consent persistence and uploads stay with server/desktop owners.
import {
  HOST_USAGE_MAX_COUNTER,
  HOST_USAGE_MAX_ROWS,
  HOST_USAGE_MAX_TURNS,
  HOST_USAGE_RECEIPT_DAYS,
  type HostUsageRow,
  type HostUsageWindow,
} from "@synara/contracts/hostUsage";
import { usageTurnCategories } from "./usageAnalytics";

export const HOST_USAGE_POLICY_FILE = "host-usage-policy.json";
export const HOST_USAGE_DIRECTORY = "host-usage";
export const HOST_USAGE_RECEIPTS_FILE = "host-usage-receipts.json";
export const HOST_USAGE_DAY_MS = 86_400_000;
export const HOST_USAGE_SETTLE_MS = 10 * 60 * 1000;
export const HOST_USAGE_COUNT_FIELDS = [
  "turns",
  "durationMs",
  "durationSamples",
  "inputTokens",
  "inputSamples",
  "outputTokens",
  "outputSamples",
  "cachedInputTokens",
  "cachedInputSamples",
] as const;
const QUALITY_FIELDS = [
  "eligibleTurns",
  "includedTurns",
  "missingCompletionTimes",
  "tokenTruncatedTurns",
  "cappedMeasurements",
] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= HOST_USAGE_MAX_COUNTER;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Reconstruct at every file/network boundary; unknown dimensions become finite other. */
export function normalizeHostUsageWindow(raw: unknown, now = Date.now()): HostUsageWindow | null {
  if (
    !isRecord(raw) ||
    raw.v !== 1 ||
    typeof raw.windowId !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.windowId)
  )
    return null;
  if (raw.channel !== "stable" && raw.channel !== "beta" && raw.channel !== "remote") return null;
  if (
    !timestamp(raw.windowStart) ||
    !timestamp(raw.windowEnd) ||
    !timestamp(raw.coveredFrom) ||
    !timestamp(raw.generatedAt)
  )
    return null;
  const start = Date.parse(raw.windowStart);
  const end = Date.parse(raw.windowEnd);
  if (
    start % HOST_USAGE_DAY_MS !== 0 ||
    end !== start + HOST_USAGE_DAY_MS ||
    end > now ||
    end < now - HOST_USAGE_RECEIPT_DAYS * HOST_USAGE_DAY_MS ||
    Date.parse(raw.coveredFrom) < start ||
    Date.parse(raw.coveredFrom) >= end ||
    Date.parse(raw.generatedAt) < end ||
    Date.parse(raw.generatedAt) > now + 300_000
  )
    return null;
  if (
    !QUALITY_FIELDS.every((key) => isCount(raw[key])) ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > HOST_USAGE_MAX_ROWS
  )
    return null;
  type MutableRow = { -readonly [Key in keyof HostUsageRow]: HostUsageRow[Key] };
  const groups = new Map<string, { row: MutableRow; limited: Set<string> }>();
  let cappedMeasurements = raw.cappedMeasurements as number;
  for (const entry of raw.rows) {
    if (!isRecord(entry) || !HOST_USAGE_COUNT_FIELDS.every((key) => isCount(entry[key])))
      return null;
    if (
      entry.outcome !== "succeeded" &&
      entry.outcome !== "failed" &&
      entry.outcome !== "cancelled"
    )
      return null;
    const row = {
      ...usageTurnCategories(entry),
      outcome: entry.outcome,
      ...Object.fromEntries(HOST_USAGE_COUNT_FIELDS.map((key) => [key, entry[key]])),
    } as MutableRow;
    if (row.turns === 0 || row.turns > HOST_USAGE_MAX_TURNS) return null;
    for (const [sum, samples] of [
      [row.durationMs, row.durationSamples],
      [row.inputTokens, row.inputSamples],
      [row.outputTokens, row.outputSamples],
      [row.cachedInputTokens, row.cachedInputSamples],
    ] as const) {
      if (samples > row.turns || (samples === 0 && sum !== 0)) return null;
    }
    const key = [
      row.provider,
      row.model,
      row.effort,
      row.interactionMode,
      row.runtimeMode,
      row.origin,
      row.outcome,
    ].join("|");
    // Independently deployed catalogs can collapse several newer models into other.
    const existing = groups.get(key);
    if (!existing) groups.set(key, { row, limited: new Set() });
    else {
      existing.row.turns += row.turns;
      for (const [field, samples] of [
        ["durationMs", "durationSamples"],
        ["inputTokens", "inputSamples"],
        ["outputTokens", "outputSamples"],
        ["cachedInputTokens", "cachedInputSamples"],
      ] as const) {
        if (existing.limited.has(field)) continue;
        const total = existing.row[field] + row[field];
        if (total > HOST_USAGE_MAX_COUNTER) {
          existing.row[field] = 0;
          existing.row[samples] = 0;
          existing.limited.add(field);
          cappedMeasurements += 1;
        } else {
          existing.row[field] = total;
          existing.row[samples] += row[samples];
        }
      }
    }
  }
  const rows = [...groups.values()].map(({ row }) => row);
  if (!isCount(cappedMeasurements)) return null;
  const includedTurns = rows.reduce((total, row) => total + row.turns, 0);
  if (
    includedTurns !== raw.includedTurns ||
    includedTurns > HOST_USAGE_MAX_TURNS ||
    (raw.eligibleTurns as number) < includedTurns ||
    (raw.tokenTruncatedTurns as number) > includedTurns
  )
    return null;
  return {
    v: 1,
    windowId: raw.windowId,
    channel: raw.channel,
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    coveredFrom: raw.coveredFrom,
    generatedAt: raw.generatedAt,
    eligibleTurns: raw.eligibleTurns as number,
    includedTurns,
    missingCompletionTimes: raw.missingCompletionTimes as number,
    tokenTruncatedTurns: raw.tokenTruncatedTurns as number,
    cappedMeasurements,
    rows,
  };
}
