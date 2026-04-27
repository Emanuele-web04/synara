import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
} from "./Sidebar.uiState";

describe("Sidebar.uiState", () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => {
            storage.clear();
          },
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("defaults collapsed sidebar UI state with no expanded project thread lists", () => {
    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: false,
      chatThreadListExpanded: false,
      expandedProjectThreadListCwds: [],
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
    });
  });

  it("persists expanded project thread lists by normalized cwd", () => {
    persistSidebarUiState({
      chatSectionExpanded: true,
      chatThreadListExpanded: true,
      expandedProjectThreadListCwds: [
        "/Users/tester/Code/demo",
        "/Users/tester/Code/demo/",
        "/Users/tester/Code/other",
      ],
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
    });

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExpanded: true,
      expandedProjectThreadListCwds: [
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo"),
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other"),
      ],
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
    });
  });

  it("ignores malformed persisted project thread list entries", () => {
    window.localStorage.setItem(
      "dpcode:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: true,
        chatThreadListExpanded: false,
        expandedProjectThreadListCwds: ["/Users/tester/Code/demo", 42, null, ""],
        dismissedThreadStatusKeyByThreadId: {
          "thread-123": "Awaiting Input:turn-2",
          "": "bad",
          "thread-456": 42,
        },
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: 42,
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExpanded: false,
      expandedProjectThreadListCwds: [
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo"),
      ],
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Awaiting Input:turn-2",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
    });
  });

  it("drops malformed persisted last thread routes", () => {
    window.localStorage.setItem(
      "dpcode:sidebar-ui:v1",
      JSON.stringify({
        lastThreadRoute: {
          threadId: 42,
          splitViewId: "split-123",
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: false,
      chatThreadListExpanded: false,
      expandedProjectThreadListCwds: [],
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
    });
  });
});
