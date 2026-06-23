import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadSubscriptionTargets } from "./-eventRouterSubscriptions";

describe("resolveThreadSubscriptionTargets", () => {
  it("keeps visible draft threads subscribed before they have shell rows", () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-visible-draft");

    expect(
      resolveThreadSubscriptionTargets({
        visibleThreadIds: [draftThreadId],
        retainedThreadIds: [],
        serverThreadIds: new Set(),
      }),
    ).toEqual([draftThreadId]);
  });

  it("filters retained background threads that are not present in the shell", () => {
    const visibleThreadId = ThreadId.makeUnsafe("thread-visible");
    const retainedKnownThreadId = ThreadId.makeUnsafe("thread-retained-known");
    const retainedUnknownThreadId = ThreadId.makeUnsafe("thread-retained-unknown");

    expect(
      resolveThreadSubscriptionTargets({
        visibleThreadIds: [visibleThreadId],
        retainedThreadIds: [retainedKnownThreadId, retainedUnknownThreadId],
        serverThreadIds: new Set([visibleThreadId, retainedKnownThreadId]),
      }),
    ).toEqual([visibleThreadId, retainedKnownThreadId]);
  });

  it("deduplicates visible and retained thread ids while preserving first-seen order", () => {
    const threadId = ThreadId.makeUnsafe("thread-visible-retained");

    expect(
      resolveThreadSubscriptionTargets({
        visibleThreadIds: [threadId],
        retainedThreadIds: [threadId],
        serverThreadIds: new Set([threadId]),
      }),
    ).toEqual([threadId]);
  });
});
