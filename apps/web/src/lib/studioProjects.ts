// FILE: studioProjects.ts
// Purpose: Manage the hidden Studio project container that backs Studio chat threads.
// Layer: Web orchestration helper
// Exports: Studio project lookup, creation, and prewarm helpers.

import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Project } from "../types";
import {
  resolveServerStudioWorkspaceRoot,
  type ServerWorkspacePaths,
} from "./serverWorkspacePaths";
import {
  extractDuplicateProjectCreateProjectId,
  findContainerCandidateById,
  isDuplicateProjectCreateError,
  resolveContainerCandidateCwd,
  waitForSnapshotMatch,
} from "./projectCreateRecovery";
import { newCommandId, newProjectId } from "./utils";

const pendingStudioCreationByWorkspaceRoot = new Map<string, Promise<ProjectId | null>>();

interface StudioContainerCandidate {
  readonly id?: ProjectId | undefined;
  readonly kind?: Project["kind"] | undefined;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

// Studio creation must wait for the first shell snapshot so an already-persisted hidden
// container is visible before we decide to dispatch another `project.create`.
function waitForProjectSnapshotHydration(): Promise<void> {
  if (useStore.getState().threadsHydrated) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      resolve();
    };

    unsubscribe = useStore.subscribe((state) => {
      if (state.threadsHydrated) {
        finish();
      }
    });
    if (useStore.getState().threadsHydrated) {
      finish();
    }
  });
}

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

export function findStudioDraftThreadId(input: {
  readonly studioProjectIds: ReadonlySet<ProjectId>;
  readonly projectDraftThreadIdByProjectId: Readonly<Record<string, ThreadId>>;
  readonly draftThreadsByThreadId: Readonly<Record<string, DraftThreadState>>;
}): ThreadId | null {
  for (const projectId of input.studioProjectIds) {
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

function isStudioContainerCandidate(
  project: StudioContainerCandidate | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  const cwd = resolveContainerCandidateCwd(project);
  if (!cwd) {
    return false;
  }
  return isStudioContainerProject(
    {
      cwd,
      kind: project?.kind ?? "project",
    },
    paths,
  );
}

function findStudioContainerCandidateById<T extends StudioContainerCandidate>(
  projects: readonly T[],
  projectId: ProjectId,
  paths: ServerWorkspacePaths,
): T | null {
  return findContainerCandidateById(projects, projectId, (project) =>
    isStudioContainerCandidate(project, paths),
  );
}

interface StudioRecoverySnapshot {
  readonly projects: readonly StudioContainerCandidate[];
}

// Reuses the shared duplicate-create retry/backoff loop (see projectCreateRecovery.ts) instead of
// hand-rolling a snapshot-retry loop: checks the local store first, then falls back to a fresh
// shell snapshot, syncing it into the store only once it actually contains the recovered project.
async function recoverDuplicateStudioContainer(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  projectId: ProjectId,
  paths: ServerWorkspacePaths,
): Promise<ProjectId | null> {
  const { match } = await waitForSnapshotMatch<StudioRecoverySnapshot, StudioContainerCandidate>({
    loadSnapshot: async () => {
      const localProjects = useStore.getState().projects;
      if (findStudioContainerCandidateById(localProjects, projectId, paths)) {
        return { projects: localProjects };
      }

      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot && findStudioContainerCandidateById(snapshot.projects, projectId, paths)) {
        useStore.getState().syncServerShellSnapshot(snapshot);
      }
      return snapshot;
    },
    findMatch: (snapshot) => findStudioContainerCandidateById(snapshot.projects, projectId, paths),
  });

  return match?.id ?? null;
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
    await waitForProjectSnapshotHydration();
    const hydratedExistingProject = findStudioContainerProject(useStore.getState().projects, paths);
    if (hydratedExistingProject) {
      return hydratedExistingProject.id;
    }

    const projectId = newProjectId();
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDuplicateProjectCreateError(message)) {
        const duplicateProjectId = extractDuplicateProjectCreateProjectId(message);
        if (duplicateProjectId) {
          const recoveredProjectId = await recoverDuplicateStudioContainer(
            api,
            duplicateProjectId as ProjectId,
            paths,
          );
          if (recoveredProjectId) {
            return recoveredProjectId;
          }
        }
      }
      throw error;
    }
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
