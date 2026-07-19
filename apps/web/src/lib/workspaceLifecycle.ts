import {
  type NativeApi,
  type OrchestrationWorktreeWorkspace,
  WorkspaceOperationId,
} from "@synara/contracts";

import { newCommandId, randomUUID } from "./utils";

export type WorkspaceLifecycleRequestResult = "requested" | "cancelled";

export class WorkspaceLifecycleBlockedError extends Error {
  readonly blockers: readonly string[];

  constructor(blockers: readonly string[]) {
    super(blockers.join(" ") || "This workspace lifecycle action is unavailable.");
    this.name = "WorkspaceLifecycleBlockedError";
    this.blockers = blockers;
  }
}

function warningConfirmationMessage(
  workspace: Pick<OrchestrationWorktreeWorkspace, "title" | "kind">,
  warnings: readonly string[],
): string {
  const action = workspace.kind === "external" ? "Remove from Synara" : "Archive workspace";
  return [
    `${action} “${workspace.title}”?`,
    "",
    ...warnings,
    "",
    workspace.kind === "external"
      ? "The external folder and its files will remain on disk."
      : "The local branch, pull request, conversations, and workspace history will be retained.",
  ].join("\n");
}

export async function requestWorkspaceArchive(input: {
  api: NativeApi;
  workspace: OrchestrationWorktreeWorkspace;
}): Promise<WorkspaceLifecycleRequestResult> {
  const preflight = await input.api.orchestration.getWorkspaceLifecyclePreflight({
    workspaceId: input.workspace.id,
    action: "archive",
  });
  if (!preflight.canStart) {
    throw new WorkspaceLifecycleBlockedError(preflight.blockers.map((blocker) => blocker.message));
  }

  let confirmedWarnings = false;
  if (preflight.requiresConfirmation) {
    confirmedWarnings = await input.api.dialogs.confirm(
      warningConfirmationMessage(
        input.workspace,
        preflight.warnings.map((warning) => warning.message),
      ),
    );
    if (!confirmedWarnings) return "cancelled";
  }

  await input.api.orchestration.dispatchCommand({
    type: "workspace.archive.request",
    commandId: newCommandId(),
    workspaceId: input.workspace.id,
    operationId: WorkspaceOperationId.makeUnsafe(randomUUID()),
    expectedGeneration: preflight.lifecycleGeneration,
    confirmedWarnings,
    requestedAt: new Date().toISOString(),
  });
  return "requested";
}

export async function requestWorkspaceRestore(input: {
  api: NativeApi;
  workspace: OrchestrationWorktreeWorkspace;
}): Promise<WorkspaceLifecycleRequestResult> {
  const preflight = await input.api.orchestration.getWorkspaceLifecyclePreflight({
    workspaceId: input.workspace.id,
    action: "restore",
  });
  if (!preflight.canStart) {
    throw new WorkspaceLifecycleBlockedError(preflight.blockers.map((blocker) => blocker.message));
  }

  await input.api.orchestration.dispatchCommand({
    type: "workspace.restore.request",
    commandId: newCommandId(),
    workspaceId: input.workspace.id,
    operationId: WorkspaceOperationId.makeUnsafe(randomUUID()),
    expectedGeneration: preflight.lifecycleGeneration,
    requestedAt: new Date().toISOString(),
  });
  return "requested";
}
