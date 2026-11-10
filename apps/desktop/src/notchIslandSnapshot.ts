// FILE: notchIslandSnapshot.ts
// Purpose: Validate the renderer's notch island snapshot, decide what the closed island
//          shows, and encode both as the `--island` helper's stdin lines.
// Layer: Desktop main process (pure; no Electron)
// Depends on: the snapshot contract in @synara/contracts.

import type {
  DesktopNotchIslandRow,
  DesktopNotchIslandRowState,
  DesktopNotchIslandSnapshot,
} from "@synara/contracts";

/** Rows the open island has room for. */
export const MAX_NOTCH_ISLAND_ROWS = 4;
const MAX_TITLE_LENGTH = 120;
const MAX_PROJECT_LENGTH = 60;
const MAX_THREAD_ID_LENGTH = 256;
const MAX_COUNT = 999;
const MAX_ICONS = 8;
const MAX_ICON_BYTES = 16_384;
const PROVIDER_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const ROW_STATES: ReadonlySet<DesktopNotchIslandRowState> = new Set([
  "approval",
  "input",
  "plan",
  "working",
  "done",
  "failed",
]);

export const EMPTY_NOTCH_ISLAND_SNAPSHOT: DesktopNotchIslandSnapshot = {
  needsYou: 0,
  working: 0,
  done: 0,
  failed: 0,
  rows: [],
  icons: {},
};

function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, MAX_COUNT);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function row(value: unknown): DesktopNotchIslandRow | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const threadId = candidate.threadId;
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    threadId.length > MAX_THREAD_ID_LENGTH
  ) {
    return null;
  }
  const title = text(candidate.title, MAX_TITLE_LENGTH);
  const state = candidate.state;
  if (!title || typeof state !== "string" || !ROW_STATES.has(state as DesktopNotchIslandRowState)) {
    return null;
  }
  const provider =
    typeof candidate.provider === "string" && PROVIDER_KEY.test(candidate.provider)
      ? candidate.provider
      : null;
  return {
    threadId,
    title,
    project: text(candidate.project, MAX_PROJECT_LENGTH),
    provider,
    state: state as DesktopNotchIslandRowState,
  };
}

/**
 * The renderer is trusted, but its payload still crosses a process boundary into a
 * native parser, so every field is type-checked and capped. Icons are kept only for
 * providers that appear in the rows, and only when they look like SVG markup.
 */
export function sanitizeNotchIslandSnapshot(value: unknown): DesktopNotchIslandSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const needsYou = count(candidate.needsYou);
  const working = count(candidate.working);
  const done = count(candidate.done);
  const failed = count(candidate.failed);
  if (needsYou === null || working === null || done === null || failed === null) return null;
  if (!Array.isArray(candidate.rows)) return null;

  const rows: DesktopNotchIslandRow[] = [];
  for (const raw of candidate.rows) {
    const parsed = row(raw);
    if (parsed) rows.push(parsed);
    if (rows.length === MAX_NOTCH_ISLAND_ROWS) break;
  }

  const icons: Record<string, string> = {};
  const rawIcons =
    candidate.icons && typeof candidate.icons === "object"
      ? (candidate.icons as Record<string, unknown>)
      : {};
  const providers = new Set(rows.flatMap((entry) => (entry.provider ? [entry.provider] : [])));
  for (const provider of providers) {
    const svg = rawIcons[provider];
    if (
      typeof svg === "string" &&
      svg.length <= MAX_ICON_BYTES &&
      svg.trimStart().startsWith("<svg") &&
      Object.keys(icons).length < MAX_ICONS
    ) {
      icons[provider] = svg;
    }
  }

  return { needsYou, working, done, failed, rows, icons };
}

export type NotchIslandLead = "needs-you" | "working" | "failed" | "finished" | "idle";

/** What the closed island shows: the most urgent state and its count. */
export function resolveNotchIslandLead(snapshot: DesktopNotchIslandSnapshot): {
  readonly lead: NotchIslandLead;
  readonly count: number;
} {
  if (snapshot.needsYou > 0) return { lead: "needs-you", count: snapshot.needsYou };
  if (snapshot.working > 0) return { lead: "working", count: snapshot.working };
  if (snapshot.failed > 0) return { lead: "failed", count: snapshot.failed };
  if (snapshot.done > 0) return { lead: "finished", count: snapshot.done };
  return { lead: "idle", count: 0 };
}

export function encodeNotchIslandSnapshotCommand(snapshot: DesktopNotchIslandSnapshot): string {
  const { lead, count: leadCount } = resolveNotchIslandLead(snapshot);
  return `${JSON.stringify({
    type: "snapshot",
    lead,
    count: leadCount,
    needsYou: snapshot.needsYou,
    working: snapshot.working,
    done: snapshot.done,
    failed: snapshot.failed,
    rows: snapshot.rows,
  })}\n`;
}

export function encodeNotchIslandIconsCommand(icons: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({ type: "icons", icons })}\n`;
}
