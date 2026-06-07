import type { ProjectId, ThreadEnvironmentMode, ThreadWorkspaceContext } from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";

import type { ThreadWorkspacePatch } from "../types";

export interface WorkspaceContextProject {
  id: ProjectId;
  name: string;
  folderName: string;
  cwd: string;
}

export function workspaceContextSignature(
  context: Pick<ThreadWorkspaceContext, "projectId" | "envMode" | "branch" | "worktreePath">,
): string {
  return [
    context.projectId,
    context.envMode ?? "local",
    context.branch ?? "",
    context.worktreePath ?? "",
  ].join("|");
}

export function hasWorkspaceContextSignature(
  contexts: readonly ThreadWorkspaceContext[],
  signature: Pick<ThreadWorkspaceContext, "projectId" | "envMode" | "branch" | "worktreePath">,
  excludeContextId?: string,
): boolean {
  const target = workspaceContextSignature(signature);
  return contexts.some(
    (context) =>
      context.id !== excludeContextId && workspaceContextSignature(context) === target,
  );
}

export function buildWorkspaceContextId(input: {
  projectId: ProjectId;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: ThreadEnvironmentMode;
}): string {
  const envMode = input.envMode ?? (input.worktreePath ? "worktree" : "local");
  if (input.worktreePath) {
    return `project:${input.projectId}:worktree:${encodeURIComponent(input.worktreePath)}`;
  }
  const branch = input.branch ?? "default";
  return `project:${input.projectId}:${envMode}:${encodeURIComponent(branch)}`;
}

export function formatWorkspaceContextLabel(
  projectLabel: string,
  branch: string | null,
  worktreePath: string | null,
): string {
  if (branch) {
    return `${projectLabel} (${branch})`;
  }
  if (worktreePath) {
    return `${projectLabel} (worktree)`;
  }
  return projectLabel;
}

export function buildProjectWorkspaceContext(input: {
  project: WorkspaceContextProject;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: ThreadEnvironmentMode;
  role?: ThreadWorkspaceContext["role"];
  id?: string;
}): ThreadWorkspaceContext {
  const envMode = input.envMode ?? (input.worktreePath ? "worktree" : "local");
  const branch = input.branch ?? null;
  const worktreePath = input.worktreePath ?? null;
  const projectLabel = input.project.name || input.project.folderName || "Workspace";
  const cwd =
    resolveThreadWorkspaceCwd({
      projectCwd: input.project.cwd,
      envMode,
      worktreePath,
    }) ?? input.project.cwd;

  return {
    id:
      input.id ??
      buildWorkspaceContextId({
        projectId: input.project.id,
        branch,
        worktreePath,
        envMode,
      }),
    projectId: input.project.id,
    label: formatWorkspaceContextLabel(projectLabel, branch, worktreePath),
    role: input.role ?? "context",
    accessMode: "read-write",
    cwd,
    envMode,
    branch,
    worktreePath,
  };
}

export function patchThreadWorkspaceContext(
  context: ThreadWorkspaceContext,
  projectCwd: string,
  patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
): ThreadWorkspaceContext {
  const branch = patch.branch !== undefined ? patch.branch : context.branch;
  const worktreePath =
    patch.worktreePath !== undefined ? patch.worktreePath : context.worktreePath;
  const envMode: ThreadEnvironmentMode =
    patch.envMode !== undefined
      ? patch.envMode
      : worktreePath
        ? "worktree"
        : (context.envMode ?? "local");
  const cwd =
    resolveThreadWorkspaceCwd({
      projectCwd,
      envMode,
      worktreePath,
    }) ?? projectCwd;

  return {
    ...context,
    branch,
    worktreePath,
    envMode,
    cwd,
  };
}

export function updateThreadWorkspaceContext(
  contexts: readonly ThreadWorkspaceContext[],
  contextId: string,
  projectCwd: string,
  patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
): ThreadWorkspaceContext[] {
  return contexts.map((context) =>
    context.id === contextId ? patchThreadWorkspaceContext(context, projectCwd, patch) : context,
  );
}
