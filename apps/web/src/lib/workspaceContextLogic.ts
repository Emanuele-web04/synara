import type { ThreadEnvironmentMode, ThreadWorkspaceContext } from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";

import type { ThreadWorkspacePatch } from "../types";

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
