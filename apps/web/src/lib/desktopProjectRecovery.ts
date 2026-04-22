// FILE: desktopProjectRecovery.ts
// Purpose: Detects desktop startup snapshots that can hide projects while thread rows still exist.
// Exports: snapshot shape guard used by the desktop bootstrap repair path.

import type { OrchestrationReadModel } from "@t3tools/contracts";

export function hasLiveThreadsWithMissingProjects(snapshot: OrchestrationReadModel): boolean {
  const liveProjectIds = new Set(
    snapshot.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );

  return snapshot.threads.some(
    (thread) => thread.deletedAt === null && !liveProjectIds.has(thread.projectId),
  );
}
