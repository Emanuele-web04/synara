import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { removeThreadFromSplitView } from "./splitView.logic";
import type { SplitView } from "./splitViewStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const TURN_ID = TurnId.makeUnsafe("turn-1");

function createSplitView(overrides: Partial<SplitView> = {}): SplitView {
  return {
    id: "split-1",
    sourceThreadId: THREAD_A,
    ownerProjectId: PROJECT_ID,
    leftThreadId: THREAD_A,
    rightThreadId: THREAD_B,
    focusedPane: "left",
    ratio: 0.5,
    leftPanel: {
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/left.ts",
      hasOpenedPanel: true,
      lastOpenPanel: "diff",
    },
    rightPanel: {
      panel: "browser",
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: true,
      lastOpenPanel: "browser",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("removeThreadFromSplitView", () => {
  it("clears the removed pane, resets its panel, and falls focus back to the remaining thread", () => {
    const result = removeThreadFromSplitView(createSplitView(), THREAD_A);

    expect(result.removedPane).toBe("left");
    expect(result.nextFocusedPane).toBe("right");
    expect(result.nextFocusedThreadId).toBe(THREAD_B);
    expect(result.nextSplitView).toMatchObject({
      leftThreadId: null,
      rightThreadId: THREAD_B,
      focusedPane: "right",
      leftPanel: {
        panel: null,
        diffTurnId: null,
        diffFilePath: null,
        hasOpenedPanel: true,
        lastOpenPanel: "diff",
      },
    });
  });

  it("removes the split entirely when deleting the last remaining thread", () => {
    const result = removeThreadFromSplitView(
      createSplitView({
        rightThreadId: null,
        rightPanel: {
          panel: null,
          diffTurnId: null,
          diffFilePath: null,
          hasOpenedPanel: false,
          lastOpenPanel: "browser",
        },
      }),
      THREAD_A,
    );

    expect(result.removedPane).toBe("left");
    expect(result.nextFocusedPane).toBeNull();
    expect(result.nextFocusedThreadId).toBeNull();
    expect(result.nextSplitView).toBeNull();
  });

  it("leaves unrelated splits untouched", () => {
    const splitView = createSplitView();

    const result = removeThreadFromSplitView(splitView, ThreadId.makeUnsafe("thread-z"));

    expect(result.nextSplitView).toBe(splitView);
    expect(result.nextFocusedPane).toBe("left");
    expect(result.nextFocusedThreadId).toBe(THREAD_A);
  });
});
