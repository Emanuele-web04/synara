import { describe, expect, it } from "vitest";

import {
  collectKnownThreadIds,
  resolveRestorableThreadRoute,
  resolveRestorableThreadRouteWithFallback,
  shouldHoldMissingThreadRouteFallback,
  shouldHoldRememberedRouteFallback,
  shouldHoldUnresolvedRememberedRouteFallback,
  shouldStartMissingThreadRouteRecovery,
  shouldStartRememberedRouteRecovery,
  shouldStartUnresolvedRememberedRouteRecovery,
} from "./chatRouteRestore";

describe("resolveRestorableThreadRoute", () => {
  it("includes workspace conversations projected only into sidebar summaries", () => {
    expect([
      ...collectKnownThreadIds({
        threadIds: ["legacy-thread"],
        sidebarThreadSummaryIds: ["legacy-thread", "workspace-conversation"],
      }),
    ]).toEqual(["legacy-thread", "workspace-conversation"]);
  });

  it("returns the last thread route when the thread still exists", () => {
    expect(
      resolveRestorableThreadRoute({
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: "split-456",
        },
        availableThreadIds: new Set(["thread-123", "thread-789"]),
      }),
    ).toEqual({
      threadId: "thread-123",
      splitViewId: "split-456",
    });
  });

  it("returns null when the remembered thread no longer exists", () => {
    expect(
      resolveRestorableThreadRoute({
        lastThreadRoute: {
          threadId: "thread-123",
        },
        availableThreadIds: new Set(["thread-789"]),
      }),
    ).toBeNull();
  });

  it("drops a stale split id while preserving the remembered thread", () => {
    expect(
      resolveRestorableThreadRoute({
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: "split-missing",
        },
        availableThreadIds: new Set(["thread-123"]),
        availableSplitViewIds: new Set(["split-live"]),
      }),
    ).toEqual({
      threadId: "thread-123",
    });
  });

  it("uses the most recent available thread when the dedicated route is absent", () => {
    expect(
      resolveRestorableThreadRouteWithFallback({
        lastThreadRoute: null,
        fallbackRoutes: [
          { threadId: "thread-missing" },
          { threadId: "workspace-conversation" },
          { threadId: "older-thread" },
        ],
        availableThreadIds: new Set(["workspace-conversation", "older-thread"]),
      }),
    ).toEqual({ threadId: "workspace-conversation" });
  });

  it("does not replace an explicit stale route with an unrelated recent thread", () => {
    expect(
      resolveRestorableThreadRouteWithFallback({
        lastThreadRoute: { threadId: "explicit-but-stale" },
        fallbackRoutes: [{ threadId: "recent-thread" }],
        availableThreadIds: new Set(["recent-thread"]),
      }),
    ).toBeNull();
  });

  it("recovers a remembered route before falling back when startup has no threads yet", () => {
    expect(
      shouldStartRememberedRouteRecovery({
        lastThreadRoute: { threadId: "thread-123" },
        availableThreadCount: 0,
        recoveryState: "idle",
      }),
    ).toBe(true);
    expect(
      shouldHoldRememberedRouteFallback({
        lastThreadRoute: { threadId: "thread-123" },
        availableThreadCount: 0,
        recoveryState: "pending",
      }),
    ).toBe(true);
  });

  it("allows remembered route fallback after recovery is exhausted", () => {
    expect(
      shouldStartRememberedRouteRecovery({
        lastThreadRoute: { threadId: "thread-123" },
        availableThreadCount: 0,
        recoveryState: "done",
      }),
    ).toBe(false);
    expect(
      shouldHoldRememberedRouteFallback({
        lastThreadRoute: { threadId: "thread-123" },
        availableThreadCount: 0,
        recoveryState: "done",
      }),
    ).toBe(false);
  });

  it("recovers an unresolved remembered route even when other threads are already known", () => {
    const input = {
      enabled: true,
      lastThreadRoute: { threadId: "workspace-conversation" },
      routeRestorable: false,
    };

    expect(
      shouldStartUnresolvedRememberedRouteRecovery({
        ...input,
        recoveryState: "idle",
      }),
    ).toBe(true);
    expect(
      shouldHoldUnresolvedRememberedRouteFallback({
        ...input,
        recoveryState: "pending",
      }),
    ).toBe(true);
  });

  it("does not delay a remembered route that intentionally belongs to another surface", () => {
    const input = {
      enabled: false,
      lastThreadRoute: { threadId: "studio-thread" },
      routeRestorable: false,
    };

    expect(
      shouldStartUnresolvedRememberedRouteRecovery({
        ...input,
        recoveryState: "idle",
      }),
    ).toBe(false);
    expect(
      shouldHoldUnresolvedRememberedRouteFallback({
        ...input,
        recoveryState: "pending",
      }),
    ).toBe(false);
  });

  it("recovers a missing thread route only while no server threads are known", () => {
    expect(
      shouldStartMissingThreadRouteRecovery({
        hasKnownServerThreads: false,
        recoveryState: "idle",
        routeThreadExists: false,
      }),
    ).toBe(true);
    expect(
      shouldHoldMissingThreadRouteFallback({
        hasKnownServerThreads: false,
        recoveryState: "pending",
        routeThreadExists: false,
      }),
    ).toBe(true);
    expect(
      shouldStartMissingThreadRouteRecovery({
        hasKnownServerThreads: true,
        recoveryState: "idle",
        routeThreadExists: false,
      }),
    ).toBe(false);
  });
});
