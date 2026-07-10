// FILE: threadDetailPrewarm.test.ts
// Purpose: Verifies short-lived prewarming for fast thread-detail navigation.
// Layer: Web subscription utility test

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadDetailPrewarmController } from "./threadDetailPrewarm";

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function makeRetainSpy() {
  const retainedThreadIds: ThreadId[] = [];
  const releasedThreadIds: ThreadId[] = [];
  const retainThreadDetailSubscription = vi.fn((threadId: ThreadId) => {
    retainedThreadIds.push(threadId);
    return () => {
      releasedThreadIds.push(threadId);
    };
  });

  return {
    retainThreadDetailSubscription,
    retainedThreadIds,
    releasedThreadIds,
  };
}

describe("thread detail prewarm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains a target thread immediately and releases it after the prewarm window", () => {
    vi.useFakeTimers();
    const retain = makeRetainSpy();
    const thread = threadId("thread-1");
    const controller = createThreadDetailPrewarmController({
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
      releaseMs: 1000,
    });

    controller.prewarmThreadDetail(thread);

    expect(retain.retainedThreadIds).toEqual([thread]);
    expect(retain.releasedThreadIds).toEqual([]);

    vi.advanceTimersByTime(999);
    expect(retain.releasedThreadIds).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(retain.releasedThreadIds).toEqual([thread]);
  });

  it("refreshes an existing retain without incrementing the retention count", () => {
    vi.useFakeTimers();
    const retain = makeRetainSpy();
    const thread = threadId("thread-2");
    const controller = createThreadDetailPrewarmController({
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
      releaseMs: 1000,
    });

    controller.prewarmThreadDetail(thread);
    vi.advanceTimersByTime(500);
    controller.prewarmThreadDetail(thread);

    expect(retain.retainedThreadIds).toEqual([thread]);

    vi.advanceTimersByTime(999);
    expect(retain.releasedThreadIds).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(retain.releasedThreadIds).toEqual([thread]);
  });

  it("bounds the warm set and releases entries that leave the prewarm list", () => {
    vi.useFakeTimers();
    const retain = makeRetainSpy();
    const threadOne = threadId("thread-1");
    const threadTwo = threadId("thread-2");
    const threadThree = threadId("thread-3");
    const threadFour = threadId("thread-4");
    const controller = createThreadDetailPrewarmController({
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
      releaseMs: 1000,
      maxRetainedThreads: 2,
    });

    controller.prewarmThreadDetails([threadOne, threadTwo, threadOne, threadThree]);

    expect(retain.retainedThreadIds).toEqual([threadOne, threadTwo]);
    expect(retain.releasedThreadIds).toEqual([]);

    controller.prewarmThreadDetails([threadTwo, threadFour]);

    expect(retain.retainedThreadIds).toEqual([threadOne, threadTwo, threadFour]);
    expect(retain.releasedThreadIds).toEqual([threadOne]);

    controller.dispose();

    expect(retain.releasedThreadIds).toEqual([threadOne, threadTwo, threadFour]);
  });
});
