// FILE: -eventRouterSubscriptions.ts
// Purpose: Pure subscription target resolution for the root orchestration event router.
// Layer: Web route sync helper
// Exports: resolveThreadSubscriptionTargets

import type { ThreadId } from "@t3tools/contracts";

export function resolveThreadSubscriptionTargets(input: {
  readonly visibleThreadIds: readonly ThreadId[];
  readonly retainedThreadIds: readonly ThreadId[];
  readonly serverThreadIds: ReadonlySet<ThreadId>;
}): ThreadId[] {
  const nextThreadIds = new Set<ThreadId>();
  for (const threadId of input.visibleThreadIds) {
    // Visible draft routes need a detail subscription before their shell row exists.
    // Otherwise fast provider responses can complete before the promoted thread is
    // known to the shell list, leaving the chat detail stuck on its optimistic state.
    nextThreadIds.add(threadId);
  }
  for (const threadId of input.retainedThreadIds) {
    if (input.serverThreadIds.has(threadId)) {
      nextThreadIds.add(threadId);
    }
  }
  return [...nextThreadIds];
}
