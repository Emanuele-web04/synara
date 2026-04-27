import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveVisibleToastThreadIds,
  shouldRenderToastForVisibleThreads,
} from "./toastRouteVisibility";
import type { SplitView } from "../../splitViewStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

function createSplitView(): SplitView {
  const firstLeaf = {
    kind: "leaf" as const,
    id: "pane-first",
    threadId: THREAD_A,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser" as const,
    },
  };
  const secondLeaf = {
    kind: "leaf" as const,
    id: "pane-second",
    threadId: THREAD_B,
    panel: {
      panel: "browser" as const,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: true,
      lastOpenPanel: "browser" as const,
    },
  };
  return {
    id: "split-1",
    sourceThreadId: THREAD_A,
    ownerProjectId: PROJECT_ID,
    root: {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      first: firstLeaf,
      second: secondLeaf,
      ratio: 0.5,
    },
    focusedPaneId: secondLeaf.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveVisibleToastThreadIds", () => {
  it("returns only the active thread for single-chat routes", () => {
    expect(
      resolveVisibleToastThreadIds({
        activeThreadId: THREAD_A,
        splitView: null,
      }),
    ).toEqual(new Set([THREAD_A]));
  });

  it("returns every visible split thread without duplicates", () => {
    expect(
      resolveVisibleToastThreadIds({
        activeThreadId: THREAD_A,
        splitView: createSplitView(),
      }),
    ).toEqual(new Set([THREAD_A, THREAD_B]));
  });
});

describe("shouldRenderToastForVisibleThreads", () => {
  it("shows unscoped toasts everywhere", () => {
    expect(
      shouldRenderToastForVisibleThreads({
        toastThreadId: null,
        visibleThreadIds: new Set([THREAD_A]),
      }),
    ).toBe(true);
  });

  it("keeps thread-scoped toasts limited to visible threads by default", () => {
    expect(
      shouldRenderToastForVisibleThreads({
        toastThreadId: THREAD_B,
        visibleThreadIds: new Set([THREAD_A]),
      }),
    ).toBe(false);
  });

  it("allows explicit cross-thread visibility for deeplink notifications", () => {
    expect(
      shouldRenderToastForVisibleThreads({
        allowCrossThreadVisibility: true,
        toastThreadId: THREAD_B,
        visibleThreadIds: new Set([THREAD_A]),
      }),
    ).toBe(true);
  });
});
