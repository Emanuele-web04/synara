import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeSingleDockPaneOpenRequest } from "./dockPaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDockPaneOpenRequest with the browser panel's remember policy", () => {
  it("shows the current thread browser immediately without navigating", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "remember", remember: (threadId) => calls.push(`remember:${threadId}`) },
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
  });

  it("remembers a background thread request without touching the current chat", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "remember", remember: (threadId) => calls.push(`remember:${threadId}`) },
    });

    expect(calls).toEqual([`remember:${REQUESTED_THREAD_ID}`]);
  });
});

describe("routeSingleDockPaneOpenRequest with the device navigate policy", () => {
  it("opens the current thread pane immediately without navigating", () => {
    const calls: string[] = [];
    const navigateToThread = vi.fn();

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "navigate", navigateToThread },
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("seeds the requested thread's dock before navigating to it", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
      },
    });

    expect(calls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}`,
    ]);
  });

  it("hydrates before opening so an agent request never waits on a suspended frame", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: () => calls.push("open"),
      crossThread: { kind: "navigate", navigateToThread: () => calls.push("navigate") },
    });

    expect(calls[0]).toBe("hydrate");
  });
});

describe("cross-thread policy divergence", () => {
  // The browser panel remembers cross-thread opens instead of following them:
  // its native runtime stays on the requested thread, so returning to that chat
  // restores the panel, but the user's current chat is never stolen. The device
  // pane has no such runtime, so it follows the request.
  it("remembers quietly for a background thread while navigate seeds and routes", () => {
    const rememberCalls: string[] = [];
    const navigateCalls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => rememberCalls.push("hydrate"),
      openPane: (threadId) => rememberCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "remember",
        remember: (threadId) => rememberCalls.push(`remember:${threadId}`),
      },
    });
    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => navigateCalls.push("hydrate"),
      openPane: (threadId) => navigateCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => navigateCalls.push(`navigate:${threadId}`),
      },
    });

    // Remember skips hydration and the pane — the current chat sees no change.
    expect(rememberCalls).toEqual([`remember:${REQUESTED_THREAD_ID}`]);
    expect(navigateCalls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}`,
    ]);
  });

  it("is identical for a same-thread request under either policy", () => {
    const rememberCalls: string[] = [];
    const navigateCalls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => rememberCalls.push("hydrate"),
      openPane: (threadId) => rememberCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "remember",
        remember: (threadId) => rememberCalls.push(`remember:${threadId}`),
      },
    });
    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => navigateCalls.push("hydrate"),
      openPane: (threadId) => navigateCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => navigateCalls.push(`navigate:${threadId}`),
      },
    });

    expect(rememberCalls).toEqual(navigateCalls);
  });
});
