// FILE: recentViews.logic.ts
// Purpose: Pure helpers for the Ctrl+Tab recent primary-view switcher.
// Layer: UI state logic
// Exports: recent view types plus MRU update, pruning, and display derivation helpers

import type { ProjectId, ProviderKind, ThreadId } from "@synara/contracts";
import type {
  ResolvedTerminalVisualIdentity,
  TerminalIconKey,
} from "@synara/shared/terminalThreads";
import type { Project, SidebarThreadSummary } from "./types";

export const MAX_RECENT_VIEWS = 5;

export type RecentView =
  | {
      kind: "thread";
      threadId: ThreadId;
      splitViewId?: string | undefined;
    }
  | {
      kind: "workspace";
      workspaceId: string;
    }
  | {
      kind: "settings";
      section?: string | undefined;
    }
  | {
      kind: "plugins";
    };

export interface RecentViewDisplayEntry {
  key: string;
  view: RecentView;
  kind: RecentView["kind"];
  icon: RecentViewDisplayIcon;
  title: string;
  subtitle: string;
  isCurrent: boolean;
  isPinned: boolean;
  isSplit: boolean;
  isTerminal: boolean;
  provider?: ProviderKind | undefined;
  terminalVisualIdentity?: ResolvedTerminalVisualIdentity | undefined;
}

export type RecentViewDisplayIcon =
  | { kind: "chat" }
  | { kind: "provider"; provider: ProviderKind }
  | { kind: "terminal"; iconKey: TerminalIconKey }
  | { kind: "workspace" }
  | { kind: "settings" }
  | { kind: "plugins" };

export interface RecentViewWorkspaceSummary {
  id: string;
  title: string;
}

export interface RecentViewThreadDraftSummary {
  id: ThreadId;
  projectId: ProjectId;
  title?: string | undefined;
  isPinned?: boolean | undefined;
}

export interface RecentViewAvailability {
  availableThreadIds: ReadonlySet<ThreadId>;
  availableWorkspaceIds: ReadonlySet<string>;
  availableSplitViewIds: ReadonlySet<string>;
  threadIdsBySplitViewId?: ReadonlyMap<string, ReadonlySet<ThreadId>> | undefined;
}

const SETTINGS_LABELS: Readonly<Record<string, string>> = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers",
  keybindings: "Keybindings",
};

function normalizeOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recentViewKey(view: RecentView): string {
  switch (view.kind) {
    case "thread":
      return view.splitViewId
        ? `thread:${view.threadId}:split:${view.splitViewId}`
        : `thread:${view.threadId}`;
    case "workspace":
      return `workspace:${view.workspaceId}`;
    case "settings":
      return view.section ? `settings:${view.section}` : "settings";
    case "plugins":
      return "plugins";
  }
}

export function deriveCurrentRecentView(input: {
  pathname: string;
  routeThreadId: ThreadId | null;
  activeThreadId: ThreadId | null;
  routeWorkspaceId: string | null;
  splitViewId?: string | undefined;
  settingsSection?: string | undefined;
}): RecentView | null {
  const splitViewId = normalizeOptionalId(input.splitViewId);

  if (input.pathname.startsWith("/workspace/") && input.routeWorkspaceId) {
    return {
      kind: "workspace",
      workspaceId: input.routeWorkspaceId,
    };
  }

  if (input.pathname === "/settings") {
    const section = normalizeOptionalId(input.settingsSection);
    return {
      kind: "settings",
      ...(section ? { section } : {}),
    };
  }

  if (input.pathname === "/plugins") {
    return { kind: "plugins" };
  }

  if (input.routeThreadId) {
    return {
      kind: "thread",
      threadId: input.activeThreadId ?? input.routeThreadId,
      ...(splitViewId ? { splitViewId } : {}),
    };
  }

  return null;
}

export function upsertRecentView(
  recentViews: readonly RecentView[],
  view: RecentView,
  limit = MAX_RECENT_VIEWS,
): RecentView[] {
  const key = recentViewKey(view);
  const deduped = recentViews.filter((entry) => recentViewKey(entry) !== key);
  return [view, ...deduped].slice(0, limit);
}

export function pruneRecentViews(
  recentViews: readonly RecentView[],
  availability: RecentViewAvailability,
  limit = MAX_RECENT_VIEWS,
): RecentView[] {
  const nextViews: RecentView[] = [];
  const seenKeys = new Set<string>();

  for (const view of recentViews) {
    const normalized = normalizeAvailableView(view, availability);
    if (!normalized) continue;

    const key = recentViewKey(normalized);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    nextViews.push(normalized);

    if (nextViews.length >= limit) break;
  }

  return nextViews;
}

function normalizeAvailableView(
  view: RecentView,
  availability: RecentViewAvailability,
): RecentView | null {
  switch (view.kind) {
    case "thread": {
      if (!availability.availableThreadIds.has(view.threadId)) {
        return null;
      }
      if (view.splitViewId) {
        const splitThreadIds = availability.threadIdsBySplitViewId?.get(view.splitViewId);
        const splitStillContainsThread = splitThreadIds ? splitThreadIds.has(view.threadId) : true;
        if (
          !availability.availableSplitViewIds.has(view.splitViewId) ||
          !splitStillContainsThread
        ) {
          return { kind: "thread", threadId: view.threadId };
        }
      }
      return view;
    }
    case "workspace":
      return availability.availableWorkspaceIds.has(view.workspaceId) ? view : null;
    case "settings":
    case "plugins":
      return view;
  }
}

function resolveThreadDisplayIcon(input: {
  provider?: ProviderKind | undefined;
  terminalVisualIdentity?: ResolvedTerminalVisualIdentity | null | undefined;
}): RecentViewDisplayIcon {
  if (input.terminalVisualIdentity) {
    return { kind: "terminal", iconKey: input.terminalVisualIdentity.iconKey };
  }
  if (input.provider) {
    return { kind: "provider", provider: input.provider };
  }
  return { kind: "chat" };
}

export function resolveRecentViewNavigationIndex(input: {
  recentViews: readonly RecentView[];
  currentView: RecentView | null;
  selectedKey?: string | null | undefined;
  direction: "next" | "previous";
}): number | null {
  const { recentViews, currentView, selectedKey, direction } = input;
  if (recentViews.length < 2) {
    return null;
  }

  const delta = direction === "next" ? 1 : -1;
  const preferredKey = selectedKey ?? (currentView ? recentViewKey(currentView) : null);
  const preferredIndex =
    preferredKey === null
      ? -1
      : recentViews.findIndex((view) => recentViewKey(view) === preferredKey);
  const startIndex = preferredIndex >= 0 ? preferredIndex : 0;
  return (startIndex + delta + recentViews.length) % recentViews.length;
}

export function buildRecentViewDisplayEntries(input: {
  recentViews: readonly RecentView[];
  currentView: RecentView | null;
  threadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
  draftThreadsById?: Readonly<Record<string, RecentViewThreadDraftSummary | undefined>>;
  projects: readonly Project[];
  pinnedThreadIds: readonly ThreadId[];
  workspacePages: readonly RecentViewWorkspaceSummary[];
  terminalVisualIdentityByThreadId?: ReadonlyMap<ThreadId, ResolvedTerminalVisualIdentity>;
}): RecentViewDisplayEntry[] {
  const currentKey = input.currentView ? recentViewKey(input.currentView) : null;
  const projectNameById = new Map(input.projects.map((project) => [project.id, project.name]));
  const workspaceNameById = new Map(
    input.workspacePages.map((workspace) => [workspace.id, workspace.title]),
  );
  const pinnedThreadIds = new Set(input.pinnedThreadIds);

  return input.recentViews.map((view) => {
    const key = recentViewKey(view);
    const terminalVisualIdentity =
      view.kind === "thread" ? input.terminalVisualIdentityByThreadId?.get(view.threadId) : null;
    const base = {
      key,
      view,
      kind: view.kind,
      isCurrent: key === currentKey,
      isPinned: false,
      isSplit: view.kind === "thread" && Boolean(view.splitViewId),
      isTerminal: Boolean(terminalVisualIdentity),
      ...(terminalVisualIdentity ? { terminalVisualIdentity } : {}),
    };

    switch (view.kind) {
      case "thread": {
        const summary = input.threadsById[view.threadId];
        const thread = summary ?? input.draftThreadsById?.[view.threadId];
        const projectName = thread ? projectNameById.get(thread.projectId) : null;
        const provider = summary?.modelSelection.provider;
        const title = normalizeOptionalId(thread?.title) ?? "New chat";
        const subtitleParts = [
          projectName ?? "Chat",
          base.isTerminal ? "Terminal" : "Chat",
          base.isSplit ? "Split" : null,
        ].filter((part): part is string => Boolean(part));
        return {
          ...base,
          icon: resolveThreadDisplayIcon({ provider, terminalVisualIdentity }),
          provider,
          title,
          subtitle: subtitleParts.join(" · "),
          isPinned: pinnedThreadIds.has(view.threadId) || Boolean(thread?.isPinned),
        };
      }
      case "workspace":
        return {
          ...base,
          icon: { kind: "workspace" },
          title: workspaceNameById.get(view.workspaceId) ?? "Workspace",
          subtitle: "Terminal workspace",
        };
      case "settings":
        return {
          ...base,
          icon: { kind: "settings" },
          title: "Settings",
          subtitle: view.section ? (SETTINGS_LABELS[view.section] ?? view.section) : "App settings",
        };
      case "plugins":
        return {
          ...base,
          icon: { kind: "plugins" },
          title: "Plugins",
          subtitle: "Extensions and integrations",
        };
    }
  });
}
