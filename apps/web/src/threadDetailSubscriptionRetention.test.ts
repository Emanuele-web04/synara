import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId, type OrchestrationSessionStatus } from "@t3tools/contracts";
import { useStore } from "./store";
import type { SidebarThreadSummary, ThreadSession } from "./types";
import {
  getLiveRetainedThreadDetailIdsSnapshot,
  getRetainedThreadDetailIdsSnapshot,
  resetRetainedThreadDetailSubscriptionsForTests,
  retainThreadDetailSubscription,
  subscribeLiveRetainedThreadDetailIdChanges,
  subscribeRetainedThreadDetailIdChanges,
} from "./threadDetailSubscriptionRetention";

describe("threadDetailSubscriptionRetention", () => {
  const initialStoreState = useStore.getState();

  function makeThreadSession(status: OrchestrationSessionStatus): ThreadSession {
    return {
      provider: "codex",
      status:
        status === "starting"
          ? "connecting"
          : status === "running"
            ? "running"
            : status === "error"
              ? "error"
              : "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      orchestrationStatus: status,
    };
  }

  function makeSidebarThreadSummary(
    threadId: ThreadId,
    overrides: Partial<SidebarThreadSummary> = {},
  ): SidebarThreadSummary {
    return {
      id: threadId,
      projectId: "project-1" as never,
      title: "Retained thread",
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
      hasLiveTailWork: false,
      ...overrides,
    };
  }

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
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseOne();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseTwo();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([]);
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
    const snapshots: ThreadId[][] = [];
    const unsubscribe = subscribeRetainedThreadDetailIdChanges((threadIds) => {
      snapshots.push([...threadIds]);
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);
    unsubscribe();

    expect(snapshots).toEqual([[threadId], []]);
  });

  it("notifies live retained listeners when a released idle thread stops needing a stream", () => {
    const threadId = ThreadId.makeUnsafe("thread-live-listener");
    const snapshots: ThreadId[][] = [];
    const unsubscribe = subscribeLiveRetainedThreadDetailIdChanges((threadIds) => {
      snapshots.push([...threadIds]);
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    unsubscribe();

    expect(snapshots).toEqual([[threadId], []]);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([]);
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

  it("does not reschedule idle eviction for unrelated store updates", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-unrelated-update");

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000 - 1);

    useStore.setState({
      ...useStore.getState(),
      projects: [...useStore.getState().projects],
    });
    vi.advanceTimersByTime(1);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("keeps actionable threads retained past the idle timeout until they settle", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-busy");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: makeSidebarThreadSummary(threadId, { hasPendingUserInput: true }),
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          ...useStore.getState().sidebarThreadSummaryById[threadId]!,
          hasPendingUserInput: false,
        },
      },
    });

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([]);

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("does not keep released threads live for tail-only UI work", () => {
    const threadId = ThreadId.makeUnsafe("thread-tail-only");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        [threadId]: makeSidebarThreadSummary(threadId, {
          hasLiveTailWork: true,
          session: makeThreadSession("ready"),
        }),
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("drops released ready, interrupted, and error sessions from live retention", () => {
    const readyThreadId = ThreadId.makeUnsafe("thread-ready");
    const interruptedThreadId = ThreadId.makeUnsafe("thread-interrupted");
    const errorThreadId = ThreadId.makeUnsafe("thread-error");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        [readyThreadId]: makeSidebarThreadSummary(readyThreadId, {
          session: makeThreadSession("ready"),
        }),
        [interruptedThreadId]: makeSidebarThreadSummary(interruptedThreadId, {
          session: makeThreadSession("interrupted"),
        }),
        [errorThreadId]: makeSidebarThreadSummary(errorThreadId, {
          session: makeThreadSession("error"),
        }),
      },
    });

    const releaseReady = retainThreadDetailSubscription(readyThreadId);
    const releaseInterrupted = retainThreadDetailSubscription(interruptedThreadId);
    const releaseError = retainThreadDetailSubscription(errorThreadId);
    releaseReady();
    releaseInterrupted();
    releaseError();

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([
      readyThreadId,
      interruptedThreadId,
      errorThreadId,
    ]);
    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("keeps released starting and running sessions in live retention", () => {
    const startingThreadId = ThreadId.makeUnsafe("thread-starting");
    const runningThreadId = ThreadId.makeUnsafe("thread-running");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        [startingThreadId]: makeSidebarThreadSummary(startingThreadId, {
          session: makeThreadSession("starting"),
        }),
        [runningThreadId]: makeSidebarThreadSummary(runningThreadId, {
          session: makeThreadSession("running"),
        }),
      },
    });

    const releaseStarting = retainThreadDetailSubscription(startingThreadId);
    const releaseRunning = retainThreadDetailSubscription(runningThreadId);
    releaseStarting();
    releaseRunning();

    expect(getLiveRetainedThreadDetailIdsSnapshot()).toEqual([startingThreadId, runningThreadId]);
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
