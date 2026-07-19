// FILE: pullRequestWorkspace.ts
// Purpose: Coordinates the durable one-PR-to-one-workspace flow for every web entry point.

import {
  type GitResolvedPullRequest,
  type ModelSelection,
  type NativeApi,
  type OrchestrationThreadPullRequest,
  type OrchestrationWorkspaceShellSnapshot,
  type OrchestrationWorktreeWorkspace,
  type ProviderKind,
  type ThreadId,
  WorkspaceOperationId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { findWorkspaceForPullRequest } from "@synara/shared/pullRequest";

import type { Project } from "../types";
import {
  waitForManagedWorkspaceReady,
  waitForWorkspaceConversationSnapshot,
} from "./managedWorkspace";
import { requestWorkspaceRestore } from "./workspaceLifecycle";
import { newCommandId, newThreadId, randomUUID } from "./utils";

export type PullRequestWorkspaceIntent = "open" | "new-conversation";

export interface PullRequestWorkspaceResult {
  association: "created" | "active" | "restored";
  pullRequest: OrchestrationThreadPullRequest;
  workspace: OrchestrationWorktreeWorkspace;
  threadId: ThreadId;
  snapshot: OrchestrationWorkspaceShellSnapshot;
}

export function resolvePullRequestWorkspaceModelSelection(input: {
  project: Pick<Project, "defaultModelSelection">;
  defaultProvider: ProviderKind;
}): ModelSelection {
  if (input.project.defaultModelSelection) return input.project.defaultModelSelection;
  const model = getDefaultModel(input.defaultProvider);
  if (!model) throw new Error("Choose a default model before opening a pull request workspace.");
  return { provider: input.defaultProvider, model };
}

export function pullRequestWorkspaceMetadata(
  pullRequest: GitResolvedPullRequest | OrchestrationThreadPullRequest,
): OrchestrationThreadPullRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft ?? false,
    mergeability: pullRequest.mergeability ?? "unknown",
    additions: pullRequest.additions ?? null,
    deletions: pullRequest.deletions ?? null,
    changedFiles: pullRequest.changedFiles ?? null,
  };
}

function workspaceThreads(
  snapshot: OrchestrationWorkspaceShellSnapshot,
  workspaceId: WorktreeWorkspaceId,
) {
  return snapshot.threads.filter((thread) => thread.workspaceId === workspaceId);
}

async function createConversation(input: {
  api: NativeApi;
  workspaceId: WorktreeWorkspaceId;
  title: string;
  modelSelection: ModelSelection;
}): Promise<{ threadId: ThreadId; snapshot: OrchestrationWorkspaceShellSnapshot }> {
  const threadId = newThreadId();
  await input.api.orchestration.dispatchCommand({
    type: "workspace.conversation.create",
    commandId: newCommandId(),
    workspaceId: input.workspaceId,
    threadId,
    title: input.title.trim() || "New review conversation",
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  return {
    threadId,
    snapshot: await waitForWorkspaceConversationSnapshot({
      workspaceId: input.workspaceId,
      threadId,
      loadSnapshot: () => input.api.orchestration.getWorkspaceShellSnapshot(),
    }),
  };
}

async function readyWorkspaceSnapshot(input: {
  api: NativeApi;
  workspace: OrchestrationWorktreeWorkspace;
}): Promise<OrchestrationWorkspaceShellSnapshot> {
  if (input.workspace.state !== "ready") {
    await waitForManagedWorkspaceReady({
      workspaceId: input.workspace.id,
      loadSnapshot: () => input.api.orchestration.getWorkspaceShellSnapshot(),
    });
  }
  return input.api.orchestration.getWorkspaceShellSnapshot();
}

async function retryFailedPullRequestProvision(input: {
  api: NativeApi;
  workspace: OrchestrationWorktreeWorkspace;
}): Promise<void> {
  try {
    await input.api.orchestration.dispatchCommand({
      type: "workspace.provision.request",
      commandId: newCommandId(),
      workspaceId: input.workspace.id,
      operationId: WorkspaceOperationId.makeUnsafe(randomUUID()),
      expectedGeneration: input.workspace.lifecycleGeneration,
      requestedAt: new Date().toISOString(),
    });
  } catch (error) {
    // A second entry point can win the generation-fenced retry race. Continue only when the
    // server's durable state proves that provisioning already restarted or completed.
    const snapshot = await input.api.orchestration.getWorkspaceShellSnapshot();
    const current = snapshot.workspaces.find((workspace) => workspace.id === input.workspace.id);
    if (current?.state !== "provisioning" && current?.state !== "ready") throw error;
  }
}

async function useExistingWorkspace(input: {
  api: NativeApi;
  workspace: OrchestrationWorktreeWorkspace;
  pullRequest: OrchestrationThreadPullRequest;
  modelSelection: ModelSelection;
  intent: PullRequestWorkspaceIntent;
  conversationTitle: string;
  preferredThreadId?: ThreadId | null;
}): Promise<PullRequestWorkspaceResult> {
  let association: PullRequestWorkspaceResult["association"] = "active";
  const archived = input.workspace.state === "archived" || input.workspace.archivedAt !== null;
  if (archived) {
    const restore = await requestWorkspaceRestore({ api: input.api, workspace: input.workspace });
    if (restore === "cancelled") throw new Error("Workspace restore was cancelled.");
    association = "restored";
  } else if (input.workspace.state === "archiving") {
    throw new Error("This pull request workspace is still being archived. Try again shortly.");
  } else if (input.workspace.state === "error" || input.workspace.state === "setup-failed") {
    await retryFailedPullRequestProvision({ api: input.api, workspace: input.workspace });
  }

  let snapshot = await readyWorkspaceSnapshot({ api: input.api, workspace: input.workspace });
  const projectedWorkspace =
    snapshot.workspaces.find((workspace) => workspace.id === input.workspace.id) ?? input.workspace;
  const threads = workspaceThreads(snapshot, projectedWorkspace.id);
  const preferred = input.preferredThreadId
    ? threads.find((thread) => thread.id === input.preferredThreadId)
    : null;

  if (input.intent === "new-conversation" || (!preferred && threads.length === 0)) {
    const created = await createConversation({
      api: input.api,
      workspaceId: projectedWorkspace.id,
      title: input.conversationTitle,
      modelSelection: input.modelSelection,
    });
    snapshot = created.snapshot;
    return {
      association,
      pullRequest: input.pullRequest,
      workspace:
        snapshot.workspaces.find((workspace) => workspace.id === projectedWorkspace.id) ??
        projectedWorkspace,
      threadId: created.threadId,
      snapshot,
    };
  }

  return {
    association,
    pullRequest: input.pullRequest,
    workspace: projectedWorkspace,
    threadId: (preferred ?? threads[0])!.id,
    snapshot,
  };
}

export async function openPullRequestWorkspace(input: {
  api: NativeApi;
  project: Project;
  defaultProvider: ProviderKind;
  intent: PullRequestWorkspaceIntent;
  title?: string;
  conversationTitle?: string;
  reference?: string;
  pullRequest?: GitResolvedPullRequest | OrchestrationThreadPullRequest;
  preferredThreadId?: ThreadId | null;
  onSnapshot?: (snapshot: OrchestrationWorkspaceShellSnapshot) => void;
}): Promise<PullRequestWorkspaceResult> {
  if (!input.pullRequest && !input.reference?.trim()) {
    throw new Error("A pull request reference is required.");
  }
  const pullRequest = pullRequestWorkspaceMetadata(
    input.pullRequest ??
      (
        await input.api.git.resolvePullRequest({
          cwd: input.project.cwd,
          reference: input.reference!,
          ...(input.project.githubAccount ? { account: input.project.githubAccount } : {}),
        })
      ).pullRequest,
  );
  const modelSelection = resolvePullRequestWorkspaceModelSelection({
    project: input.project,
    defaultProvider: input.defaultProvider,
  });
  const initialSnapshot = await input.api.orchestration.getWorkspaceShellSnapshot();
  const existing = findWorkspaceForPullRequest(
    initialSnapshot.workspaces,
    input.project.id,
    pullRequest,
  );
  const conversationTitle = input.conversationTitle?.trim() || `Review PR #${pullRequest.number}`;

  if (existing) {
    const result = await useExistingWorkspace({
      api: input.api,
      workspace: existing,
      pullRequest,
      modelSelection,
      intent: input.intent,
      conversationTitle,
      ...(input.preferredThreadId !== undefined
        ? { preferredThreadId: input.preferredThreadId }
        : {}),
    });
    input.onSnapshot?.(result.snapshot);
    return result;
  }

  const workspaceId = WorktreeWorkspaceId.makeUnsafe(randomUUID());
  const threadId = newThreadId();
  try {
    await input.api.orchestration.dispatchCommand({
      type: "workspace.create",
      commandId: newCommandId(),
      workspaceId,
      threadId,
      projectId: input.project.id,
      operationId: WorkspaceOperationId.makeUnsafe(randomUUID()),
      title: input.title?.trim() || pullRequest.title,
      targetRef: pullRequest.baseBranch,
      branch: pullRequest.headBranch,
      sourceKind: "pull-request",
      sourceRef: pullRequest.url,
      lastKnownPr: pullRequest,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // Another entry point may have reserved the same PR after our read. The server is the
    // authority; recover by opening that durable reservation instead of retrying Git work.
    const racedSnapshot = await input.api.orchestration.getWorkspaceShellSnapshot();
    const racedWorkspace = findWorkspaceForPullRequest(
      racedSnapshot.workspaces,
      input.project.id,
      pullRequest,
    );
    if (!racedWorkspace) throw error;
    const result = await useExistingWorkspace({
      api: input.api,
      workspace: racedWorkspace,
      pullRequest,
      modelSelection,
      intent: input.intent,
      conversationTitle,
      ...(input.preferredThreadId !== undefined
        ? { preferredThreadId: input.preferredThreadId }
        : {}),
    });
    input.onSnapshot?.(result.snapshot);
    return result;
  }

  await waitForWorkspaceConversationSnapshot({
    workspaceId,
    threadId,
    loadSnapshot: () => input.api.orchestration.getWorkspaceShellSnapshot(),
  });
  await waitForManagedWorkspaceReady({
    workspaceId,
    loadSnapshot: () => input.api.orchestration.getWorkspaceShellSnapshot(),
  });
  const snapshot = await input.api.orchestration.getWorkspaceShellSnapshot();
  const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("The pull request workspace was not projected after creation.");
  const result = {
    association: "created" as const,
    pullRequest,
    workspace,
    threadId,
    snapshot,
  };
  input.onSnapshot?.(snapshot);
  return result;
}
