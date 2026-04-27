import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { useStore } from "./store";
import {
  getRetainedThreadDetailIdsSnapshot,
  resetRetainedThreadDetailSubscriptionsForTests,
  retainThreadDetailSubscription,
  subscribeRetainedThreadDetailIdChanges,
} from "./threadDetailSubscriptionRetention";

describe("threadDetailSubscriptionRetention", () => {
  const initialStoreState = useStore.getState();

  afterEach(() => {
    vi.useRealTimers();
    resetRetainedThreadDetailSubscriptionsForTests();
    useStore.setState(initialStoreState);
  });

  it("retains a thread while any caller still holds a retain handle", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const releaseOne = retainThreadDetailSubscription(threadId);
    const releaseTwo = retainThreadDetailSubscription(threadId);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseOne();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseTwo();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
  });

  it("evicts a released thread after the retention timeout", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-2");

    const release = retainThreadDetailSubscription(threadId);
    release();

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("notifies imperative listeners when retained ids change", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-listener");
    const snapshots: readonly ThreadId[][] = [];
    const unsubscribe = subscribeRetainedThreadDetailIdChanges((threadIds) => {
      snapshots.push([...threadIds]);
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);
    unsubscribe();

    expect(snapshots).toEqual([[threadId], []]);
  });

  it("cancels eviction when a thread is retained again before timeout", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-3");

    const firstRelease = retainThreadDetailSubscription(threadId);
    firstRelease();
    vi.advanceTimersByTime(15 * 60 * 1000 - 1);

    const secondRelease = retainThreadDetailSubscription(threadId);
    vi.advanceTimersByTime(1);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    secondRelease();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("keeps non-idle threads retained past the idle timeout until they settle", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-busy");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          id: threadId,
          projectId: "project-1" as never,
          title: "Busy thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          session: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestTurn: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLiveTailWork: true,
        },
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          ...useStore.getState().sidebarThreadSummaryById[threadId]!,
          hasLiveTailWork: false,
        },
      },
    });

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("bounds the idle cache size", () => {
    vi.useFakeTimers();

    const releases = Array.from({ length: 40 }, (_, index) =>
      retainThreadDetailSubscription(ThreadId.makeUnsafe(`thread-${index}`)),
    );

    for (const release of releases) {
      release();
    }

    expect(getRetainedThreadDetailIdsSnapshot().length).toBeLessThanOrEqual(32);
  });
});
