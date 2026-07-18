// FILE: managedWorkspace.ts
// Purpose: Waits for server-owned workspace provisioning before a conversation starts a turn.

import type {
  OrchestrationWorkspaceShellSnapshot,
  OrchestrationWorktreeWorkspace,
  ThreadId,
  WorktreeWorkspaceId,
} from "@synara/contracts";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROJECTION_TIMEOUT_MS = 10_000;

function provisioningFailureMessage(workspace: OrchestrationWorktreeWorkspace): string {
  const detail =
    workspace.lastFailure?.summary ?? workspace.setupError ?? "Workspace provisioning failed.";
  const stage = workspace.lastFailure?.stage;
  return stage ? `Workspace provisioning failed during ${stage}: ${detail}` : detail;
}

export async function waitForManagedWorkspaceReady(input: {
  workspaceId: WorktreeWorkspaceId;
  loadSnapshot: () => Promise<OrchestrationWorkspaceShellSnapshot>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<OrchestrationWorktreeWorkspace & { path: string; branch: string }> {
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(pollIntervalMs, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const sleep =
    input.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  let lastWorkspace: OrchestrationWorktreeWorkspace | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    const workspace = snapshot.workspaces.find((entry) => entry.id === input.workspaceId) ?? null;
    lastWorkspace = workspace;

    if (workspace?.state === "ready") {
      if (!workspace.path || !workspace.branch) {
        throw new Error("Workspace became ready without a path or branch.");
      }
      return workspace as OrchestrationWorktreeWorkspace & { path: string; branch: string };
    }

    if (
      workspace &&
      (workspace.state === "setup-failed" ||
        workspace.state === "missing" ||
        workspace.state === "archived" ||
        workspace.state === "error")
    ) {
      throw new Error(provisioningFailureMessage(workspace));
    }

    if (attempt + 1 < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  const state = lastWorkspace?.state ?? "not visible";
  throw new Error(`Workspace provisioning timed out (last state: ${state}).`);
}

export async function waitForWorkspaceConversationSnapshot(input: {
  workspaceId: WorktreeWorkspaceId;
  threadId: ThreadId;
  loadSnapshot: () => Promise<OrchestrationWorkspaceShellSnapshot>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<OrchestrationWorkspaceShellSnapshot> {
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(pollIntervalMs, input.timeoutMs ?? DEFAULT_PROJECTION_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const sleep =
    input.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await input.loadSnapshot();
    const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
    if (thread?.workspaceId === input.workspaceId) {
      return snapshot;
    }

    if (attempt + 1 < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  throw new Error("Workspace conversation did not appear in the server read model.");
}
