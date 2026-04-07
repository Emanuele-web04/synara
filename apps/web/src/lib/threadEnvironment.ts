// FILE: threadEnvironment.ts
// Purpose: Shared helpers for deriving thread environment intent and fork targets.
// Layer: Web domain helpers
// Exports: thread env resolution + `/fork` target planning

import type { ThreadEnvironmentMode } from "@t3tools/contracts";
import { resolveThreadEnvironmentMode } from "@t3tools/shared/threadEnvironment";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import type { Thread } from "../types";

export type ForkThreadTarget = "local" | "worktree";

export interface ResolvedForkThreadEnvironment {
  target: ForkThreadTarget;
  envMode: ThreadEnvironmentMode;
  branch: string | null;
  worktreePath: string | null;
  associatedWorktreePath: string | null;
  associatedWorktreeBranch: string | null;
  associatedWorktreeRef: string | null;
}

export {
  isPendingThreadWorktree,
  resolveThreadEnvironmentMode,
  resolveThreadWorkspaceState,
} from "@t3tools/shared/threadEnvironment";

// Fork planning keeps "local" attached to the current local checkout. For worktree-backed
// threads that means reusing the existing worktree, while "worktree" always plans a new one.
export function resolveForkThreadEnvironment(input: {
  target: ForkThreadTarget;
  activeRootBranch: string | null;
  sourceThread: Pick<
    Thread,
    | "branch"
    | "envMode"
    | "worktreePath"
    | "associatedWorktreePath"
    | "associatedWorktreeBranch"
    | "associatedWorktreeRef"
  >;
}): ResolvedForkThreadEnvironment {
  const sourceEnvMode = resolveThreadEnvironmentMode({
    envMode: input.sourceThread.envMode,
    worktreePath: input.sourceThread.worktreePath,
  });
  const sourceBranch = input.sourceThread.branch ?? input.activeRootBranch;
  const sourceWorktreePath = input.sourceThread.worktreePath ?? null;
  const sourceAssociatedWorktreePath =
    input.sourceThread.associatedWorktreePath ?? sourceWorktreePath;
  const sourceAssociatedWorktreeBranch =
    input.sourceThread.associatedWorktreeBranch ?? sourceBranch;
  const sourceAssociatedWorktreeRef =
    input.sourceThread.associatedWorktreeRef ?? sourceAssociatedWorktreeBranch;

  if (input.target === "worktree") {
    const associatedWorktree = deriveAssociatedWorktreeMetadata({
      associatedWorktreePath: null,
      associatedWorktreeBranch: sourceBranch,
      associatedWorktreeRef: sourceAssociatedWorktreeRef ?? sourceBranch,
    });
    return {
      target: "worktree",
      envMode: "worktree",
      branch: sourceBranch,
      worktreePath: null,
      ...associatedWorktree,
    };
  }

  // Codex-style "Fork Into Local" stays in the current local checkout, which for a
  // worktree-backed thread means reusing that worktree rather than bouncing to root.
  if (sourceEnvMode === "worktree" && sourceWorktreePath) {
    const associatedWorktree = deriveAssociatedWorktreeMetadata({
      branch: sourceBranch,
      worktreePath: sourceWorktreePath,
      associatedWorktreePath: sourceAssociatedWorktreePath,
      associatedWorktreeBranch: sourceAssociatedWorktreeBranch,
      associatedWorktreeRef: sourceAssociatedWorktreeRef,
    });
    return {
      target: "local",
      envMode: "worktree",
      branch: sourceBranch,
      worktreePath: sourceWorktreePath,
      ...associatedWorktree,
    };
  }

  const associatedWorktree = deriveAssociatedWorktreeMetadata({
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
  });
  return {
    target: "local",
    envMode: "local",
    branch: sourceBranch,
    worktreePath: null,
    ...associatedWorktree,
  };
}
