import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId, WS_STREAM_LIMITS } from "@synara/contracts";
import { useStore } from "./store";
import {
  getRetainedThreadDetailIdsSnapshot,
  resetRetainedThreadDetailSubscriptionsForTests,
  resolveThreadDetailSubscriptionLeaseIds,
  retainThreadDetailSubscription,
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

  it("makes each retain handle idempotent so one caller cannot release another lease", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-idempotent");
    const releaseOne = retainThreadDetailSubscription(threadId);
    const releaseTwo = retainThreadDetailSubscription(threadId);

    releaseOne();
    releaseOne();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseTwo();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
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

  it("does not postpone idle eviction when unrelated store state changes", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-stable-deadline");
    const release = retainThreadDetailSubscription(threadId);
    release();

    vi.advanceTimersByTime(14 * 60 * 1000);
    useStore.setState({ threadsHydrated: !useStore.getState().threadsHydrated });
    vi.advanceTimersByTime(60 * 1000);

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

    expect(getRetainedThreadDetailIdsSnapshot().length).toBeLessThanOrEqual(
      WS_STREAM_LIMITS.threadPerClient - 1,
    );
  });

  it("prioritizes visible leases and stays within connection admission", () => {
    const visible = [ThreadId.makeUnsafe("visible-1"), ThreadId.makeUnsafe("visible-2")];
    const retained = Array.from({ length: WS_STREAM_LIMITS.threadPerClient }, (_, index) =>
      ThreadId.makeUnsafe(`retained-${index}`),
    );

    expect(
      resolveThreadDetailSubscriptionLeaseIds({
        visibleThreadIds: visible,
        retainedThreadIds: retained,
        serverThreadIds: new Set(retained),
      }),
    ).toEqual([
      ...visible,
      ...retained.slice(0, WS_STREAM_LIMITS.threadPerClient - visible.length),
    ]);
  });

  it("releases normalized detail when an idle lease is evicted", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-detail-eviction");
    useStore.setState({
      messageIdsByThreadId: { [threadId]: [] },
      messageByThreadId: { [threadId]: {} },
      activityIdsByThreadId: { [threadId]: [] },
      activityByThreadId: { [threadId]: {} },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    const state = useStore.getState();
    expect(state.messageIdsByThreadId?.[threadId]).toBeUndefined();
    expect(state.messageByThreadId?.[threadId]).toBeUndefined();
    expect(state.activityIdsByThreadId?.[threadId]).toBeUndefined();
    expect(state.activityByThreadId?.[threadId]).toBeUndefined();
  });
});
