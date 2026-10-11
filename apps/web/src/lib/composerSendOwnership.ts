// Composer sends outlive route changes, including worktree preparation. Keep
// ownership by thread until the whole attempt settles, with no time-based expiry.
import type { ThreadId } from "@synara/contracts";

const sendsByThreadId = new Map<ThreadId, Promise<boolean>>();
const listeners = new Set<() => void>();
let activeThreadIds: ReadonlySet<ThreadId> = new Set();

export function subscribeComposerSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveComposerSendThreadIds(): ReadonlySet<ThreadId> {
  return activeThreadIds;
}

function notifyComposerSends(): void {
  activeThreadIds = new Set(sendsByThreadId.keys());
  for (const listener of listeners) listener();
}

export function hasActiveComposerSend(threadId: ThreadId): boolean {
  return sendsByThreadId.has(threadId);
}

export function runComposerSendOnce(
  threadId: ThreadId,
  send: () => Promise<boolean>,
): Promise<boolean> {
  const existing = sendsByThreadId.get(threadId);
  if (existing) return existing;

  const operation = Promise.resolve()
    .then(send)
    .finally(() => {
      if (sendsByThreadId.get(threadId) === operation) {
        sendsByThreadId.delete(threadId);
        notifyComposerSends();
      }
    });
  sendsByThreadId.set(threadId, operation);
  notifyComposerSends();
  return operation;
}
