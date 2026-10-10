// FILE: threadFork.ts
// Purpose: Dispatches the fork command shared by `/fork`, message-footer forks, and thread menus.
// Layer: Web domain helper
// Exports: canForkThread, dispatchThreadFork, FORK_THREAD_TARGET_LABELS

import type {
  MessageId,
  ModelSelection,
  NativeApi,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import type { Thread } from "../types";
import { resolveForkThreadEnvironment, type ForkThreadTarget } from "./threadEnvironment";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import {
  buildThreadHandoffImportedMessages,
  hasImportableThreadMessages,
  type ThreadHandoffAvailability,
} from "./threadHandoff";
import { newCommandId, newThreadId } from "./utils";

/** Menu wording for the two fork targets, shared by every fork menu. */
export const FORK_THREAD_TARGET_LABELS: Record<ForkThreadTarget, string> = {
  local: "Fork Into Local",
  worktree: "Fork Into New Worktree",
};

/**
 * Whether a thread menu may offer Fork. A fork copies the settled transcript into a new
 * checkout-backed thread, so it needs at least one finished message (a first turn still
 * streaming would fork empty) and a thread that owns a workspace: hub and coordinator
 * threads have no checkout, and subagents and sidechats live under a parent thread.
 */
export function canForkThread(input: {
  thread: Parameters<typeof isSidechatThread>[0] & Pick<Thread, "messages" | "parentThreadId">;
  handoffAvailability: ThreadHandoffAvailability;
}): boolean {
  return (
    input.handoffAvailability.workspaceHandoff &&
    !input.thread.parentThreadId &&
    !isSidechatThread(input.thread) &&
    hasImportableThreadMessages(input.thread)
  );
}

/**
 * Creates the forked thread on the server and returns its id. Callers own the
 * shell-snapshot sync, navigation, and error surfacing for their surface.
 */
export async function dispatchThreadFork(input: {
  api: NativeApi;
  sourceThread: Thread;
  target: ForkThreadTarget;
  /** Current branch of the project's root checkout, used when the thread has no branch. */
  rootBranch: string | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /** Fork from a specific turn: imports the transcript up to (and including) this message. */
  throughMessageId?: MessageId | null;
}): Promise<ThreadId> {
  const { sourceThread } = input;
  if (input.throughMessageId) {
    const selected = sourceThread.messages.find((message) => message.id === input.throughMessageId);
    if (!selected || !hasImportableThreadMessages({ messages: [selected] })) {
      throw new Error(
        "Selected message is no longer available to fork. Refresh the chat and try again.",
      );
    }
  }
  const importedMessages = buildThreadHandoffImportedMessages(sourceThread, {
    throughMessageId: input.throughMessageId ?? null,
  });
  const nextThreadId = newThreadId();
  // Fork first, then let the normal first-send worktree bootstrap create the cwd if needed.
  const resolvedTarget = resolveForkThreadEnvironment({
    target: input.target,
    activeRootBranch: input.rootBranch,
    sourceThread,
  });

  await input.api.orchestration.dispatchCommand({
    type: "thread.fork.create",
    commandId: newCommandId(),
    threadId: nextThreadId,
    sourceThreadId: sourceThread.id,
    projectId: sourceThread.projectId,
    title: sourceThread.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    envMode: resolvedTarget.envMode,
    branch: resolvedTarget.branch,
    worktreePath: resolvedTarget.worktreePath,
    workingDirectory: sourceThread.workingDirectory ?? null,
    associatedWorktreePath: resolvedTarget.associatedWorktreePath,
    associatedWorktreeBranch: resolvedTarget.associatedWorktreeBranch,
    associatedWorktreeRef: resolvedTarget.associatedWorktreeRef,
    // The provider fork must stop at the same turn as the imported transcript.
    ...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}),
    importedMessages: [...importedMessages],
    createdAt: new Date().toISOString(),
  });
  return nextThreadId;
}
