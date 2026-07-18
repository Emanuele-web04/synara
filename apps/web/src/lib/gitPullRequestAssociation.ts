import {
  type NativeApi,
  type OrchestrationThreadPullRequest,
  type ThreadId,
  type WorktreeWorkspaceId,
} from "@synara/contracts";

import { newCommandId } from "./utils";

export function pullRequestAssociationKey(pullRequest: OrchestrationThreadPullRequest): string {
  return JSON.stringify(pullRequest);
}

export function pullRequestAssociationsEqual(
  left: OrchestrationThreadPullRequest | null,
  right: OrchestrationThreadPullRequest | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.baseBranch === right.baseBranch &&
    left.headBranch === right.headBranch &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.mergeability === right.mergeability &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.changedFiles === right.changedFiles
  );
}

export function resolvePullRequestAssociation(input: {
  live: OrchestrationThreadPullRequest | null;
  persisted: OrchestrationThreadPullRequest | null;
  liveUnavailable: boolean;
}): OrchestrationThreadPullRequest | null {
  return input.live ?? (input.liveUnavailable ? input.persisted : null);
}

export async function persistPullRequestAssociation(input: {
  api: NativeApi;
  threadId: ThreadId;
  workspaceId: WorktreeWorkspaceId | null;
  pullRequest: OrchestrationThreadPullRequest;
  updatedAt?: string;
}): Promise<void> {
  if (input.workspaceId) {
    await input.api.orchestration.dispatchCommand({
      type: "workspace.meta.update",
      commandId: newCommandId(),
      workspaceId: input.workspaceId,
      lastKnownPr: input.pullRequest,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
    return;
  }

  await input.api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: input.threadId,
    lastKnownPr: input.pullRequest,
  });
}
