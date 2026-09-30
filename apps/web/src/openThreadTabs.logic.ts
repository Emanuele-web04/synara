// FILE: openThreadTabs.logic.ts
// Purpose: Pure helpers for the open-thread tabs: maintaining the ordered open list,
//          deciding which open threads render as tabs, how each tab is labelled, and
//          which tab takes over when the active one closes.
// Layer: UI state logic
// Exports: open-list transitions, persisted-list normalization, tab derivation, close successor

import type { ProjectId, ProviderKind, ThreadId } from "@synara/contracts";

import { resolveDraftThreadTitle } from "./components/ChatView.logic";
import { resolveSubagentPresentationForThread } from "./lib/subagentPresentation";
import { resolveTabAfterClose } from "./lib/tabStrip";
import type { SidebarThreadSummary, ThreadPrimarySurface } from "./types";

export interface OpenThreadTab {
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  provider: ProviderKind;
  // Terminal-first threads show the terminal glyph, like the chat header and sidebar.
  isTerminal: boolean;
  // Not sent yet: exists only as a local composer draft.
  isDraft: boolean;
}

/** Everything the tab derivation needs to know about one open thread id. */
export interface OpenThreadTabSource {
  threadId: ThreadId;
  summary: SidebarThreadSummary | undefined;
  draft:
    | {
        projectId: ProjectId;
        entryPoint: ThreadPrimarySurface;
        // The provider the draft's composer will send with.
        provider: ProviderKind;
      }
    | undefined;
  terminalEntryPoint: boolean;
}

// The transitions return the input array untouched when nothing changes, so the store
// can skip no-op writes (and the persist round-trip) by identity.

/** Opening a thread that already has a tab keeps its position; a new one goes last. */
export function addOpenThreadTab(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
): readonly ThreadId[] {
  return threadIds.includes(threadId) ? threadIds : [...threadIds, threadId];
}

export function removeOpenThreadTab(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
): readonly ThreadId[] {
  return threadIds.includes(threadId)
    ? threadIds.filter((candidate) => candidate !== threadId)
    : threadIds;
}

export function pruneOpenThreadTabs(
  threadIds: readonly ThreadId[],
  isKept: (threadId: ThreadId) => boolean,
): readonly ThreadId[] {
  const kept = threadIds.filter(isKept);
  return kept.length === threadIds.length ? threadIds : kept;
}

export function normalizeOpenThreadTabIds(input: unknown): ThreadId[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const threadIds: ThreadId[] = [];
  for (const candidate of input) {
    if (typeof candidate !== "string") continue;
    const threadId = candidate.trim();
    if (threadId.length === 0 || seen.has(threadId)) continue;
    seen.add(threadId);
    threadIds.push(threadId as ThreadId);
  }
  return threadIds;
}

/**
 * Whether an open thread can keep a tab while it is not being viewed. Archived threads
 * and Side chats (which live in their source thread's dock) keep one only while they
 * are the thread on screen; anything that no longer exists loses it.
 */
export function canKeepOpenThreadTab(
  summary: SidebarThreadSummary | undefined,
  hasDraft: boolean,
): boolean {
  if (summary) {
    return summary.archivedAt == null && !summary.sidechatSourceThreadId;
  }
  return hasDraft;
}

function resolveOpenThreadTab(source: OpenThreadTabSource): OpenThreadTab | null {
  const { summary, draft } = source;
  if (summary) {
    return {
      threadId: source.threadId,
      projectId: summary.projectId,
      // Subagent threads read as their agent, exactly like the sidebar row.
      title: summary.parentThreadId
        ? resolveSubagentPresentationForThread({ thread: summary }).fullLabel
        : summary.title,
      provider: summary.session?.provider ?? summary.modelSelection.provider,
      isTerminal: source.terminalEntryPoint,
      isDraft: false,
    };
  }
  if (draft) {
    return {
      threadId: source.threadId,
      projectId: draft.projectId,
      title: resolveDraftThreadTitle(draft.entryPoint),
      provider: draft.provider,
      isTerminal: source.terminalEntryPoint || draft.entryPoint === "terminal",
      isDraft: true,
    };
  }
  return null;
}

/**
 * Tabs in open order. `projectId` scopes the list (the editor view only shows its own
 * project's threads); the active thread always renders if it is open, even when it is
 * a thread that could not keep a tab in the background (archived, Side chat).
 */
export function buildOpenThreadTabs(input: {
  sources: readonly OpenThreadTabSource[];
  activeThreadId: ThreadId | null;
  projectId?: ProjectId | null | undefined;
}): OpenThreadTab[] {
  return input.sources.flatMap((source) => {
    if (
      source.threadId !== input.activeThreadId &&
      !canKeepOpenThreadTab(source.summary, source.draft !== undefined)
    ) {
      return [];
    }
    const tab = resolveOpenThreadTab(source);
    if (!tab || (input.projectId && tab.projectId !== input.projectId)) {
      return [];
    }
    return [tab];
  });
}

/**
 * Where to go after closing a tab. Closing a background tab keeps the current thread
 * (`null`); closing the active one moves to the tab that slides into its slot, else the
 * one before it (`{ threadId: null }` when it was the last tab).
 */
export function resolveOpenThreadTabCloseTarget(input: {
  tabs: readonly Pick<OpenThreadTab, "threadId">[];
  closedThreadId: ThreadId;
  activeThreadId: ThreadId | null;
}): { threadId: ThreadId | null } | null {
  if (input.closedThreadId !== input.activeThreadId) {
    return null;
  }
  const closedIndex = input.tabs.findIndex((tab) => tab.threadId === input.closedThreadId);
  const remaining = input.tabs.filter((tab) => tab.threadId !== input.closedThreadId);
  return { threadId: resolveTabAfterClose(remaining, closedIndex)?.threadId ?? null };
}
