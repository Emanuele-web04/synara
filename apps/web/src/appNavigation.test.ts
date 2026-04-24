// FILE: appNavigation.test.ts
// Purpose: Verifies browser-style route navigation state without rendering the app shell.
// Layer: Web routing utility tests
// Depends on: TanStack memory history and appNavigation helpers

import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

import {
  goBackInAppHistory,
  goForwardInAppHistory,
  resolveAppNavigationState,
  syncAppNavigationState,
} from "./appNavigation";

describe("resolveAppNavigationState", () => {
  it("tracks back and forward availability from the TanStack history index", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });

    expect(syncAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: false,
    });

    history.push("/settings");
    expect(syncAppNavigationState(history, { type: "PUSH" })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });

    history.back();
    expect(resolveAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: true,
    });
  });

  it("does not use browser-global history length to enable forward on first app load", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    Object.defineProperty(history, "length", {
      configurable: true,
      get: () => 2,
    });

    expect(syncAppNavigationState(history)).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("clears stale forward availability when pushing a new route after going back", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });

    history.push("/settings");
    syncAppNavigationState(history, { type: "PUSH" });
    history.push("/plugins");
    syncAppNavigationState(history, { type: "PUSH" });
    history.back();
    syncAppNavigationState(history, { type: "BACK" });
    history.back();
    expect(syncAppNavigationState(history, { type: "BACK" })).toEqual({
      canGoBack: false,
      canGoForward: true,
    });

    history.push("/workspace/workspace-1");
    expect(syncAppNavigationState(history, { type: "PUSH" })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("flushes pending URL writes before native back and forward navigation", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/settings"] });
    const calls: string[] = [];
    vi.spyOn(history, "flush").mockImplementation(() => {
      calls.push("flush");
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      calls.push("back");
    });
    vi.spyOn(history, "forward").mockImplementation(() => {
      calls.push("forward");
    });

    goBackInAppHistory(history);
    goForwardInAppHistory(history);

    expect(calls).toEqual(["flush", "back", "flush", "forward"]);
  });
});
