// FILE: stats.ts
// Purpose: Schemas for the local profile-stats RPCs that power the Profile page and
// the shareable activity card. All metrics are backed by Synara's local DB
// projections; no provider archive or cloud data is part of this contract.
// Metrics are lifetime totals: deleting a thread or project from the app never
// subtracts the work it already contributed to the profile.
// Layer: shared contracts (schema-only, no runtime logic)

import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { ProviderInstanceId } from "./providerInstance";

// ── Input ────────────────────────────────────────────────────────────

// The client passes its own fixed UTC offset (minutes east of UTC, i.e.
// `-new Date().getTimezoneOffset()`) so the server can bucket activity by the
// user's LOCAL day/hour rather than UTC.
export const StatsGetProfileStatsInput = Schema.Struct({
  utcOffsetMinutes: Schema.Int,
});
export type StatsGetProfileStatsInput = typeof StatsGetProfileStatsInput.Type;

export const StatsGetProfileTokenStatsInput = StatsGetProfileStatsInput;
export type StatsGetProfileTokenStatsInput = typeof StatsGetProfileTokenStatsInput.Type;

// ── Building blocks ──────────────────────────────────────────────────

// One day in the GitHub-style heatmap. `intensity` is a pre-bucketed 0–4 level so
// the client never has to know the count distribution. `weekday` is 0 (Sun)–6 (Sat).
export const ProfileHeatmapCell = Schema.Struct({
  day: TrimmedNonEmptyString,
  count: NonNegativeInt,
  weekday: Schema.Int,
  intensity: NonNegativeInt,
});
export type ProfileHeatmapCell = typeof ProfileHeatmapCell.Type;

export const ProfileProviderUsage = Schema.Struct({
  provider: Schema.Union([ProviderKind, Schema.Literal("unknown")]),
  instanceId: Schema.Union([ProviderInstanceId, Schema.Literal("unknown")]),
  model: TrimmedNonEmptyString,
  turnCount: NonNegativeInt,
  percent: Schema.Number,
});
export type ProfileProviderUsage = typeof ProfileProviderUsage.Type;

// Token-based model mix. Tokens are attributed to the model selected for the
// turn that processed them (thread selection is only a legacy-data fallback),
// so switching models mid-thread keeps each model's share accurate.
export const ProfileTokenModelUsage = Schema.Struct({
  provider: Schema.Union([ProviderKind, Schema.Literal("unknown")]),
  instanceId: Schema.Union([ProviderInstanceId, Schema.Literal("unknown")]),
  model: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  percent: Schema.Number,
});
export type ProfileTokenModelUsage = typeof ProfileTokenModelUsage.Type;

export const ProfileSkillUsage = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  kind: Schema.Literals(["skill", "agent"]),
  runCount: NonNegativeInt,
});
export type ProfileSkillUsage = typeof ProfileSkillUsage.Type;

export const ProfileMostWorkedProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  promptCount: NonNegativeInt,
  threadCount: NonNegativeInt,
  activeDays: NonNegativeInt,
  lastWorkedAt: IsoDateTime,
});
export type ProfileMostWorkedProject = typeof ProfileMostWorkedProject.Type;

export const ProfileQuota = Schema.Struct({
  status: Schema.Literals(["available", "unavailable"]),
  provider: Schema.NullOr(ProviderKind),
  window: Schema.NullOr(Schema.String),
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  planName: Schema.NullOr(Schema.String),
});
export type ProfileQuota = typeof ProfileQuota.Type;

export const ProfileActivity = Schema.Struct({
  currentStreakDays: NonNegativeInt,
  longestStreakDays: NonNegativeInt,
  totalPromptsSent: NonNegativeInt,
  totalThreads: NonNegativeInt,
  promptsToday: NonNegativeInt,
  // Activity heatmap counts native user prompts per local day (same source as
  // totalPromptsSent), i.e. days the user actually used Synara.
  heatmapMetric: Schema.Literal("prompts"),
  heatmap: Schema.Array(ProfileHeatmapCell),
});
export type ProfileActivity = typeof ProfileActivity.Type;

export const ProfileActiveHours = Schema.Struct({
  startHour: Schema.NullOr(Schema.Int),
  endHour: Schema.NullOr(Schema.Int),
  turnCount: NonNegativeInt,
  label: Schema.NullOr(Schema.String),
});
export type ProfileActiveHours = typeof ProfileActiveHours.Type;

export const ProfileInsights = Schema.Struct({
  // Ranked by turn count. Token-based ranking lives on ProfileTokenStats; clients
  // prefer it when available (see selectProfileTopProvider on the web).
  topProvider: Schema.NullOr(ProviderKind),
  topProviderPercent: Schema.NullOr(Schema.Number),
  topReasoning: Schema.NullOr(Schema.String),
  topReasoningPercent: Schema.NullOr(Schema.Number),
  skillsExplored: NonNegativeInt,
  totalSkillsUsed: NonNegativeInt,
});
export type ProfileInsights = typeof ProfileInsights.Type;

export const ProfileIdentity = Schema.Struct({
  homeDirBasename: Schema.String,
  initials: Schema.String,
  defaultHandle: Schema.String,
});
export type ProfileIdentity = typeof ProfileIdentity.Type;

export const ProfileTimezone = Schema.Struct({
  utcOffsetMinutes: Schema.Int,
  today: TrimmedNonEmptyString,
});
export type ProfileTimezone = typeof ProfileTimezone.Type;

// ── Aggregate result ─────────────────────────────────────────────────

export const ProfileStats = Schema.Struct({
  generatedAt: IsoDateTime,
  timezone: ProfileTimezone,
  identity: ProfileIdentity,
  activity: ProfileActivity,
  activeHours: ProfileActiveHours,
  insights: ProfileInsights,
  providerModels: Schema.Array(ProfileProviderUsage),
  skills: Schema.Array(ProfileSkillUsage),
  mostUsedSkill: Schema.NullOr(ProfileSkillUsage),
  mostWorkedProject: Schema.NullOr(ProfileMostWorkedProject),
  quota: ProfileQuota,
});
export type ProfileStats = typeof ProfileStats.Type;

export const StatsGetProfileStatsResult = ProfileStats;
export type StatsGetProfileStatsResult = typeof StatsGetProfileStatsResult.Type;

// Token totals come from Synara's projected context-window updates. `available`
// is false when the DB has not recorded token totals yet.
export const ProfileTokenStats = Schema.Struct({
  available: Schema.Boolean,
  lifetimeTotalTokens: Schema.NullOr(NonNegativeInt),
  peakDayTokens: Schema.NullOr(NonNegativeInt),
  peakDay: Schema.NullOr(TrimmedNonEmptyString),
  providers: Schema.Array(ProviderKind),
  // Providers with recorded turns but no token telemetry (their adapters never
  // emit context-window updates); excluded from token-based rankings.
  unavailableProviders: Schema.Array(ProviderKind),
  // Most-used provider by tokens processed, among providers with token telemetry.
  topProvider: Schema.NullOr(ProviderKind),
  topProviderPercent: Schema.NullOr(Schema.Number),
  // Per-model token shares; clients prefer this over the turn-based
  // ProfileStats.providerModels when token telemetry is available.
  models: Schema.Array(ProfileTokenModelUsage),
  heatmapMetric: Schema.Literal("tokens"),
  heatmap: Schema.Array(ProfileHeatmapCell),
});
export type ProfileTokenStats = typeof ProfileTokenStats.Type;

export const StatsGetProfileTokenStatsResult = ProfileTokenStats;
export type StatsGetProfileTokenStatsResult = typeof StatsGetProfileTokenStatsResult.Type;

// ── Recap (Inbox) ────────────────────────────────────────────────────

// A recap of one time window, split into slots (the Inbox asks for a working
// day by hour and groups the hours into morning, afternoon, and evening). The
// client computes the window and slot boundaries in its own local time, so the
// server only compares absolute instants and never has to guess a timezone or
// daylight-saving rule. 24 boundaries cover a 25-hour day at a DST change.
export const STATS_RECAP_MAX_SLOT_BOUNDARIES = 24;
export const STATS_RECAP_MAX_WINDOW_MS = 48 * 60 * 60 * 1000;

export const StatsGetRecapInput = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  // Ascending instants strictly inside (from, to) that split the window into slots.
  slotBoundaries: Schema.Array(IsoDateTime).check(
    Schema.isMaxLength(STATS_RECAP_MAX_SLOT_BOUNDARIES),
  ),
});
export type StatsGetRecapInput = typeof StatsGetRecapInput.Type;

// Tokens processed (cache reads and writes included), split by who dispatched
// the turn. Profile stats count only `user`; the recap shows all work done.
export const StatsRecapTokens = Schema.Struct({
  user: NonNegativeInt,
  automation: NonNegativeInt,
  agent: NonNegativeInt,
});
export type StatsRecapTokens = typeof StatsRecapTokens.Type;

export const StatsRecapSlot = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  // Native prompts the user sent, and the chats they were sent in.
  prompts: NonNegativeInt,
  chats: NonNegativeInt,
  // Turns requested in the slot, of any origin, and how many ended in error.
  turns: NonNegativeInt,
  failedTurns: NonNegativeInt,
  // Agent run time inside the slot, summed across chats that ran in parallel.
  agentWorkMs: NonNegativeInt,
  tokens: StatsRecapTokens,
  // The part of `tokens` read from the prompt cache, for providers that report
  // it. Absent from servers that predate the split.
  cacheReadTokens: Schema.optional(NonNegativeInt),
});
export type StatsRecapSlot = typeof StatsRecapSlot.Type;

// Real projects only: per-chat and Studio container projects never rank.
export const StatsRecapProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  prompts: NonNegativeInt,
  chats: NonNegativeInt,
  tokens: NonNegativeInt,
});
export type StatsRecapProject = typeof StatsRecapProject.Type;

export const StatsRecapModel = Schema.Struct({
  provider: Schema.Union([ProviderKind, Schema.Literal("unknown")]),
  model: TrimmedNonEmptyString,
  turns: NonNegativeInt,
  tokens: NonNegativeInt,
});
export type StatsRecapModel = typeof StatsRecapModel.Type;

export const StatsGetRecapResult = Schema.Struct({
  generatedAt: IsoDateTime,
  totals: StatsRecapSlot,
  slots: Schema.Array(StatsRecapSlot),
  // Top five each, most active first.
  projects: Schema.Array(StatsRecapProject),
  models: Schema.Array(StatsRecapModel),
  // Providers with turns in the window whose adapters report no token usage.
  unavailableProviders: Schema.Array(ProviderKind),
});
export type StatsGetRecapResult = typeof StatsGetRecapResult.Type;

// ── Usage analytics (Settings → Usage → Analytics) ───────────────────

// Up to a year of usage as UTC-hour rows. The client buckets them into its own
// local days and hours, so the server never has to guess a timezone or DST rule.
// A year plus a week of slack lets the client ask for whole local days.
export const STATS_USAGE_ANALYTICS_MAX_WINDOW_MS = 373 * 24 * 60 * 60 * 1000;

// `synara`: chats run in Synara. `mac`: also Claude Code and Codex sessions run
// anywhere on this Mac, read from their own session files.
export const StatsUsageAnalyticsScope = Schema.Literals(["synara", "mac"]);
export type StatsUsageAnalyticsScope = typeof StatsUsageAnalyticsScope.Type;

export const StatsGetUsageAnalyticsInput = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  scope: Schema.optional(StatsUsageAnalyticsScope),
});
export type StatsGetUsageAnalyticsInput = typeof StatsGetUsageAnalyticsInput.Type;

const StatsUsageAnalyticsProvider = Schema.Union([ProviderKind, Schema.Literal("unknown")]);

// Who dispatched the turn that processed the tokens.
export const StatsUsageAnalyticsOrigin = Schema.Literals(["user", "automation", "agent"]);
export type StatsUsageAnalyticsOrigin = typeof StatsUsageAnalyticsOrigin.Type;

// Tokens processed in one UTC hour (cache reads and writes included); `origin` is
// null for sessions read from session files, whose dispatcher is unknown;
// `cacheReadTokens` is the part read from the prompt cache, when the provider reports it.
// For a provider that reports no cost, the tokens left without an estimate:
// `unpricedTokens` because the model has no API list price, `unsplitTokens` because
// the input/output split a price needs was not recorded (deleted or older chats).
export const StatsUsageAnalyticsTokenRow = Schema.Struct({
  hour: IsoDateTime,
  provider: StatsUsageAnalyticsProvider,
  model: TrimmedNonEmptyString,
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  origin: Schema.NullOr(StatsUsageAnalyticsOrigin),
  tokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  unpricedTokens: NonNegativeInt,
  unsplitTokens: NonNegativeInt,
});
export type StatsUsageAnalyticsTokenRow = typeof StatsUsageAnalyticsTokenRow.Type;

// Turns requested in one UTC hour, and how many ended in error.
export const StatsUsageAnalyticsTurnRow = Schema.Struct({
  hour: IsoDateTime,
  provider: StatsUsageAnalyticsProvider,
  model: TrimmedNonEmptyString,
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  turns: NonNegativeInt,
  failedTurns: NonNegativeInt,
});
export type StatsUsageAnalyticsTurnRow = typeof StatsUsageAnalyticsTurnRow.Type;

// Cost of Synara usage in one UTC hour, in USD, at API rates (not what a
// subscription bills). `reported`: the provider's own figure for completed turns
// (Claude's SDK, Cursor, OpenCode). `estimated`: for a provider that reports none
// (Codex), its input, cache and output tokens at API list prices.
export const StatsUsageAnalyticsCostSource = Schema.Literals(["reported", "estimated"]);
export type StatsUsageAnalyticsCostSource = typeof StatsUsageAnalyticsCostSource.Type;

export const StatsUsageAnalyticsCostRow = Schema.Struct({
  hour: IsoDateTime,
  provider: StatsUsageAnalyticsProvider,
  model: TrimmedNonEmptyString,
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  source: StatsUsageAnalyticsCostSource,
  costUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  // Turns with a reported cost; 0 for estimated rows.
  turns: NonNegativeInt,
});
export type StatsUsageAnalyticsCostRow = typeof StatsUsageAnalyticsCostRow.Type;

// Real projects only: per-chat and Studio container projects are left out.
export const StatsUsageAnalyticsProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type StatsUsageAnalyticsProject = typeof StatsUsageAnalyticsProject.Type;

export const StatsUsageAnalyticsPricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type StatsUsageAnalyticsPricingStatus = typeof StatsUsageAnalyticsPricingStatus.Type;

// The API price list used for estimated cost. `unavailable` also when no estimate
// was needed, since the list is then not loaded.
export const StatsUsageAnalyticsPricing = Schema.Struct({
  status: StatsUsageAnalyticsPricingStatus,
  fetchedAt: Schema.NullOr(IsoDateTime),
});
export type StatsUsageAnalyticsPricing = typeof StatsUsageAnalyticsPricing.Type;

export const StatsGetUsageAnalyticsResult = Schema.Struct({
  generatedAt: IsoDateTime,
  from: IsoDateTime,
  to: IsoDateTime,
  tokens: Schema.Array(StatsUsageAnalyticsTokenRow),
  turns: Schema.Array(StatsUsageAnalyticsTurnRow),
  costs: Schema.Array(StatsUsageAnalyticsCostRow),
  pricing: StatsUsageAnalyticsPricing,
  scope: StatsUsageAnalyticsScope,
  // In the `mac` scope, providers read from their own session files instead of
  // Synara's records.
  sessionFileProviders: Schema.Array(ProviderKind),
  projects: Schema.Array(StatsUsageAnalyticsProject),
  // Providers with turns in the window whose adapters report no token usage.
  unavailableProviders: Schema.Array(ProviderKind),
});
export type StatsGetUsageAnalyticsResult = typeof StatsGetUsageAnalyticsResult.Type;
