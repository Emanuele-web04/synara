import { describe, expect, it } from "vitest";

import {
  resolveRestorableThreadRoute,
  shouldHoldMissingThreadRouteFallback,
  shouldHoldRememberedRouteFallback,
  shouldStartMissingThreadRouteRecovery,
  shouldStartRememberedRouteRecovery,
} from "./chatRouteRestore";

describe("resolveRestorableThreadRoute", () => {
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
