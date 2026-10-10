// the composer owns the full sidechat flow incl. the selected model; the dock lives outside ChatView so the composer publishes its creator keyed by host thread id — only threads that can offer /side register

import type { ThreadId } from "@synara/contracts";

export type SidechatCreator = (options?: { initialPrompt?: string }) => Promise<unknown>;

const creatorsByThreadId = new Map<ThreadId, SidechatCreator>();
const waitersByThreadId = new Map<ThreadId, Set<(creator: SidechatCreator | undefined) => void>>();

function notifyCreatorWaiters(threadId: ThreadId, creator: SidechatCreator | undefined): void {
  const waiters = waitersByThreadId.get(threadId);
  if (!waiters) return;
  waitersByThreadId.delete(threadId);
  for (const resolve of waiters) resolve(creator);
}

export function registerSidechatCreator(threadId: ThreadId, creator: SidechatCreator): () => void {
  creatorsByThreadId.set(threadId, creator);
  notifyCreatorWaiters(threadId, creator);
  return () => {
    if (creatorsByThreadId.get(threadId) === creator) {
      creatorsByThreadId.delete(threadId);
    }
  };
}

export function getSidechatCreator(threadId: ThreadId): SidechatCreator | undefined {
  return creatorsByThreadId.get(threadId);
}

// the dock can render one commit before the nested composer publishes — wait briefly for that normal mount ordering instead of a flaky "unavailable"
export function waitForSidechatCreator(
  threadId: ThreadId,
  timeoutMs = 500,
): Promise<SidechatCreator | undefined> {
  const creator = getSidechatCreator(threadId);
  if (creator) return Promise.resolve(creator);

  return new Promise((resolve) => {
    const waiters = waitersByThreadId.get(threadId) ?? new Set();
    const finish = (nextCreator: SidechatCreator | undefined) => {
      globalThis.clearTimeout(timeoutId);
      resolve(nextCreator);
    };
    waiters.add(finish);
    waitersByThreadId.set(threadId, waiters);
    const timeoutId = globalThis.setTimeout(() => {
      const pending = waitersByThreadId.get(threadId);
      pending?.delete(finish);
      if (pending?.size === 0) waitersByThreadId.delete(threadId);
      resolve(undefined);
    }, timeoutMs);
  });
}
