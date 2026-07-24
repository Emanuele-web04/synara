import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeSingleBrowserPanelOpenRequest } from "./browserPanelOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleBrowserPanelOpenRequest", () => {
  it("opens the current thread browser immediately without navigating", () => {
    const calls: string[] = [];
    const navigateToThread = vi.fn();

    routeSingleBrowserPanelOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateBrowserHydration: () => calls.push("hydrate"),
      openBrowserPane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread,
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("initializes the requested thread browser before navigating to it", () => {
    const calls: string[] = [];

    routeSingleBrowserPanelOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateBrowserHydration: () => calls.push("hydrate"),
      openBrowserPane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread: (threadId, panel) => calls.push(`navigate:${threadId}:${panel}`),
    });

    expect(calls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}:browser`,
    ]);
  });
});
