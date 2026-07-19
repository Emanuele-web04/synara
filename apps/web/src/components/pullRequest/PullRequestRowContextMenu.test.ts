import type { PullRequestListEntry } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { derivePullRequestRowContextMenuActions } from "./PullRequestRowContextMenu";

const entry = { state: "open" } as PullRequestListEntry;

describe("derivePullRequestRowContextMenuActions", () => {
  it("offers creation only for an unassociated open pull request", () => {
    const actions = derivePullRequestRowContextMenuActions({
      entry,
      association: null,
      canArchiveAssociatedWorkspace: false,
    });
    expect(Object.keys(actions)).toEqual([
      "open-on-github",
      "copy-link",
      "review-in-new-workspace",
    ]);
  });

  it("opens active workspaces and creates sibling review conversations", () => {
    const actions = derivePullRequestRowContextMenuActions({
      entry,
      association: "active",
      canArchiveAssociatedWorkspace: false,
    });
    expect(actions["open-workspace"]?.label).toBe("Open workspace");
    expect(actions["new-review-conversation"]?.label).toBe("New review conversation");
    expect(actions["review-in-new-workspace"]).toBeUndefined();
  });

  it("restores archived workspaces without offering a duplicate review workspace", () => {
    const actions = derivePullRequestRowContextMenuActions({
      entry,
      association: "archived",
      canArchiveAssociatedWorkspace: false,
    });
    expect(actions["restore-workspace"]?.label).toBe("Restore workspace");
    expect(actions["review-in-new-workspace"]).toBeUndefined();
  });

  it("archives an active managed workspace only after its pull request is merged", () => {
    const actions = derivePullRequestRowContextMenuActions({
      entry: { ...entry, state: "merged" },
      association: "active",
      canArchiveAssociatedWorkspace: true,
    });
    expect(actions["archive-workspace"]?.label).toBe("Archive workspace");
    expect(
      derivePullRequestRowContextMenuActions({
        entry,
        association: "active",
        canArchiveAssociatedWorkspace: true,
      })["archive-workspace"],
    ).toBeUndefined();
  });
});
