// FILE: groupProjects.ts
// Purpose: Classify and create Group container projects. Groups are explicit — never
//          auto-created. A legacy Studio row is adopted as a group when present.
// Layer: Web orchestration helper
// Exports: Group container lookup and creation helpers.

import { type ProjectId } from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";

import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import type { Project } from "../types";
import { slugifyChatWorkspaceSeed } from "./chatWorkspaceFolders";
import {
  extractDuplicateProjectCreateProjectId,
  findContainerCandidateById,
  isDuplicateProjectCreateError,
  waitForSnapshotMatch,
} from "./projectCreateRecovery";
import {
  resolveServerGroupsWorkspaceRoot,
  resolveServerStudioWorkspaceRoot,
  type ServerWorkspacePaths,
} from "./serverWorkspacePaths";
import { newCommandId, newProjectId } from "./utils";

const CREATED_CONTAINER_SYNC_MAX_ATTEMPTS = 10;

function preferredPathSeparator(root: string): "\\" | "/" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function joinGroupWorkspacePath(root: string, slug: string): string {
  const separator = preferredPathSeparator(root);
  return [root.replace(/[\\/]+$/g, ""), slug].filter(Boolean).join(separator);
}

export function isGroupContainerProject(
  project: Pick<Project, "cwd" | "kind"> | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  if (!project) {
    return false;
  }
  if (project.kind === "group") {
    const groupsWorkspaceRoot = resolveServerGroupsWorkspaceRoot(paths);
    // Until the server welcome delivers the Groups root, trust the kind alone so boot
    // partitioning does not briefly treat group rows as ordinary projects.
    if (!groupsWorkspaceRoot) {
      return true;
    }
    return (
      workspaceRootsEqual(project.cwd, groupsWorkspaceRoot) ||
      isWorkspaceRootWithin(project.cwd, groupsWorkspaceRoot)
    );
  }
  if (project.kind === "studio") {
    const studioWorkspaceRoot = resolveServerStudioWorkspaceRoot(paths);
    if (!studioWorkspaceRoot) {
      return true;
    }
    return (
      workspaceRootsEqual(project.cwd, studioWorkspaceRoot) ||
      isWorkspaceRootWithin(project.cwd, studioWorkspaceRoot)
    );
  }
  return false;
}

export function collectGroupProjectIds<T extends Pick<Project, "id" | "cwd" | "kind">>(
  projects: readonly T[],
  paths: ServerWorkspacePaths,
): Set<ProjectId> {
  return new Set(
    projects
      .filter((project) => isGroupContainerProject(project, paths))
      .map((project) => project.id),
  );
}

function findGroupContainerCandidateById<
  T extends { readonly id?: ProjectId | undefined; readonly kind?: Project["kind"] | undefined },
>(projects: readonly T[], projectId: ProjectId): T | null {
  return findContainerCandidateById(
    projects,
    projectId,
    (project) => project.kind === "group" || project.kind === "studio",
  );
}

export async function createGroupProject(input: {
  readonly title: string;
}): Promise<ProjectId | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }

  const groupsWorkspaceRoot = useWorkspacePathsStore.getState().groupsWorkspaceRoot;
  if (!groupsWorkspaceRoot) {
    return null;
  }

  const workspaceRoot = joinGroupWorkspacePath(
    groupsWorkspaceRoot,
    slugifyChatWorkspaceSeed(input.title),
  );
  const projectId = newProjectId();
  try {
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "group",
      title: input.title,
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDuplicateProjectCreateError(message)) {
      const duplicateProjectId = extractDuplicateProjectCreateProjectId(message);
      if (duplicateProjectId) {
        const { match } = await waitForSnapshotMatch({
          maxAttempts: CREATED_CONTAINER_SYNC_MAX_ATTEMPTS,
          loadSnapshot: async () => {
            const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
            if (snapshot) {
              useStore.getState().syncServerShellSnapshot(snapshot);
            }
            return snapshot;
          },
          findMatch: (snapshot) =>
            findGroupContainerCandidateById(snapshot.projects, duplicateProjectId as ProjectId),
        });
        return match?.id ?? null;
      }
    }
    throw error;
  }

  const { match } = await waitForSnapshotMatch({
    maxAttempts: CREATED_CONTAINER_SYNC_MAX_ATTEMPTS,
    loadSnapshot: async () => {
      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot) {
        useStore.getState().syncServerShellSnapshot(snapshot);
      }
      return snapshot;
    },
    findMatch: (snapshot) => findGroupContainerCandidateById(snapshot.projects, projectId),
  });
  return match?.id ?? projectId;
}
