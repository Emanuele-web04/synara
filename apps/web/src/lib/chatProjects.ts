// FILE: chatProjects.ts
// Purpose: Reuse one hidden home-scoped chat project as the backing container for chat rows.
// Layer: Web orchestration helper

import { type ProjectId } from "@t3tools/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import type { Project } from "../types";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import {
  extractDuplicateProjectCreateProjectId,
  findContainerCandidateById,
  isDuplicateProjectCreateError,
  resolveContainerCandidateCwd,
} from "./projectCreateRecovery";
import { resolveServerChatWorkspaceRoot, type ServerWorkspacePaths } from "./serverWorkspacePaths";
import { newCommandId, newProjectId } from "./utils";

const pendingHomeChatCreationByWorkspaceRoot = new Map<string, Promise<ProjectId | null>>();
const pendingHomeChatFixupByWorkspaceRoot = new Map<string, Promise<void>>();

interface HomeChatContainerCandidate {
  readonly id?: ProjectId | undefined;
  readonly kind?: Project["kind"] | undefined;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly name?: string | undefined;
  readonly remoteName?: string | undefined;
  readonly title?: string | undefined;
}

async function updateHomeChatProjectMetadata(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  projectId: ProjectId,
): Promise<void> {
  await api.orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    kind: "chat",
    title: "Home",
  });
}

function isHomeChatContainerCandidate(
  project: HomeChatContainerCandidate | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  const cwd = resolveContainerCandidateCwd(project);
  if (!cwd) {
    return false;
  }

  const title = project?.title ?? "";
  return isHomeChatContainerProject(
    {
      cwd,
      kind: project?.kind ?? "project",
      name: project?.name ?? title,
      remoteName: project?.remoteName ?? title,
    },
    paths,
  );
}

function findHomeChatContainerCandidateById<T extends HomeChatContainerCandidate>(
  projects: readonly T[],
  projectId: ProjectId,
  paths: ServerWorkspacePaths,
): T | null {
  return findContainerCandidateById(projects, projectId, (project) =>
    isHomeChatContainerCandidate(project, paths),
  );
}

async function findDuplicateHomeChatContainer(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  projectId: ProjectId,
  paths: ServerWorkspacePaths,
): Promise<HomeChatContainerCandidate | null> {
  const localProject = findHomeChatContainerCandidateById(
    useStore.getState().projects,
    projectId,
    paths,
  );
  if (localProject) {
    return localProject;
  }

  const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
  if (!snapshot) {
    return null;
  }

  return findHomeChatContainerCandidateById(snapshot.projects, projectId, paths);
}

function matchesLegacyHomeChatWorkspaceRoot(
  project: Pick<Project, "cwd">,
  input: ServerWorkspacePaths,
): boolean {
  const workspaceRoot = resolveServerChatWorkspaceRoot(input);
  const homeDir = input.homeDir?.trim() ?? "";
  if (!workspaceRoot || !homeDir) {
    return false;
  }
  return (
    workspaceRootsEqual(project.cwd, workspaceRoot) || workspaceRootsEqual(project.cwd, homeDir)
  );
}

function isManagedChatWorkspaceProject(
  project: Pick<Project, "cwd" | "kind">,
  input: ServerWorkspacePaths,
): boolean {
  const chatWorkspaceRoot = input.chatWorkspaceRoot?.trim() ?? "";
  if (!chatWorkspaceRoot || project.kind !== "chat") {
    return false;
  }
  return (
    isWorkspaceRootWithin(project.cwd, chatWorkspaceRoot) &&
    !workspaceRootsEqual(project.cwd, chatWorkspaceRoot)
  );
}

function isLegacyHomeChatContainerProject(
  project: Pick<Project, "cwd" | "kind" | "name" | "remoteName"> | null | undefined,
  input: ServerWorkspacePaths,
): boolean {
  if (!project || !input.homeDir) {
    return false;
  }
  return (
    matchesLegacyHomeChatWorkspaceRoot(project, input) &&
    (project.kind === "chat" || project.remoteName === "Home" || project.name === "Home")
  );
}

function hasThreadsForProject(projectId: ProjectId): boolean {
  const state = useStore.getState();
  return (state.threadIds ?? [])
    .map((threadId) => getThreadFromState(state, threadId))
    .some((thread) => thread?.projectId === projectId);
}

function scoreHomeChatProject(project: Project, input: ServerWorkspacePaths): number {
  const homeDir = input.homeDir?.trim() ?? "";
  let score = 0;
  if (hasThreadsForProject(project.id)) score += 8;
  if (project.kind === "chat") score += 4;
  if (homeDir && workspaceRootsEqual(project.cwd, homeDir)) score += 2;
  if (project.remoteName === "Home" || project.name === "Home") score += 1;
  return score;
}

export function findHomeChatContainerProject<
  T extends Pick<Project, "cwd" | "kind" | "name" | "remoteName">,
>(projects: readonly T[], paths: ServerWorkspacePaths): T | null {
  if (!paths.homeDir) {
    return null;
  }
  return projects.find((project) => isHomeChatContainerProject(project, paths)) ?? null;
}

function findCanonicalHomeProject(input: ServerWorkspacePaths): {
  canonicalProjectId: ProjectId | null;
  duplicateProjectIds: ProjectId[];
  needsKindFixup: boolean;
} {
  const state = useStore.getState();
  const homeProjects = state.projects.filter((project) =>
    isLegacyHomeChatContainerProject(project, input),
  );
  const canonicalProject =
    [...homeProjects].sort(
      (left, right) => scoreHomeChatProject(right, input) - scoreHomeChatProject(left, input),
    )[0] ?? null;
  if (!canonicalProject) {
    return {
      canonicalProjectId: null,
      duplicateProjectIds: [],
      needsKindFixup: false,
    };
  }

  const duplicateProjectIds = homeProjects
    .filter((project) => project.id !== canonicalProject.id)
    .flatMap((project) => {
      return hasThreadsForProject(project.id) ? [] : [project.id];
    });

  return {
    canonicalProjectId: canonicalProject.id,
    duplicateProjectIds,
    needsKindFixup: canonicalProject.kind !== "chat",
  };
}

async function fixupHomeChatProject(input: ServerWorkspacePaths): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }

  const { canonicalProjectId, duplicateProjectIds, needsKindFixup } =
    findCanonicalHomeProject(input);
  if (!canonicalProjectId) {
    return;
  }

  if (needsKindFixup) {
    await updateHomeChatProjectMetadata(api, canonicalProjectId);
  }

  for (const duplicateProjectId of duplicateProjectIds) {
    await api.orchestration.dispatchCommand({
      type: "project.delete",
      commandId: newCommandId(),
      projectId: duplicateProjectId,
    });
  }
}

function scheduleHomeChatFixup(input: ServerWorkspacePaths): void {
  const workspaceRoot = input.homeDir?.trim() ?? "";
  if (!workspaceRoot) {
    return;
  }
  if (pendingHomeChatFixupByWorkspaceRoot.has(workspaceRoot)) {
    return;
  }
  const promise = fixupHomeChatProject(input).finally(() => {
    pendingHomeChatFixupByWorkspaceRoot.delete(workspaceRoot);
  });
  pendingHomeChatFixupByWorkspaceRoot.set(workspaceRoot, promise);
}

export async function ensureHomeChatProject(
  paths: ServerWorkspacePaths,
): Promise<ProjectId | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }

  const workspaceRoot = resolveServerChatWorkspaceRoot(paths);
  const placeholderWorkspaceRoot = paths.homeDir?.trim() ?? "";
  if (!workspaceRoot || !placeholderWorkspaceRoot) {
    return null;
  }

  const { canonicalProjectId } = findCanonicalHomeProject(paths);
  if (canonicalProjectId) {
    scheduleHomeChatFixup(paths);
    return canonicalProjectId;
  }

  const pendingCreation = pendingHomeChatCreationByWorkspaceRoot.get(workspaceRoot);
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
        kind: "chat",
        title: "Home",
        workspaceRoot: placeholderWorkspaceRoot,
        createdAt: new Date().toISOString(),
      });
      return projectId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDuplicateProjectCreateError(message)) {
        const duplicateProjectId = extractDuplicateProjectCreateProjectId(message);
        if (duplicateProjectId) {
          const homeProjectId = duplicateProjectId as ProjectId;
          const duplicateProject = await findDuplicateHomeChatContainer(api, homeProjectId, paths);
          if (duplicateProject) {
            if (duplicateProject.kind !== "chat") {
              await updateHomeChatProjectMetadata(api, homeProjectId);
            }
            return homeProjectId;
          }
        }
      }
      throw error;
    }
  })().finally(() => {
    pendingHomeChatCreationByWorkspaceRoot.delete(workspaceRoot);
  });

  pendingHomeChatCreationByWorkspaceRoot.set(workspaceRoot, creationPromise);
  return creationPromise;
}

export function prewarmHomeChatProject(paths: ServerWorkspacePaths): void {
  void ensureHomeChatProject(paths);
}

export function isHomeChatContainerProject(
  project: Pick<Project, "cwd" | "kind" | "name" | "remoteName"> | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  if (!project || !paths.homeDir) {
    return false;
  }
  return (
    isManagedChatWorkspaceProject(project, paths) ||
    isLegacyHomeChatContainerProject(project, paths)
  );
}
