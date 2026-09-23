// FILE: groupProjects.ts
// Purpose: Classify and create Group container projects. Groups are explicit — never
//          auto-created. A legacy Studio row is adopted as a group when present.
// Layer: Web orchestration helper
// Exports: Group container lookup and creation helpers.

import { type ProjectId, type ThreadId } from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { isGroupContainerKind } from "@synara/shared/projectContainers";

import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import type { Project } from "../types";
import { slugifyGroupTitle } from "@synara/shared/groupSlug";
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

// The pre-Groups Studio container is adopted as a group in place: retitling it
// "Groups" keeps its chats under the new surface without moving workspaces.
// Idempotent by title — once renamed it no longer matches. A user-set local alias
// (localName) is honored: a renamed row is the user's title, not the default
// "Studio", so it is left alone.
export function findLegacyStudioContainerForAdoption<
  T extends Pick<Project, "id" | "cwd" | "kind" | "name" | "localName">,
>(projects: readonly T[], paths: ServerWorkspacePaths): T | null {
  return (
    projects.find(
      (project) =>
        project.kind === "studio" &&
        project.name === "Studio" &&
        project.localName === null &&
        isGroupContainerProject(project, paths),
    ) ?? null
  );
}

export function findGroupDraftThreadId(input: {
  readonly groupProjectIds: ReadonlySet<ProjectId>;
  readonly projectDraftThreadIdByProjectId: Readonly<Record<string, ThreadId>>;
  readonly draftThreadsByThreadId: Readonly<Record<string, DraftThreadState>>;
}): ThreadId | null {
  for (const projectId of input.groupProjectIds) {
    const draftThreadId = input.projectDraftThreadIdByProjectId[projectId];
    if (!draftThreadId) {
      continue;
    }
    const draftThread = input.draftThreadsByThreadId[draftThreadId];
    if (
      draftThread &&
      draftThread.projectId === projectId &&
      draftThread.entryPoint === "chat" &&
      draftThread.promotedTo === undefined
    ) {
      return draftThreadId;
    }
  }
  return null;
}

function findGroupContainerCandidateById<
  T extends { readonly id?: ProjectId | undefined; readonly kind?: Project["kind"] | undefined },
>(projects: readonly T[], projectId: ProjectId): T | null {
  return findContainerCandidateById(projects, projectId, (project) =>
    isGroupContainerKind(project.kind),
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

  const workspaceRoot = joinGroupWorkspacePath(groupsWorkspaceRoot, slugifyGroupTitle(input.title));
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
  // A sync miss must not hand back the possibly-nonexistent id: callers open the
  // onboarding dialog for it and the lookup would silently no-op.
  return match?.id ?? null;
}
