// Purpose: Resolve the user-facing project label for a pinned thread row.
// Layer: web pure helper. Pinned rows show the project name, not the raw folder basename.
// Exports: resolvePinnedThreadProjectLabel.

import type { ProjectId } from "@t3tools/contracts";
import type { Project } from "../types";

export function resolvePinnedThreadProjectLabel(
  projectById: ReadonlyMap<ProjectId, Project>,
  projectId: ProjectId,
): string | null {
  const project = projectById.get(projectId);
  if (!project) return null;
  return project.name ?? project.folderName ?? null;
}
