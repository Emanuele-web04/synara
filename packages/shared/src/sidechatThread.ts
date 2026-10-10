// FILE: sidechatThread.ts
// Purpose: The one answer to "is this thread a sidechat?", shared by server and web. A sidechat
//          either forks a source thread (`sidechatSourceThreadId`) or stands alone with a
//          `sidechatContext` (a GitHub item asked about from the inbox). Code that needs the
//          source thread itself (transcript import, permission inheritance, the "no sidechat of a
//          sidechat" guard) reads `sidechatSourceThreadId` directly instead.
// Layer: Shared domain helper
// Exports: isSidechatThread, isStandaloneSidechatThread, sidechatContextMatchesGitHubItem

import type { ThreadSidechatContext } from "@synara/contracts";

export interface SidechatIdentityFields {
  readonly sidechatSourceThreadId?: string | null | undefined;
  readonly sidechatContext?: ThreadSidechatContext | null | undefined;
}

export function isSidechatThread(thread: SidechatIdentityFields): boolean {
  return Boolean(thread.sidechatSourceThreadId) || thread.sidechatContext != null;
}

/** A sidechat with no source thread: nothing to import, inherit, or return to. */
export function isStandaloneSidechatThread(thread: SidechatIdentityFields): boolean {
  return !thread.sidechatSourceThreadId && thread.sidechatContext != null;
}

/** GitHub numbers pull requests and issues from one sequence, so repository + number is enough. */
export function sidechatContextMatchesGitHubItem(
  context: ThreadSidechatContext | null | undefined,
  item: { readonly repository: string; readonly number: number },
): boolean {
  return (
    context != null &&
    context.kind === "github-item" &&
    context.number === item.number &&
    context.repository.toLowerCase() === item.repository.toLowerCase()
  );
}
