import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { SplitView } from "../../splitViewStore";
import { routeSplitBrowserPanelOpenRequest } from "./browserPanelOpenRequest";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");

function createSplitView(): SplitView {
  return {
    id: "split-1",
    sourceThreadId: THREAD_A,
    ownerProjectId: ProjectId.makeUnsafe("project-1"),
    focusedPaneId: "pane-a",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    root: {
      kind: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-a",
        threadId: THREAD_A,
        panel: {
          panel: null,
          diffTurnId: null,
          diffFilePath: null,
          hasOpenedPanel: false,
          lastOpenPanel: "browser",
        },
      },
      second: {
        kind: "leaf",
        id: "pane-b",
        threadId: THREAD_B,
        panel: {
          panel: "diff",
          diffTurnId: null,
          diffFilePath: "src/example.ts",
          hasOpenedPanel: true,
          lastOpenPanel: "diff",
        },
      },
    },
  };
}

describe("routeSplitBrowserPanelOpenRequest", () => {
  it("focuses the pane already showing the requested thread and opens its browser", () => {
    const calls: string[] = [];

    routeSplitBrowserPanelOpenRequest({
      splitView: createSplitView(),
      requestedThreadId: THREAD_B,
      focusPane: (paneId) => calls.push(`focus:${paneId}`),
      replacePaneThread: (paneId, threadId) => calls.push(`replace:${paneId}:${threadId}`),
      openBrowserPanel: (paneId) => calls.push(`open:${paneId}`),
      navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
    });

    expect(calls).toEqual(["focus:pane-b", "open:pane-b", `navigate:${THREAD_B}`]);
  });

  it("replaces the focused pane when the requested thread is not in the split", () => {
    const calls: string[] = [];

    routeSplitBrowserPanelOpenRequest({
      splitView: createSplitView(),
      requestedThreadId: THREAD_C,
      focusPane: (paneId) => calls.push(`focus:${paneId}`),
      replacePaneThread: (paneId, threadId) => calls.push(`replace:${paneId}:${threadId}`),
      openBrowserPanel: (paneId) => calls.push(`open:${paneId}`),
      navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
    });

    expect(calls).toEqual([
      "focus:pane-a",
      `replace:pane-a:${THREAD_C}`,
      "open:pane-a",
      `navigate:${THREAD_C}`,
    ]);
  });
});
