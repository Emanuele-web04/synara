import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SplitView } from "./splitViewStore";
import {
  resolvePreferredSplitForCommand,
  resolveThreadCommandActivation,
} from "./threadActivation.logic";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeSplitViewFixture(input: {
  id: string;
  sourceThreadId: ThreadId;
  firstThreadId: ThreadId | null;
  secondThreadId: ThreadId | null;
  focusOn: "first" | "second";
}): SplitView {
  const firstId = `${input.id}-pane-first`;
  const secondId = `${input.id}-pane-second`;
  const panel = {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser" as const,
  };
  return {
    id: input.id,
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: PROJECT_ID,
    focusedPaneId: input.focusOn === "first" ? firstId : secondId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    root: {
      kind: "split",
      id: `${input.id}-root`,
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: firstId, threadId: input.firstThreadId, panel },
      second: { kind: "leaf", id: secondId, threadId: input.secondThreadId, panel },
    },
  };
}

describe("resolveThreadCommandActivation", () => {
  it("opens the target thread inside the caller-provided active split", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_B,
        preferredSplitViewId: "split-1",
        splitPaneId: "pane-a",
      }),
    ).toEqual({
      kind: "split",
      threadId: THREAD_A,
      splitViewId: "split-1",
      paneId: "pane-a",
    });
  });

  it("opens the target thread as single chat when it is not in a split", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_B,
        preferredSplitViewId: null,
        splitPaneId: null,
      }),
    ).toEqual({
      kind: "single",
      threadId: THREAD_A,
    });
  });

  it("still opens the active sidebar thread split instead of ignoring it", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_A,
        preferredSplitViewId: "split-1",
        splitPaneId: "pane-a",
      }),
    ).toEqual({
      kind: "split",
      threadId: THREAD_A,
      splitViewId: "split-1",
      paneId: "pane-a",
    });
  });

  it("ignores missing threads and already-active single chats", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: false,
        activeSidebarThreadId: THREAD_B,
        preferredSplitViewId: null,
        splitPaneId: null,
      }),
    ).toEqual({ kind: "ignore" });

    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_A,
        preferredSplitViewId: null,
        splitPaneId: null,
      }),
    ).toEqual({ kind: "ignore" });
  });
});

describe("resolvePreferredSplitForCommand", () => {
  it("focuses the matching pane in the active split when the target lives there", () => {
    const activeSplitView = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });

    const result = resolvePreferredSplitForCommand({
      activeSplitView,
      splitViewsById: {},
      threadId: THREAD_B,
    });

    expect(result).toEqual({ splitViewId: "split-active", paneId: "split-active-pane-second" });
  });

  it("returns null inside an active split when the target is outside that split", () => {
    const activeSplitView = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const result = resolvePreferredSplitForCommand({
      activeSplitView,
      splitViewsById: {},
      threadId: THREAD_C,
    });

    expect(result).toBeNull();
  });

  it("restores a persisted split when no split is active", () => {
    const splitView = makeSplitViewFixture({
      id: "split-background",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });

    const result = resolvePreferredSplitForCommand({
      activeSplitView: null,
      splitViewsById: { "split-background": splitView },
      threadId: THREAD_B,
    });

    expect(result).toEqual({
      splitViewId: "split-background",
      paneId: "split-background-pane-second",
    });
  });

  it("prefers source ownership when a thread appears in multiple split blocks", () => {
    const firstSplit = makeSplitViewFixture({
      id: "split-first",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const secondSplit = makeSplitViewFixture({
      id: "split-second",
      sourceThreadId: THREAD_C,
      firstThreadId: THREAD_C,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });

    expect(
      resolvePreferredSplitForCommand({
        activeSplitView: null,
        splitViewsById: {
          "split-first": firstSplit,
          "split-second": secondSplit,
        },
        threadId: THREAD_B,
      }),
    ).toBeNull();

    expect(
      resolvePreferredSplitForCommand({
        activeSplitView: null,
        splitViewsById: {
          "split-first": firstSplit,
          "split-second": secondSplit,
        },
        threadId: THREAD_C,
      }),
    ).toEqual({ splitViewId: "split-second", paneId: "split-second-pane-first" });
  });

  it("switches from one active split to another persisted split", () => {
    const activeSplit = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const otherSplit = makeSplitViewFixture({
      id: "split-other",
      sourceThreadId: THREAD_C,
      firstThreadId: THREAD_C,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });

    const result = resolvePreferredSplitForCommand({
      activeSplitView: activeSplit,
      splitViewsById: {
        "split-active": activeSplit,
        "split-other": otherSplit,
      },
      threadId: THREAD_C,
    });

    expect(result).toEqual({ splitViewId: "split-other", paneId: "split-other-pane-first" });
  });

  it("returns null when no split is active and no persisted split owns the thread", () => {
    expect(
      resolvePreferredSplitForCommand({
        activeSplitView: null,
        splitViewsById: {},
        threadId: THREAD_A,
      }),
    ).toBeNull();
  });
});
