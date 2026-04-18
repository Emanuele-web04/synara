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
    });

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExpanded: true,
      expandedProjectThreadListCwds: [
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo"),
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other"),
      ],
    });
  });

  it("ignores malformed persisted project thread list entries", () => {
    window.localStorage.setItem(
      "t3code:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: true,
        chatThreadListExpanded: false,
        expandedProjectThreadListCwds: ["/Users/tester/Code/demo", 42, null, ""],
      }),
    );

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExpanded: false,
      expandedProjectThreadListCwds: [
        normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo"),
      ],
    });
  });
});
