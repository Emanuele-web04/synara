import { describe, expect, it } from "vitest";

import type { ThreadId } from "@synara/contracts";
import { type RightDockPane } from "~/rightDockStore.logic";
import {
  buildRightDockPaneLabelOverrides,
  resolveRightDockPaneLabel,
  resolveRightDockLauncherItems,
} from "./rightDockPaneMeta";

function makePane(
  input: Partial<RightDockPane> & Pick<RightDockPane, "id" | "kind">,
): RightDockPane {
  return {
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
    ...input,
  };
}

describe("resolveRightDockLauncherItems", () => {
  it("adds review and source control only for Git repositories", () => {
    expect(
      resolveRightDockLauncherItems({
        hasWorkspace: true,
        hasGitRepository: true,
        hasReview: true,
      }).map(({ kind }) => kind),
    ).toEqual(["diff", "terminal", "browser", "explorer", "sidechat", "git"]);
  });

  it("hides workspace-backed tools while no workspace is ready", () => {
    expect(
      resolveRightDockLauncherItems({
        hasWorkspace: false,
        hasGitRepository: false,
        hasReview: false,
      }).map(({ kind }) => kind),
    ).toEqual(["terminal", "browser", "sidechat"]);
  });

  it("hides review for a clean Git repository", () => {
    expect(
      resolveRightDockLauncherItems({
        hasWorkspace: true,
        hasGitRepository: true,
        hasReview: false,
      }).map(({ kind }) => kind),
    ).toEqual(["terminal", "browser", "explorer", "sidechat", "git"]);
  });

  it("offers the simulator only when the server can host one", () => {
    // Off macOS there is nothing the user could do from this machine to make
    // simulators work, so the entry is hidden rather than shown disabled.
    expect(
      resolveRightDockLauncherItems({
        hasWorkspace: true,
        hasGitRepository: false,
        hasReview: false,
        hasDeviceSupport: true,
      }).map(({ kind }) => kind),
    ).toEqual(["terminal", "browser", "explorer", "sidechat", "device"]);

    expect(
      resolveRightDockLauncherItems({
        hasWorkspace: true,
        hasGitRepository: false,
        hasReview: false,
        hasDeviceSupport: false,
      }).map(({ kind }) => kind),
    ).not.toContain("device");
  });
});

describe("buildRightDockPaneLabelOverrides", () => {
  it("uses the embedded sidechat thread title for its hidden-header tab", () => {
    const pane = makePane({
      id: "sidechat:thread-child",
      kind: "sidechat",
      threadId: "thread-child" as ThreadId,
    });

    const overrides = buildRightDockPaneLabelOverrides(
      [pane],
      [{ id: "thread-child", title: "Investigate the parser" }],
    );

    expect(resolveRightDockPaneLabel(pane, overrides)).toBe("Investigate the parser");
  });

  it("keeps the generic sidechat label until the child thread is hydrated", () => {
    const pane = makePane({
      id: "sidechat:thread-child",
      kind: "sidechat",
      threadId: "thread-child" as ThreadId,
    });

    const overrides = buildRightDockPaneLabelOverrides([pane], []);

    expect(overrides).toBeUndefined();
    expect(resolveRightDockPaneLabel(pane, overrides)).toBe("Side chats");
  });
});
