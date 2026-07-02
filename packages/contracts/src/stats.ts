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
  model: TrimmedNonEmptyString,
  turnCount: NonNegativeInt,
  percent: Schema.Number,
});
export type ProfileProviderUsage = typeof ProfileProviderUsage.Type;

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
  heatmapMetric: Schema.Literal("tokens"),
  heatmap: Schema.Array(ProfileHeatmapCell),
});
export type ProfileTokenStats = typeof ProfileTokenStats.Type;

export const StatsGetProfileTokenStatsResult = ProfileTokenStats;
export type StatsGetProfileTokenStatsResult = typeof StatsGetProfileTokenStatsResult.Type;
