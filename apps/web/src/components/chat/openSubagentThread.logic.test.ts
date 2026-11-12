import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { LeafPane, Pane, SplitView } from "../../splitViewStore";
import { resolveSubagentOpenPlan, type SubagentOpenThreadInfo } from "./openSubagentThread.logic";

const project = ProjectId.makeUnsafe("project");
const parent = ThreadId.makeUnsafe("parent");
const childA = ThreadId.makeUnsafe("child-a");
const childB = ThreadId.makeUnsafe("child-b");
const other = ThreadId.makeUnsafe("other");

const threads: Record<string, SubagentOpenThreadInfo> = {
  parent: { parentThreadId: null, projectId: project },
  other: { parentThreadId: null, projectId: project },
  "child-a": { parentThreadId: parent, projectId: project },
  "child-b": { parentThreadId: parent, projectId: project },
};
const readThread = (threadId: ThreadId) => threads[threadId] ?? null;

const leaf = (id: string, threadId: ThreadId | null): LeafPane => ({
  kind: "leaf",
  id,
  threadId,
  panel: {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "diff",
  },
});

const splitView = (root: Pane): SplitView => ({
  id: "split",
  sourceThreadId: parent,
  ownerProjectId: project,
  root,
  focusedPaneId: "left",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
});

const horizontal = (first: Pane, second: Pane): Pane => ({
  kind: "split",
  id: "root",
  direction: "horizontal",
  first,
  second,
  ratio: 0.5,
});

describe("resolveSubagentOpenPlan", () => {
  it("opens a subagent in a split to the right of its full-width parent", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: childA,
        hostThreadId: parent,
        splitView: null,
        readThread,
      }),
    ).toEqual({
      kind: "create-split",
      sourceThreadId: parent,
      ownerProjectId: project,
      threadId: childA,
    });
  });

  it("puts the parent back on the left when opened from a full-width subagent", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: childB,
        hostThreadId: childA,
        splitView: null,
        readThread,
      }),
    ).toMatchObject({ kind: "create-split", sourceThreadId: parent, threadId: childB });
  });

  it("swaps the subagent pane instead of stacking another one", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: childB,
        hostThreadId: parent,
        splitView: splitView(horizontal(leaf("left", parent), leaf("right", childA))),
        readThread,
      }),
    ).toEqual({ kind: "replace-pane", splitViewId: "split", paneId: "right", threadId: childB });
  });

  it("uses the subagent pane itself when it asks to open a sibling", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: childB,
        hostThreadId: childA,
        splitView: splitView(horizontal(leaf("left", parent), leaf("right", childA))),
        readThread,
      }),
    ).toMatchObject({ kind: "replace-pane", paneId: "right" });
  });

  it("focuses a thread that is already on screen", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: parent,
        hostThreadId: childA,
        splitView: splitView(horizontal(leaf("left", parent), leaf("right", childA))),
        readThread,
      }),
    ).toEqual({ kind: "focus-pane", splitViewId: "split", paneId: "left", threadId: parent });
  });

  it("splits the host pane when the split has no subagent pane yet", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: childA,
        hostThreadId: parent,
        splitView: splitView({
          kind: "split",
          id: "root",
          direction: "vertical",
          first: leaf("left", parent),
          second: leaf("right", other),
          ratio: 0.5,
        }),
        readThread,
      }),
    ).toEqual({ kind: "split-pane", splitViewId: "split", paneId: "left", threadId: childA });
  });

  it("navigates normally to threads that are not subagents", () => {
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: parent,
        hostThreadId: childA,
        splitView: null,
        readThread,
      }),
    ).toEqual({ kind: "navigate", threadId: parent });
    expect(
      resolveSubagentOpenPlan({
        targetThreadId: ThreadId.makeUnsafe("unknown"),
        hostThreadId: parent,
        splitView: null,
        readThread,
      }),
    ).toEqual({ kind: "navigate", threadId: "unknown" });
  });
});
