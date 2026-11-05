// FILE: formatting.ts
// Purpose: Pure display formatters shared by the Profile page, the shareable card,
// and the public profile page (no I/O, safe to use during html-to-image render).
// Layer: profile-ui shared utilities.

import type { ProviderGlyphKey as ProviderKind } from "./providerIcon";

// Compact token/count formatting matching the reference card ("17bn", "538m", "1.2k").
export function formatCompact(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${trimZero(value / 1_000_000_000, locale)}bn`;
  }
  if (abs >= 1_000_000) {
    return `${trimZero(value / 1_000_000, locale)}m`;
  }
  if (abs >= 1_000) {
    return `${trimZero(value / 1_000, locale)}k`;
  }
  return `${Math.round(value)}`;
}

function trimZero(value: number, locale: string | undefined): string {
  const rounded = Math.round(value * 10) / 10;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, useGrouping: false }).format(
    rounded,
  );
}

// Thousands-separated integer ("4,934").
export function formatNumber(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatDays(value: number, locale?: string): string {
  return `${formatNumber(value, locale)} ${value === 1 ? "day" : "days"}`;
}

// Title-case a home-directory basename into a friendly display name.
export function toDisplayName(basename: string): string {
  const cleaned = basename
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "Synara";
  }
  return cleaned
    .split(" ")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function normalizeHandle(value: string): string {
  const slug = value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 30);
  return `@${slug || "synara"}`;
}

// Pretty short date for "peak day" tooltips ("Apr 3").
export function formatShortDate(day: string | null, locale?: string): string | null {
  if (!day) {
    return null;
  }
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

// 13 → "1 PM" — the hour label used by "Most active hour" on the profile panel,
// the shareable card, and the public profile page.
export function formatHourLabel(hour: number, locale?: string): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (locale) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 0, 1, normalized)),
    );
  }
  if (normalized === 0) return "12 AM";
  if (normalized === 12) return "12 PM";
  return normalized < 12 ? `${normalized} AM` : `${normalized - 12} PM`;
}

export function formatProviderLabel(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "devin":
      return "Devin";
    case "antigravity":
      return "Antigravity";
    case "grok":
      return "Grok";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "omp":
      return "Oh My Pi";
  }
}

export function formatProfileUsageBasis(metric: "tokens" | "turns"): string {
  return metric === "tokens" ? "tracked tokens" : "turns";
}

/**
 * Up-to-two initials from a display name — "Dylan" → "DY", "Ada Lovelace" →
 * "AL". The canonical algorithm (mirrored from the server's profile-stats
 * identity derivation) so every avatar surface renders the same glyphs.
 */
export function deriveInitials(name: string): string {
  const parts = name.split(/[\s._-]+/u).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase() || "SY";
  }
  const single = parts[0] ?? name;
  return (single.slice(0, 2) || "SY").toUpperCase();
}
