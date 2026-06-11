// FILE: chatProjects.ts
// Purpose: Reuse one hidden home-scoped chat project as the backing container for chat rows.
// Layer: Web orchestration helper

import { type ProjectId } from "@t3tools/contracts";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import type { Project } from "../types";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import {
  resolveServerChatWorkspaceRoot,
  type ServerWorkspacePaths,
} from "./serverWorkspacePaths";
import { newCommandId, newProjectId } from "./utils";

const pendingHomeChatCreationByWorkspaceRoot = new Map<string, Promise<ProjectId | null>>();
const pendingHomeChatFixupByWorkspaceRoot = new Map<string, Promise<void>>();

function matchesHomeChatWorkspaceRoot(
  project: Pick<Project, "cwd">,
  input: ServerWorkspacePaths,
): boolean {
  const workspaceRoot = resolveServerChatWorkspaceRoot(input);
  const homeDir = input.homeDir?.trim() ?? "";
  if (!workspaceRoot || !homeDir) {
    return false;
  }
  return (
    workspaceRootsEqual(project.cwd, workspaceRoot) ||
    workspaceRootsEqual(project.cwd, homeDir)
  );
}

function hasThreadsForProject(projectId: ProjectId): boolean {
  const state = useStore.getState();
  return (state.threadIds ?? [])
    .map((threadId) => getThreadFromState(state, threadId))
    .some((thread) => thread?.projectId === projectId);
}

function scoreHomeChatProject(project: Project, input: ServerWorkspacePaths): number {
  const workspaceRoot = resolveServerChatWorkspaceRoot(input);
  let score = 0;
  if (hasThreadsForProject(project.id)) score += 8;
  if (project.kind === "chat") score += 4;
  if (workspaceRoot && workspaceRootsEqual(project.cwd, workspaceRoot)) score += 2;
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
  needsWorkspaceRootFixup: boolean;
} {
  const state = useStore.getState();
  const homeProjects = state.projects.filter((project) =>
    isHomeChatContainerProject(project, input),
  );
  const workspaceRoot = resolveServerChatWorkspaceRoot(input);
  const canonicalProject =
    [...homeProjects].sort(
      (left, right) =>
        scoreHomeChatProject(right, input) - scoreHomeChatProject(left, input),
    )[0] ?? null;
  if (!canonicalProject) {
    return {
      canonicalProjectId: null,
      duplicateProjectIds: [],
      needsKindFixup: false,
      needsWorkspaceRootFixup: false,
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
    needsWorkspaceRootFixup: Boolean(
      workspaceRoot && !workspaceRootsEqual(canonicalProject.cwd, workspaceRoot),
    ),
  };
}

async function fixupHomeChatProject(input: ServerWorkspacePaths): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }

  const { canonicalProjectId, duplicateProjectIds, needsKindFixup, needsWorkspaceRootFixup } =
    findCanonicalHomeProject(input);
  if (!canonicalProjectId) {
    return;
  }

  const targetWorkspaceRoot = needsWorkspaceRootFixup ? resolveServerChatWorkspaceRoot(input) : null;
  if (needsWorkspaceRootFixup && !targetWorkspaceRoot) {
    return;
  }

  if (needsKindFixup || needsWorkspaceRootFixup) {
    const workspaceRootPatch:
      | { readonly workspaceRoot: string; readonly createWorkspaceRootIfMissing: true }
      | Record<string, never> =
      needsWorkspaceRootFixup && targetWorkspaceRoot
        ? {
            workspaceRoot: targetWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
          }
        : {};
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId: canonicalProjectId,
      kind: "chat",
      ...(needsKindFixup ? { title: "Home" } : {}),
      ...workspaceRootPatch,
    });
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
  const workspaceRoot = resolveServerChatWorkspaceRoot(input);
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

export async function ensureHomeChatProject(paths: ServerWorkspacePaths): Promise<ProjectId | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }

  const workspaceRoot = resolveServerChatWorkspaceRoot(paths);
  if (!workspaceRoot || !paths.homeDir) {
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
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "chat",
      title: "Home",
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      createdAt: new Date().toISOString(),
    });
    return projectId;
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
    matchesHomeChatWorkspaceRoot(project, paths) &&
    (project.kind === "chat" || project.remoteName === "Home" || project.name === "Home")
  );
}
