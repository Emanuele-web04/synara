// FILE: buildNotchIslandSnapshot.ts
// Purpose: Turn the Inbox's grouping of chats into what the notch island shows.
// Layer: Web runtime helper (pure)
// Exports: buildNotchIslandSnapshot, NOTCH_ISLAND_ROW_LIMIT

import type {
  DesktopNotchIslandRow,
  DesktopNotchIslandRowState,
  DesktopNotchIslandSnapshot,
} from "@synara/contracts";

import type { InboxThreadGroups, NeedsYouKind } from "../components/inbox/inbox.logic";
import { resolveThreadProjectLabel } from "../components/Sidebar.logic";
import { resolveThreadDisplayProvider } from "../lib/threadDisplayProvider";
import type { Project, SidebarThreadSummary } from "../types";

/** Rows the open island has room for; desktop main enforces the same cap. */
export const NOTCH_ISLAND_ROW_LIMIT = 4;

const NEEDS_YOU_STATE: Partial<Record<NeedsYouKind, DesktopNotchIslandRowState>> = {
  approval: "approval",
  input: "input",
  plan: "plan",
};

/**
 * Counts cover every chat the Inbox counts; the rows are the most urgent few:
 * what needs the user first, then running, failed, and unread finished chats.
 * Icons are attached by the publisher, which owns the glyph markup.
 */
export function buildNotchIslandSnapshot(
  groups: InboxThreadGroups,
  projectById: ReadonlyMap<string, Pick<Project, "kind" | "name" | "folderName">>,
): Omit<DesktopNotchIslandSnapshot, "icons"> {
  const toRow = (
    thread: SidebarThreadSummary,
    state: DesktopNotchIslandRowState,
  ): DesktopNotchIslandRow => ({
    threadId: thread.id,
    title: thread.title,
    project: resolveThreadProjectLabel(projectById.get(thread.projectId)),
    provider: resolveThreadDisplayProvider(thread),
    state,
  });

  const candidates: DesktopNotchIslandRow[] = [
    ...groups.needsYou.flatMap((item) => {
      const state = NEEDS_YOU_STATE[item.kind];
      return state ? [toRow(item.thread, state)] : [];
    }),
    ...groups.working.map((thread) => toRow(thread, "working")),
    ...groups.failed.map((thread) => toRow(thread, "failed")),
    ...groups.finished.map((thread) => toRow(thread, "done")),
  ];

  return {
    needsYou: groups.needsYou.length,
    working: groups.working.length,
    done: groups.finished.length,
    failed: groups.failed.length,
    rows: candidates.slice(0, NOTCH_ISLAND_ROW_LIMIT),
  };
}
