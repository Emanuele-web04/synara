// FILE: openUsageSnapshots.ts
// Purpose: Normalize CrossUsage/OpenUsage local HTTP snapshots for sidebar usage UI.

import type { ProviderKind } from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

export type OpenUsageProgressFormat =
  | { kind: "percent" }
  | { kind: "dollars" }
  | { kind: "count"; suffix: string };

export interface OpenUsageProgressLine {
  type: "progress";
  label: string;
  used: number;
  limit: number;
  format: OpenUsageProgressFormat;
  resetsAt?: string;
  periodDurationMs?: number;
  color?: string;
}

export interface OpenUsageTextLine {
  type: "text";
  label: string;
  value: string;
  subtitle?: string;
  color?: string;
}

export type OpenUsageMetricLine = OpenUsageProgressLine | OpenUsageTextLine;

export interface OpenUsageProviderSnapshot {
  providerId: string;
  displayName: string;
  plan?: string;
  lines: OpenUsageMetricLine[];
  fetchedAt: string;
  providerKind: ProviderKind | null;
}

const OPEN_USAGE_PROVIDER_KIND_BY_ID: Record<string, ProviderKind> = {
  codex: "codex",
  claude: "claudeAgent",
  cursor: "cursor",
  gemini: "gemini",
  grok: "grok",
  "opencode-go": "opencode",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeProgressFormat(value: unknown): OpenUsageProgressFormat {
  const parsed = asRecord(value);
  const kind = asString(parsed?.kind);
  if (kind === "dollars") return { kind: "dollars" };
  if (kind === "count") {
    const suffix = asString(parsed?.suffix) ?? "units";
    return { kind: "count", suffix };
  }
  return { kind: "percent" };
}

function normalizeProgressLine(value: unknown): OpenUsageProgressLine | null {
  const parsed = asRecord(value);
  if (!parsed || parsed.type !== "progress") return null;

  const label = asString(parsed.label);
  const used = asFiniteNumber(parsed.used);
  const limit = asFiniteNumber(parsed.limit);
  if (!label || used === undefined || limit === undefined || limit <= 0) return null;

  return {
    type: "progress",
    label,
    used,
    limit,
    format: normalizeProgressFormat(parsed.format),
    ...(asString(parsed.resetsAt) ? { resetsAt: asString(parsed.resetsAt) } : {}),
    ...(asFiniteNumber(parsed.periodDurationMs) !== undefined
      ? { periodDurationMs: asFiniteNumber(parsed.periodDurationMs) }
      : {}),
    ...(asString(parsed.color) ? { color: asString(parsed.color) } : {}),
  };
}

function normalizeTextLine(value: unknown): OpenUsageTextLine | null {
  const parsed = asRecord(value);
  if (!parsed || parsed.type !== "text") return null;

  const label = asString(parsed.label);
  const valueText = asString(parsed.value);
  if (!label || !valueText) return null;

  return {
    type: "text",
    label,
    value: valueText,
    ...(asString(parsed.subtitle) ? { subtitle: asString(parsed.subtitle) } : {}),
    ...(asString(parsed.color) ? { color: asString(parsed.color) } : {}),
  };
}

function normalizeMetricLine(value: unknown): OpenUsageMetricLine | null {
  const parsed = asRecord(value);
  if (!parsed) return null;
  if (parsed.type === "progress") return normalizeProgressLine(parsed);
  if (parsed.type === "text") return normalizeTextLine(parsed);
  return null;
}

export function openUsageProviderKindFromId(providerId: string): ProviderKind | null {
  return OPEN_USAGE_PROVIDER_KIND_BY_ID[providerId] ?? null;
}

export function openUsageProviderDisplayName(snapshot: OpenUsageProviderSnapshot): string {
  return snapshot.displayName.trim().length > 0
    ? snapshot.displayName
    : snapshot.providerKind
      ? PROVIDER_DISPLAY_NAMES[snapshot.providerKind]
      : snapshot.providerId;
}

export function normalizeOpenUsageProviderSnapshot(value: unknown): OpenUsageProviderSnapshot | null {
  const parsed = asRecord(value);
  if (!parsed) return null;

  const providerId = asString(parsed.providerId);
  if (!providerId) return null;

  const lines = Array.isArray(parsed.lines)
    ? parsed.lines
        .map((line) => normalizeMetricLine(line))
        .filter((line): line is OpenUsageMetricLine => line !== null)
    : [];

  const providerKind = openUsageProviderKindFromId(providerId);
  const displayName =
    asString(parsed.displayName) ??
    (providerKind ? PROVIDER_DISPLAY_NAMES[providerKind] : providerId);

  return {
    providerId,
    displayName,
    ...(asString(parsed.plan) ? { plan: asString(parsed.plan) } : {}),
    lines,
    fetchedAt: asString(parsed.fetchedAt) ?? new Date().toISOString(),
    providerKind,
  };
}

export function normalizeOpenUsageProviderSnapshots(value: unknown): OpenUsageProviderSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeOpenUsageProviderSnapshot(entry))
    .filter((entry): entry is OpenUsageProviderSnapshot => entry !== null);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function openUsageProgressPercent(line: OpenUsageProgressLine): number {
  return Math.round(clamp01(line.used / line.limit) * 100);
}

export function openUsageProgressRemainingPercent(line: OpenUsageProgressLine): number {
  return Math.max(0, 100 - openUsageProgressPercent(line));
}

export function formatOpenUsageProgressSummary(line: OpenUsageProgressLine): string {
  const remainingPercent = openUsageProgressRemainingPercent(line);
  if (line.format.kind === "percent") {
    return `${remainingPercent}% left`;
  }
  if (line.format.kind === "dollars") {
    const remaining = Math.max(0, line.limit - line.used);
    return `$${remaining.toFixed(2)} left`;
  }
  const remaining = Math.max(0, line.limit - line.used);
  return `${Math.round(remaining)} ${line.format.suffix} left`;
}

export function openUsageSidebarProgressLines(
  snapshot: OpenUsageProviderSnapshot,
): OpenUsageProgressLine[] {
  return snapshot.lines.filter((line): line is OpenUsageProgressLine => line.type === "progress");
}
