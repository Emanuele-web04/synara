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

// Model speed of one settled turn, stamped by the server on the turn's
// `turn.completed` activity payload as `modelSpeed`. Output tokens are the
// model's own output for the turn (reasoning included, subagents excluded);
// generationMs is the turn's wall time minus tool execution and pending
// approvals/user input. Absent when the numbers would be misleading. The
// model is the one the provider reported for the turn (the turn's selection
// otherwise); fastMode and effort come from the turn's model selection.
export const TurnModelSpeed = Schema.Struct({
  outputTokens: NonNegativeInt,
  generationMs: NonNegativeInt,
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type TurnModelSpeed = typeof TurnModelSpeed.Type;

// Measured turns summed over a period. The rate is token-weighted (sum of
// output tokens over the sum of generation time, not a mean of per-turn
// rates) and null when the period has no data or fails the plausibility limits.
export const ProfileModelSpeedBucket = Schema.Struct({
  outputTokens: NonNegativeInt,
  generationMs: NonNegativeInt,
  turnCount: NonNegativeInt,
  tokensPerSecond: Schema.NullOr(Schema.Finite),
});
export type ProfileModelSpeedBucket = typeof ProfileModelSpeedBucket.Type;

export const ProfileModelSpeedWeek = Schema.Struct({
  ...ProfileModelSpeedBucket.fields,
  // Local Monday the ISO week starts on (YYYY-MM-DD).
  weekStart: TrimmedNonEmptyString,
});
export type ProfileModelSpeedWeek = typeof ProfileModelSpeedWeek.Type;

export const PROFILE_MODEL_SPEED_WEEKS = 12;

// Model speed per provider/model, with fast mode as its own row; effort does
// not split rows. Days are the caller's local days.
export const ProfileModelSpeed = Schema.Struct({
  provider: Schema.Union([ProviderKind, Schema.Literal("unknown")]),
  instanceId: Schema.Union([ProviderInstanceId, Schema.Literal("unknown")]),
  model: TrimmedNonEmptyString,
  fastMode: Schema.Boolean,
  lifetime: ProfileModelSpeedBucket,
  // Today and the 6 days before it, and the 7 days before those.
  last7Days: ProfileModelSpeedBucket,
  previous7Days: ProfileModelSpeedBucket,
  // last7Days rate relative to previous7Days, in percent; null when either
  // side has no rate.
  changePercent: Schema.NullOr(Schema.Finite),
  // The last PROFILE_MODEL_SPEED_WEEKS ISO weeks, oldest first, current week
  // last; weeks without measured turns have zero counts and a null rate.
  weeks: Schema.Array(ProfileModelSpeedWeek),
});
export type ProfileModelSpeed = typeof ProfileModelSpeed.Type;

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
  // Model speed per model, most used in the last 7 days first; models whose
  // lifetime rate is unavailable are omitted.
  modelSpeeds: Schema.Array(ProfileModelSpeed),
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
