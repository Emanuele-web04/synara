// FILE: studioProjects.ts
// Purpose: Manage the hidden Studio project container that backs Studio chat threads.
// Layer: Web orchestration helper
// Exports: Studio project lookup, creation, and prewarm helpers.

import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { waitForProjectSnapshotHydration } from "./projectSnapshotHydration";
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

export function isStudioContainerProject(
  project: Pick<Project, "cwd" | "kind"> | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  if (!project || project.kind !== "studio") {
    return false;
  }
  const studioWorkspaceRoot = resolveServerStudioWorkspaceRoot(paths);
  // Until the server welcome delivers the Studio root, trust the kind alone: rejecting here
  // would briefly mis-partition Studio threads (sidebar segments, Kanban, empty landing) while
  // the app boots. Once the root is known, keep the containment check so a container whose
  // cwd drifted outside the configured root is treated as orphaned rather than as Studio.
  if (!studioWorkspaceRoot) {
    return true;
  }
  return (
    workspaceRootsEqual(project.cwd, studioWorkspaceRoot) ||
    isWorkspaceRootWithin(project.cwd, studioWorkspaceRoot)
  );
}

export function collectStudioProjectIds<T extends Pick<Project, "id" | "cwd" | "kind">>(
  projects: readonly T[],
  paths: ServerWorkspacePaths,
): Set<ProjectId> {
  return new Set(
    projects.filter((project) => isStudioContainerProject(project, paths)).map((p) => p.id),
  );
}

export function findStudioContainerProject<T extends Pick<Project, "cwd" | "kind">>(
  projects: readonly T[],
  paths: ServerWorkspacePaths,
): T | null {
  const candidates = projects.filter((project) => isStudioContainerProject(project, paths));
  // Prefer the canonical container (cwd exactly the Studio root) over any studio-kind row
  // nested beneath it, so ensure/create flows never bind new Studio chats to a nested project.
  // isStudioContainerProject stays broad on purpose: nested rows still classify as Studio for
  // partitioning, they just never win the container lookup.
  const studioWorkspaceRoot = resolveServerStudioWorkspaceRoot(paths);
  if (studioWorkspaceRoot) {
    const canonical = candidates.find((project) =>
      workspaceRootsEqual(project.cwd, studioWorkspaceRoot),
    );
    if (canonical) {
      return canonical;
    }
  }
  return candidates[0] ?? null;
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

  // Same shape as ensureHomeChatProject: never consult the local store before the first shell
  // snapshot. Store rows only ever come from server syncs today, but waiting first keeps this
  // safe even if project rows ever become locally persisted or partially populated.
  await waitForProjectSnapshotHydration();

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
