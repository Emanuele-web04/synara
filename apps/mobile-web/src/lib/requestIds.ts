import { CompanionRequestIdTracker } from "@synara/client";
import { makeRequestId } from "./mobileLogic";

// Volatile for the lifetime of this PWA process. It survives route changes and
// reconnects, but is deliberately never persisted or recovered after a reload.
export const companionRequestIds = new CompanionRequestIdTracker(makeRequestId);

export interface PendingNewTaskIdentity {
  readonly fingerprint: string;
  readonly threadId: string;
  readonly initialTitle: string;
  created: boolean;
}

const pendingNewTasks = new Map<string, PendingNewTaskIdentity>();

export function acquirePendingNewTask(
  projectId: string,
  fingerprint: string,
  initialTitle: string,
): PendingNewTaskIdentity {
  const current = pendingNewTasks.get(projectId);
  if (current?.fingerprint === fingerprint) return current;
  if (current) companionRequestIds.clear(`initial-turn:${current.threadId}`);
  const next: PendingNewTaskIdentity = {
    fingerprint,
    threadId: crypto.randomUUID(),
    initialTitle,
    created: false,
  };
  pendingNewTasks.set(projectId, next);
  return next;
}

export function pendingNewTask(projectId: string): PendingNewTaskIdentity | undefined {
  return pendingNewTasks.get(projectId);
}

export function clearPendingNewTask(projectId: string): void {
  const current = pendingNewTasks.get(projectId);
  pendingNewTasks.delete(projectId);
  if (current) companionRequestIds.clear(`initial-turn:${current.threadId}`);
}

export function clearCompanionMutationState(): void {
  pendingNewTasks.clear();
  companionRequestIds.clear();
}
