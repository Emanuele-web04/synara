// FILE: SidebarGroupsSurface.logic.ts
// Purpose: Pure helpers for the Groups sidebar surface — coordinator row labels,
//          empty states, and new-chat target resolution.
// Layer: Web view logic (no React)
// Exports: resolveGroupCoordinatorRowLabel, resolveGroupsListEmptyState,
//          resolveGroupChatTargetProjectId, activateThreadWhenHydrated

import type { ProjectId } from "@synara/contracts";

import { resolveGroupCoordinatorDisplayName } from "../lib/groupCoordinatorName";
import type { Project } from "../types";

export function resolveGroupCoordinatorRowLabel(input: {
  readonly configured: boolean;
  readonly coordinatorName: string | null | undefined;
  readonly groupName: string;
  readonly remoteName?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
}): string {
  if (!input.configured) {
    return "Set up coordinator";
  }
  return resolveGroupCoordinatorDisplayName(input);
}

export type GroupsListEmptyState = "loading" | "no-groups" | null;

export function resolveGroupsListEmptyState(input: {
  readonly threadsHydrated: boolean;
  readonly groupCount: number;
}): GroupsListEmptyState {
  if (!input.threadsHydrated) {
    return "loading";
  }
  return input.groupCount === 0 ? "no-groups" : null;
}

/**
 * Picks which group a bare "new group chat" (or the /groups fresh-chat path)
 * should land in: the active group when the current project already is a group
 * container, otherwise the first listed group. Returns null when no group
 * exists — callers then show the Groups empty state instead of creating a
 * container implicitly.
 */
export function resolveGroupChatTargetProjectId(input: {
  readonly activeProject: Pick<Project, "id"> | null;
  readonly groupProjects: readonly Pick<Project, "id">[];
}): ProjectId | null {
  const activeProjectId = input.activeProject?.id;
  if (activeProjectId && input.groupProjects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }
  return input.groupProjects[0]?.id ?? null;
}

/**
 * A just-configured coordinator thread is not in the sidebar summary map yet when
 * onboarding saves, so a bare activation intent is dropped (`threadExists=false`).
 * The snapshot echo can take several seconds, so wait on store notifications (when
 * the caller passes a subscribe) plus a poll fallback until the row appears or the
 * window expires. Returns a cancel function.
 */
export function activateThreadWhenHydrated(input: {
  readonly hasThread: () => boolean;
  readonly activate: () => void;
  readonly subscribe?: ((listener: () => void) => () => void) | undefined;
  readonly maxWaitMs?: number | undefined;
  readonly pollMs?: number | undefined;
}): () => void {
  if (input.hasThread()) {
    input.activate();
    return () => {};
  }
  const maxWaitMs = input.maxWaitMs ?? 30_000;
  const pollMs = input.pollMs ?? 250;
  let finished = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const finish = (activate: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    unsubscribe?.();
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (activate) {
      input.activate();
    }
  };
  const check = (): void => {
    if (input.hasThread()) {
      finish(true);
    }
  };
  unsubscribe = input.subscribe?.(check);
  intervalId = setInterval(check, pollMs);
  timeoutId = setTimeout(() => finish(false), maxWaitMs);
  return () => finish(false);
}
