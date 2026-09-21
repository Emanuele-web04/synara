// FILE: SidebarGroupsSurface.logic.ts
// Purpose: Pure helpers for the Groups sidebar surface — coordinator row labels,
//          empty states, and new-chat target resolution.
// Layer: Web view logic (no React)
// Exports: resolveGroupCoordinatorRowLabel, resolveGroupsListEmptyState,
//          resolveGroupChatTargetProjectId, activateThreadWhenHydrated

import type { ProjectId } from "@synara/contracts";

import type { Project } from "../types";

export function resolveGroupCoordinatorRowLabel(input: {
  readonly configured: boolean;
  readonly coordinatorName: string | null | undefined;
}): string {
  if (input.configured && input.coordinatorName && input.coordinatorName.trim().length > 0) {
    return input.coordinatorName;
  }
  return "Set up coordinator";
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
 * Poll briefly until the snapshot catches up, then activate. Returns whether the
 * activation ran.
 */
export async function activateThreadWhenHydrated(input: {
  readonly hasThread: () => boolean;
  readonly activate: () => void;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
}): Promise<boolean> {
  const maxAttempts = input.maxAttempts ?? 20;
  const delayMs = input.delayMs ?? 100;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (input.hasThread()) {
      input.activate();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
