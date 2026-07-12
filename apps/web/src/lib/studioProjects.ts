// FILE: studioProjects.ts
// Purpose: Manage the hidden Studio project container that backs Studio chat threads.
// Layer: Web orchestration helper
// Exports: Studio project lookup, creation, and prewarm helpers.

import { type ProjectId, type ThreadId } from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import {
  PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS,
  waitForProjectSnapshotHydration,
} from "./projectSnapshotHydration";
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
  waitForSnapshotMatch,
} from "./projectCreateRecovery";
import { newCommandId, newProjectId } from "./utils";

const pendingStudioCreationByWorkspaceRoot = new Map<string, Promise<ProjectId | null>>();

// A successful create's follow-up sync gets a longer retry window than duplicate recovery
// (~2.3s vs ~0.75s): the row is guaranteed to arrive eventually, so patience beats failing.
const CREATED_CONTAINER_SYNC_MAX_ATTEMPTS = 10;

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

// Matches a container row by id + studio kind only. Root containment is deliberately NOT
// required here: the id comes from our own create or the server's ownership error, and the
// server stores the CANONICALIZED (realpath) root — comparing it against the raw configured
// string would wrongly reject the container whenever the Studio path contains a symlink.
function findStudioContainerCandidateById<T extends StudioContainerCandidate>(
  projects: readonly T[],
  projectId: ProjectId,
): T | null {
  return findContainerCandidateById(projects, projectId, (project) => project.kind === "studio");
}

interface StudioRecoverySnapshot {
  readonly projects: readonly StudioContainerCandidate[];
}

// Waits (shared retry/backoff loop, see projectCreateRecovery.ts) until the given container id
// is visible in the local store: checks the store first, then pulls fresh shell snapshots,
// syncing one in only once it actually contains the project. Resolves null when it never shows.
async function waitForStudioContainerInStore(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  projectId: ProjectId,
  options?: { readonly maxAttempts?: number | undefined },
): Promise<StudioContainerCandidate | null> {
  const { match } = await waitForSnapshotMatch<StudioRecoverySnapshot, StudioContainerCandidate>({
    maxAttempts: options?.maxAttempts,
    loadSnapshot: async () => {
      const localProjects = useStore.getState().projects;
      if (findStudioContainerCandidateById(localProjects, projectId)) {
        return { projects: localProjects };
      }

      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot && findStudioContainerCandidateById(snapshot.projects, projectId)) {
        useStore.getState().syncServerShellSnapshot(snapshot);
      }
      return snapshot;
    },
    findMatch: (snapshot) => findStudioContainerCandidateById(snapshot.projects, projectId),
  });

  return match;
}

async function recoverDuplicateStudioContainer(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  projectId: ProjectId,
): Promise<ProjectId | null> {
  return (await waitForStudioContainerInStore(api, projectId))?.id ?? null;
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
  // safe even if project rows ever become locally persisted or partially populated. Bound the
  // wait so a stuck connection surfaces a user-visible error instead of hanging forever.
  const hydrated = await waitForProjectSnapshotHydration({
    timeoutMs: PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS,
  });
  if (!hydrated) {
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
          );
          if (recoveredProjectId) {
            return recoveredProjectId;
          }
          // The root is owned by a project that isn't a Studio container (the server enforces
          // cross-kind ownership). Adopting a user's visible project into the hidden container
          // would make it vanish from Projects, so surface the conflict instead.
          throw new Error(
            `Studio can't use "${workspaceRoot}" because another project already uses that folder. Remove or move that project, then retry.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    // Make the fresh container visible in the local store before returning, so segment
    // derivation and thread partitioning never see a draft pointing at an unknown project.
    // The result matters: returning the id anyway on a slow snapshot would reopen exactly
    // that window, so fail with a retryable error instead — the retry finds the container.
    const syncedContainer = await waitForStudioContainerInStore(api, projectId, {
      maxAttempts: CREATED_CONTAINER_SYNC_MAX_ATTEMPTS,
    });
    if (!syncedContainer) {
      throw new Error("Studio was created but hasn't finished syncing yet. Try again in a moment.");
    }
    return projectId;
  })().finally(() => {
    pendingStudioCreationByWorkspaceRoot.delete(workspaceRoot);
  });

  pendingStudioCreationByWorkspaceRoot.set(workspaceRoot, creationPromise);
  return creationPromise;
}

export function prewarmStudioProject(paths: ServerWorkspacePaths): void {
  // Prewarming is best-effort. The interactive creation path reports failures;
  // background startup must not leak a rejected promise into the app or test runner.
  void ensureStudioProject(paths).catch(() => undefined);
}

export async function resetStudioProjectPrewarmStateForTests(): Promise<void> {
  const pendingCreations = [...pendingStudioCreationByWorkspaceRoot.values()];
  pendingStudioCreationByWorkspaceRoot.clear();
  await Promise.allSettled(pendingCreations);
}
