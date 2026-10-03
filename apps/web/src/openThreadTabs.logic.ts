// FILE: openThreadTabs.logic.ts
// Purpose: Pure helpers for the open-thread tabs: maintaining the ordered open list,
//          deciding which open threads render as tabs, how each tab is labelled, and
//          which tab takes over when the active one closes.
// Layer: UI state logic
// Exports: open-list transitions, persisted-list normalization, tab derivation, close flow

import type { ProjectId, ProviderKind, ThreadId } from "@synara/contracts";
import { arrayMove } from "@dnd-kit/sortable";
import { isSidechatThread } from "@synara/shared/sidechatThread";

import { resolveDraftThreadTitle } from "./components/ChatView.logic";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import { resolveSubagentPresentationForThread } from "./lib/subagentPresentation";
import { resolveTabAfterClose } from "./lib/tabStrip";
import type { SidebarThreadSummary, Thread, ThreadPrimarySurface } from "./types";

export interface OpenThreadTab {
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  provider: ProviderKind;
  // Terminal-first threads show the terminal glyph, like the chat header and sidebar.
  isTerminal: boolean;
  // Not sent yet: exists only as a local composer draft.
  isDraft: boolean;
  // Working or connecting: the tab spins where the sidebar row does.
  isRunning: boolean;
}

/** Everything the tab derivation needs to know about one open thread id. */
export interface OpenThreadTabSource {
  threadId: ThreadId;
  summary: SidebarThreadSummary | undefined;
  // A subagent thread's parent, whose activity log names the agent when the subagent's
  // own summary does not.
  parentThread?: Pick<Thread, "id" | "activities"> | undefined;
  draft:
    | {
        projectId: ProjectId;
        entryPoint: ThreadPrimarySurface;
        // The provider the draft's composer will send with.
        provider: ProviderKind;
      }
    | undefined;
  terminalEntryPoint: boolean;
  isPreparingWorktree?: boolean | undefined;
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

/**
 * Drops a dragged tab onto another tab's slot in the full open list, retaining hidden
 * tabs and their relative order.
 */
export function moveOpenThreadTab(
  threadIds: readonly ThreadId[],
  threadId: ThreadId,
  overThreadId: ThreadId,
): readonly ThreadId[] {
  const fromIndex = threadIds.indexOf(threadId);
  const toIndex = threadIds.indexOf(overThreadId);
  return fromIndex < 0 || toIndex < 0 || fromIndex === toIndex
    ? threadIds
    : arrayMove([...threadIds], fromIndex, toIndex);
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
 * and Side chats (which live in their host's dock) keep one only while they
 * are the thread on screen; anything that no longer exists loses it.
 */
export function canKeepOpenThreadTab(
  summary: SidebarThreadSummary | undefined,
  hasDraft: boolean,
): boolean {
  if (summary) {
    return summary.archivedAt == null && !isSidechatThread(summary);
  }
  return hasDraft;
}

function resolveOpenThreadTab(source: OpenThreadTabSource): OpenThreadTab | null {
  const { summary, draft, parentThread } = source;
  if (summary) {
    return {
      threadId: source.threadId,
      projectId: summary.projectId,
      // Subagent threads read as their agent, exactly like the sidebar row.
      title: summary.parentThreadId
        ? resolveSubagentPresentationForThread({
            thread: summary,
            threads: parentThread ? [parentThread] : undefined,
          }).fullLabel
        : summary.title,
      provider: summary.session?.provider ?? summary.modelSelection.provider,
      isTerminal: source.terminalEntryPoint,
      isDraft: false,
      // The sidebar row's own status, so a tab and its row never disagree.
      isRunning:
        resolveThreadStatusPill({
          thread: summary,
          hasPendingApprovals: summary.hasPendingApprovals,
          hasPendingUserInput: summary.hasPendingUserInput,
          isPreparingWorktree: source.isPreparingWorktree ?? false,
        })?.pulse === true,
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
      isRunning: false,
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

export interface CloseOpenThreadTabInput {
  tabs: readonly Pick<OpenThreadTab, "threadId">[];
  closedThreadId: ThreadId;
  activeThreadId: ThreadId | null;
  closeTab: (threadId: ThreadId) => void;
  openTab: (threadId: ThreadId) => Promise<unknown>;
  // What takes the last tab's place, decided when the close runs; without one the last
  // tab stays open. A replacement that keeps the thread's route (the editor rail's
  // terminal tab) lets the tab close at once instead of waiting for the route to move.
  replaceLastTab?: (() => Promise<LastTabReplacement>) | undefined;
  readRouteThreadId: () => string | null;
}

export type LastTabReplacement = { ok: true; leavesRoute: boolean } | { ok: false; error: string };

export type CloseOpenThreadTabResult = { ok: true } | { ok: false; error: string };

/** The chat header's replacement for its last tab: a fresh chat in that tab's project. */
export function replaceLastTabWithFreshChat(
  openFreshChat: () => Promise<ThreadId | null>,
): () => Promise<LastTabReplacement> {
  return async () => {
    try {
      const threadId = await openFreshChat();
      return threadId
        ? { ok: true, leavesRoute: true }
        : { ok: false, error: "Unable to prepare a new chat." };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to prepare a new chat.",
      };
    }
  };
}

/**
 * Closes a tab. A background tab closes at once. The active tab first leaves for its
 * successor (or its host's replacement when it was the last tab) and closes only once
 * the route has actually moved off it: a guarded navigation (unsaved editor buffers
 * that fail to save) keeps the thread on screen, and it must keep its tab. Resolves
 * with the replacement's error when one could not be opened.
 */
export async function closeOpenThreadTab(
  input: CloseOpenThreadTabInput,
): Promise<CloseOpenThreadTabResult> {
  const target = resolveOpenThreadTabCloseTarget(input);
  if (!target) {
    input.closeTab(input.closedThreadId);
    return { ok: true };
  }
  if (target.threadId) {
    await input.openTab(target.threadId);
  } else {
    if (!input.replaceLastTab) {
      return { ok: true };
    }
    const replacement = await input.replaceLastTab();
    if (!replacement.ok) {
      return replacement;
    }
    if (!replacement.leavesRoute) {
      input.closeTab(input.closedThreadId);
      return { ok: true };
    }
  }
  if (input.readRouteThreadId() !== input.closedThreadId) {
    input.closeTab(input.closedThreadId);
  }
  return { ok: true };
}

/** Which neighbours of a tab its context menu closes; the tab itself always stays. */
export type OpenThreadTabCloseScope = "left" | "right" | "others";

/**
 * The tabs a scoped close removes, in tab order. Empty when the scope has nothing in it
 * (no tabs on that side, or the anchor is the only tab), which is also when its menu row
 * is left out.
 */
export function resolveOpenThreadTabsInCloseScope(
  tabs: readonly Pick<OpenThreadTab, "threadId">[],
  anchorThreadId: ThreadId,
  scope: OpenThreadTabCloseScope,
): ThreadId[] {
  const anchorIndex = tabs.findIndex((tab) => tab.threadId === anchorThreadId);
  if (anchorIndex < 0) {
    return [];
  }
  return tabs
    .filter((_, index) =>
      scope === "left"
        ? index < anchorIndex
        : scope === "right"
          ? index > anchorIndex
          : index !== anchorIndex,
    )
    .map((tab) => tab.threadId);
}

/**
 * Closes several tabs around one that stays. When the thread on screen is among them the
 * kept tab takes over first, and (as with a single close) a thread the route could not
 * leave keeps its tab.
 */
export async function closeOpenThreadTabs(input: {
  closedThreadIds: readonly ThreadId[];
  keptThreadId: ThreadId;
  activeThreadId: ThreadId | null;
  closeTabs: (threadIds: readonly ThreadId[]) => void;
  openTab: (threadId: ThreadId) => Promise<unknown>;
  readRouteThreadId: () => string | null;
}): Promise<void> {
  if (input.activeThreadId !== null && input.closedThreadIds.includes(input.activeThreadId)) {
    await input.openTab(input.keptThreadId);
  }
  const routeThreadId = input.readRouteThreadId();
  const closedThreadIds = input.closedThreadIds.filter((threadId) => threadId !== routeThreadId);
  if (closedThreadIds.length > 0) {
    input.closeTabs(closedThreadIds);
  }
}

/**
 * Runs tab closes one at a time, each reading its input when it starts rather than when
 * its X was clicked. A second close clicked while the first is still navigating must see
 * where that navigation lands: with the old active thread it would take the successor
 * for a background tab and drop it, and the landing thread would then reopen it.
 */
export function createOpenThreadTabCloseQueue(): <Result>(
  run: () => Promise<Result>,
) => Promise<Result> {
  let queue: Promise<unknown> = Promise.resolve();
  return (run) => {
    const queued = queue.then(run, run);
    queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
}
