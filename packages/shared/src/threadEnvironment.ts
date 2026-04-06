import type { ThreadEnvironmentMode } from "@t3tools/contracts";

export type ResolvedThreadWorkspaceState = "local" | "worktree-pending" | "worktree-ready";

export function resolveThreadEnvironmentMode(input: {
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
}): ThreadEnvironmentMode {
  if (input.worktreePath) {
    return "worktree";
  }
  return input.envMode ?? "local";
}

export function resolveThreadWorkspaceState(input: {
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
}): ResolvedThreadWorkspaceState {
  const mode = resolveThreadEnvironmentMode(input);
  if (mode === "local") {
    return "local";
  }
  return input.worktreePath ? "worktree-ready" : "worktree-pending";
}

export function isPendingThreadWorktree(input: {
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
}): boolean {
  return resolveThreadWorkspaceState(input) === "worktree-pending";
}

// Runtime-facing operations should only target a materialized worktree path.
export function resolveThreadWorkspaceCwd(input: {
  projectCwd?: string | null;
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
}): string | null {
  const mode = resolveThreadEnvironmentMode(input);
  if (mode === "worktree") {
    return input.worktreePath ?? null;
  }
  return input.projectCwd ?? null;
}

// Branch discovery can still use the project root before a worktree exists.
export function resolveThreadBranchSourceCwd(input: {
  projectCwd?: string | null;
  worktreePath?: string | null;
}): string | null {
  return input.worktreePath ?? input.projectCwd ?? null;
}
