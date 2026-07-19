import type {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationWorktreeWorkspace,
} from "@synara/contracts";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";

export function resolveWorkspaceExecutionCwd(input: {
  readonly thread: Pick<
    OrchestrationThread,
    "projectId" | "workspaceId" | "envMode" | "worktreePath"
  >;
  readonly project: OrchestrationProjectShell;
  readonly workspace: OrchestrationWorktreeWorkspace | undefined;
}): string | undefined {
  if (input.thread.workspaceId != null) {
    if (
      !input.workspace ||
      input.workspace.projectId !== input.thread.projectId ||
      input.workspace.state !== "ready"
    ) {
      return undefined;
    }
    return input.workspace.path ?? undefined;
  }

  return resolveThreadWorkspaceCwd({
    thread: input.thread,
    projects: [input.project],
  });
}
