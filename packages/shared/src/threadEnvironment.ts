import type { ProjectId, ThreadEnvironmentMode, ThreadWorkspaceContext } from "@t3tools/contracts";

export type ResolvedThreadWorkspaceState = "local" | "worktree-pending" | "worktree-ready";

export function resolveThreadEnvironmentMode(input: {
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
}): ThreadEnvironmentMode {
  if (input.worktreePath) {
    return "worktree";
  }
  return input.envMode ?? "local";
}

export function resolveThreadWorkspaceState(input: {
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
}): ResolvedThreadWorkspaceState {
  const mode = resolveThreadEnvironmentMode(input);
  if (mode === "local") {
    return "local";
  }
  return input.worktreePath ? "worktree-ready" : "worktree-pending";
}

export function isPendingThreadWorktree(input: {
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
}): boolean {
  return resolveThreadWorkspaceState(input) === "worktree-pending";
}

// Runtime-facing operations should only target a materialized worktree path.
export function resolveThreadWorkspaceCwd(input: {
  projectCwd?: string | null | undefined;
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
}): string | null {
  const mode = resolveThreadEnvironmentMode(input);
  if (mode === "worktree") {
    return input.worktreePath ?? null;
  }
  return input.projectCwd ?? null;
}

// Branch discovery can still use the project root before a worktree exists.
export function resolveThreadBranchSourceCwd(input: {
  projectCwd?: string | null | undefined;
  worktreePath?: string | null | undefined;
}): string | null {
  return input.worktreePath ?? input.projectCwd ?? null;
}

export interface ThreadWorkspaceContextProject {
  id: ProjectId;
  kind?: "project" | "chat" | undefined;
  workspaceRoot: string;
}

export function buildPrimaryThreadWorkspaceContext(input: {
  id?: string | null | undefined;
  projectId: ProjectId;
  envMode?: ThreadEnvironmentMode | null | undefined;
  branch?: string | null | undefined;
  worktreePath?: string | null | undefined;
}): ThreadWorkspaceContext {
  return {
    id: input.id ?? "primary",
    projectId: input.projectId,
    label: null,
    role: "primary",
    accessMode: "read-write",
    cwd: null,
    envMode: input.envMode ?? "local",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
  };
}

export function resolveThreadPrimaryWorkspaceContext(input: {
  projectId: ProjectId;
  envMode?: ThreadEnvironmentMode | null | undefined;
  branch?: string | null | undefined;
  worktreePath?: string | null | undefined;
  workspaceContexts?: ReadonlyArray<ThreadWorkspaceContext> | null | undefined;
  activeWorkspaceContextId?: string | null | undefined;
}): ThreadWorkspaceContext {
  const contexts = input.workspaceContexts ?? [];
  const active =
    (input.activeWorkspaceContextId
      ? contexts.find((context) => context.id === input.activeWorkspaceContextId)
      : null) ?? contexts.find((context) => context.role === "primary");
  return (
    active ??
    buildPrimaryThreadWorkspaceContext({
      projectId: input.projectId,
      envMode: input.envMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
    })
  );
}

export function resolveWorkspaceContextCwd(input: {
  context: ThreadWorkspaceContext;
  projects: ReadonlyArray<ThreadWorkspaceContextProject>;
}): string | null {
  const project = input.projects.find((entry) => entry.id === input.context.projectId);
  const projectCwd =
    project?.kind === "chat" && !input.context.worktreePath
      ? null
      : (project?.workspaceRoot ?? null);
  return resolveThreadWorkspaceCwd({
    projectCwd,
    envMode: input.context.envMode,
    worktreePath: input.context.worktreePath,
  }) ?? input.context.cwd ?? null;
}

export function resolveThreadWorkspaceContexts(input: {
  projectId: ProjectId;
  envMode?: ThreadEnvironmentMode | null | undefined;
  branch?: string | null | undefined;
  worktreePath?: string | null | undefined;
  workspaceContexts?: ReadonlyArray<ThreadWorkspaceContext> | null | undefined;
  activeWorkspaceContextId?: string | null | undefined;
}): ThreadWorkspaceContext[] {
  const contexts = [...(input.workspaceContexts ?? [])];
  if (contexts.length > 0) {
    return contexts;
  }
  return [
    buildPrimaryThreadWorkspaceContext({
      projectId: input.projectId,
      envMode: input.envMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
    }),
  ];
}

export function resolveThreadWorkspaceCwds(input: {
  projectId: ProjectId;
  envMode?: ThreadEnvironmentMode | null | undefined;
  branch?: string | null | undefined;
  worktreePath?: string | null | undefined;
  workspaceContexts?: ReadonlyArray<ThreadWorkspaceContext> | null | undefined;
  activeWorkspaceContextId?: string | null | undefined;
  projects: ReadonlyArray<ThreadWorkspaceContextProject>;
}): Array<{ context: ThreadWorkspaceContext; cwd: string | null; primary: boolean }> {
  const primary = resolveThreadPrimaryWorkspaceContext(input);
  return resolveThreadWorkspaceContexts(input).map((context) => ({
    context: {
      ...context,
      cwd: resolveWorkspaceContextCwd({ context, projects: input.projects }),
    },
    cwd: resolveWorkspaceContextCwd({ context, projects: input.projects }),
    primary: context.id === primary.id,
  }));
}
