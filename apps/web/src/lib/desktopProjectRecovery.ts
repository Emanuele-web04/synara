// FILE: desktopProjectRecovery.ts
// Purpose: Detects desktop startup snapshots that can hide projects while thread rows still exist.
// Exports: snapshot shape guard and hydration recovery classifier for desktop bootstrap.

import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";

type ProjectRecoverySnapshot = OrchestrationReadModel | OrchestrationShellSnapshot;

export type DesktopHydrationRecoveryKind = "none" | "missing-threads" | "repair-projects";

export function hasLiveThreadsWithMissingProjects(snapshot: ProjectRecoverySnapshot): boolean {
  const liveProjectIds = new Set(
    snapshot.projects
      .filter((project) => !("deletedAt" in project) || project.deletedAt === null)
      .map((project) => project.id),
  );

  return snapshot.threads.some((thread) => {
    const isLiveThread = !("deletedAt" in thread) || thread.deletedAt === null;
    return isLiveThread && !liveProjectIds.has(thread.projectId);
  });
}

export function classifyDesktopHydrationRecovery(state: {
  threadsHydrated: boolean;
  projects: ReadonlyArray<{ id: string }>;
  threads: ReadonlyArray<{ projectId: string }>;
}): DesktopHydrationRecoveryKind {
  if (!state.threadsHydrated) return "none";
  if (state.projects.length > 0 && state.threads.length === 0) return "missing-threads";
  const projectIds = new Set(state.projects.map((project) => project.id));
  const hasThreadWithoutProject = state.threads.some((thread) => !projectIds.has(thread.projectId));
  if (state.projects.length === 0 || hasThreadWithoutProject) return "repair-projects";
  return "none";
}
