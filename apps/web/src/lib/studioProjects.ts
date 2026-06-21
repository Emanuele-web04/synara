// FILE: studioProjects.ts
// Purpose: Manage the hidden Studio project container that backs Studio chat threads.
// Layer: Web orchestration helper
// Exports: Studio project lookup, creation, and prewarm helpers.

import { type ProjectId } from "@t3tools/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Project } from "../types";
import {
  resolveServerStudioWorkspaceRoot,
  type ServerWorkspacePaths,
} from "./serverWorkspacePaths";
import { newCommandId, newProjectId } from "./utils";

const pendingStudioCreationByWorkspaceRoot = new Map<string, Promise<ProjectId | null>>();

export function isStudioContainerProject(
  project: Pick<Project, "cwd" | "kind"> | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  const studioWorkspaceRoot = resolveServerStudioWorkspaceRoot(paths);
  if (!project || !studioWorkspaceRoot || project.kind !== "studio") {
    return false;
  }
  return (
    workspaceRootsEqual(project.cwd, studioWorkspaceRoot) ||
    isWorkspaceRootWithin(project.cwd, studioWorkspaceRoot)
  );
}

export function findStudioContainerProject<T extends Pick<Project, "cwd" | "kind">>(
  projects: readonly T[],
  paths: ServerWorkspacePaths,
): T | null {
  return projects.find((project) => isStudioContainerProject(project, paths)) ?? null;
}

export async function ensureStudioProject(paths: ServerWorkspacePaths): Promise<ProjectId | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }

  const workspaceRoot = resolveServerStudioWorkspaceRoot(paths);
  if (!workspaceRoot) {
    return null;
  }

  const existingProject = findStudioContainerProject(useStore.getState().projects, paths);
  if (existingProject) {
    return existingProject.id;
  }

  const pendingCreation = pendingStudioCreationByWorkspaceRoot.get(workspaceRoot);
  if (pendingCreation) {
    return pendingCreation;
  }

  const creationPromise = (async () => {
    const projectId = newProjectId();
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "studio",
      title: "Studio",
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      createdAt: new Date().toISOString(),
    });
    return projectId;
  })().finally(() => {
    pendingStudioCreationByWorkspaceRoot.delete(workspaceRoot);
  });

  pendingStudioCreationByWorkspaceRoot.set(workspaceRoot, creationPromise);
  return creationPromise;
}

export function prewarmStudioProject(paths: ServerWorkspacePaths): void {
  void ensureStudioProject(paths);
}
