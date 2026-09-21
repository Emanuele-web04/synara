import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

// the client's fixed UTC offset so the server buckets activity by local day/hour, not UTC
export const StatsGetProfileStatsInput = Schema.Struct({
  utcOffsetMinutes: Schema.Int,
});
export type StatsGetProfileStatsInput = typeof StatsGetProfileStatsInput.Type;

export const StatsGetProfileTokenStatsInput = StatsGetProfileStatsInput;
export type StatsGetProfileTokenStatsInput = typeof StatsGetProfileTokenStatsInput.Type;

// pre-bucketed 0-4 so the client never knows the count distribution
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

// attributed to the model selected for the turn — mid-thread switches keep each model's share accurate
export const ProfileTokenModelUsage = Schema.Struct({
  provider: Schema.Union([ProviderKind, Schema.Literal("unknown")]),
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
  // counts native user prompts per local day — days the user actually used Synara
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
  // clients prefer the token-based ranking when available
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

// false when the DB hasn't recorded token totals yet
export const ProfileTokenStats = Schema.Struct({
  available: Schema.Boolean,
  lifetimeTotalTokens: Schema.NullOr(NonNegativeInt),
  peakDayTokens: Schema.NullOr(NonNegativeInt),
  peakDay: Schema.NullOr(TrimmedNonEmptyString),
  providers: Schema.Array(ProviderKind),
  // their adapters never emit context-window updates — excluded from token rankings
  unavailableProviders: Schema.Array(ProviderKind),
  // among providers with token telemetry
  topProvider: Schema.NullOr(ProviderKind),
  topProviderPercent: Schema.NullOr(Schema.Number),
  // preferred over the turn-based providerModels when telemetry is available
  models: Schema.Array(ProfileTokenModelUsage),
  heatmapMetric: Schema.Literal("tokens"),
  heatmap: Schema.Array(ProfileHeatmapCell),
});
export type ProfileTokenStats = typeof ProfileTokenStats.Type;

export const StatsGetProfileTokenStatsResult = ProfileTokenStats;
export type StatsGetProfileTokenStatsResult = typeof StatsGetProfileTokenStatsResult.Type;
