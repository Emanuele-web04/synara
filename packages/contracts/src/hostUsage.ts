// Product-consent host execution aggregates. Window receipts identify one UTC day;
// these payloads contain no account, installation, thread or project identifiers.
import * as Schema from "effect/Schema";

export const HOST_USAGE_MAX_ROWS = 100;
export const HOST_USAGE_MAX_TURNS = 5_000;
export const HOST_USAGE_RECEIPT_DAYS = 14;
export const HOST_USAGE_RETENTION_DAYS = 90;
export const HOST_USAGE_MAX_COUNTER = 1_000_000_000_000;
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: HOST_USAGE_MAX_COUNTER }));
export const HostUsageRow = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  interactionMode: Schema.String,
  runtimeMode: Schema.String,
  origin: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
  turns: Count,
  durationMs: Count,
  durationSamples: Count,
  inputTokens: Count,
  inputSamples: Count,
  outputTokens: Count,
  outputSamples: Count,
  cachedInputTokens: Count,
  cachedInputSamples: Count,
});
export type HostUsageRow = typeof HostUsageRow.Type;
export const HostUsageWindow = Schema.Struct({
  v: Schema.Literal(1),
  windowId: Schema.String,
  channel: Schema.Literals(["stable", "beta", "remote"]),
  windowStart: Schema.String,
  windowEnd: Schema.String,
  coveredFrom: Schema.String,
  generatedAt: Schema.String,
  eligibleTurns: Count,
  includedTurns: Count,
  missingCompletionTimes: Count,
  tokenTruncatedTurns: Count,
  cappedMeasurements: Count,
  rows: Schema.Array(HostUsageRow),
});
export type HostUsageWindow = typeof HostUsageWindow.Type;
export type HostUsageSnapshot = Omit<HostUsageWindow, "windowId" | "channel"> & {
  readonly policyId: string;
};
