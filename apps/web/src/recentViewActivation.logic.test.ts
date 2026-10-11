// FILE: recentViewActivation.logic.test.ts
// Purpose: Verifies split-pane restoration for Ctrl+Tab recent thread activation.
// Layer: UI state logic test

import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { SplitView } from "./splitViewStore";
import { resolveRecentThreadSplitActivation } from "./recentViewActivation.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function makeSplitView(input: {
  id: string;
  focusedPane: "empty" | "thread";
  threadId: ThreadId;
}): SplitView {
  const emptyPaneId = `${input.id}-empty`;
  const threadPaneId = `${input.id}-thread`;
  const panel = {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser" as const,
  };

  return {
    id: input.id,
    sourceThreadId: input.threadId,
    ownerProjectId: PROJECT_ID,
    focusedPaneId: input.focusedPane === "empty" ? emptyPaneId : threadPaneId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    root: {
      kind: "split",
      id: `${input.id}-root`,
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: emptyPaneId, threadId: null, panel },
      second: { kind: "leaf", id: threadPaneId, threadId: input.threadId, panel },
    },
  };
}

describe("recent view activation", () => {
  it("resolves the pane containing a recent split thread even when another pane is focused", () => {
    const targetThreadId = threadId("thread-target");
    const splitView = makeSplitView({
      id: "split-1",
      focusedPane: "empty",
      threadId: targetThreadId,
    });

    expect(
      resolveRecentThreadSplitActivation({
        view: { kind: "thread", threadId: targetThreadId, splitViewId: "split-1" },
        splitViewsById: { "split-1": splitView },
      }),
    ).toEqual({
      splitViewId: "split-1",
      paneId: "split-1-thread",
    });
  });

  it("falls back when the saved split no longer contains the recent thread", () => {
    expect(
      resolveRecentThreadSplitActivation({
        view: {
          kind: "thread",
          threadId: threadId("thread-missing"),
          splitViewId: "split-1",
        },
        splitViewsById: {
          "split-1": makeSplitView({
            id: "split-1",
            focusedPane: "thread",
            threadId: threadId("thread-other"),
          }),
        },
      }),
    ).toBeNull();
  });
});
