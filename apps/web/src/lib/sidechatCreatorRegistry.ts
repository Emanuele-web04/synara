// FILE: sidechatCreatorRegistry.ts
// Purpose: Bridge the composer's /side creation logic to the right-dock "+" button.
// Layer: Chat capability registry
// Exports: register/get for a per-host-thread sidechat creator.
//
// The composer (inside ChatView) owns the full sidechat-creation flow, including the
// user's currently selected model. The right dock lives outside ChatView, so instead
// of duplicating that flow we let the composer publish its creator keyed by host
// thread id and have the dock invoke it. Only threads that can offer /side register.

import type { ThreadId } from "@synara/contracts";

export type SidechatCreator = (options?: { initialPrompt?: string }) => Promise<unknown>;

const creatorsByThreadId = new Map<ThreadId, SidechatCreator>();

export function registerSidechatCreator(threadId: ThreadId, creator: SidechatCreator): () => void {
  creatorsByThreadId.set(threadId, creator);
  return () => {
    if (creatorsByThreadId.get(threadId) === creator) {
      creatorsByThreadId.delete(threadId);
    }
  };
}

export function getSidechatCreator(threadId: ThreadId): SidechatCreator | undefined {
  return creatorsByThreadId.get(threadId);
}
