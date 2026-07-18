import { describe, expect, it } from "vitest";

import {
  getFirstEnabledProjectContextMenuActionId,
  getProjectContextMenuActionGroups,
  type ProjectContextMenuActions,
} from "./ProjectContextMenu";

describe("ProjectContextMenu", () => {
  it("keeps only canonical project-owned actions in their settled order", () => {
    expect(
      getProjectContextMenuActionGroups({
        "remove-project": { label: "Remove project", destructive: true },
        "toggle-pin": { label: "Pin project" },
        "copy-path": { label: "Copy repository path" },
        "new-workspace": { label: "New workspace" },
        "open-in-kanban": { label: "Open in Kanban" },
        "show-in-folder": { label: "Show repository in Finder" },
        "edit-project": { label: "Edit project" },
        "open-repository-on-github": { label: "Open repository on GitHub" },
      }),
    ).toEqual([
      [
        "new-workspace",
        "show-in-folder",
        "open-in-kanban",
        "open-repository-on-github",
        "copy-path",
      ],
      ["edit-project", "toggle-pin"],
      ["remove-project"],
    ]);
  });

  it("omits unavailable repository links and focuses the first enabled action", () => {
    const actions = {
      "new-workspace": { label: "New workspace", disabled: true },
      "show-in-folder": { label: "Show repository in Finder" },
      "remove-project": { label: "Remove project", destructive: true },
    } as const;

    expect(getProjectContextMenuActionGroups(actions).flat()).not.toContain(
      "open-repository-on-github",
    );
    expect(getFirstEnabledProjectContextMenuActionId(actions)).toBe("show-in-folder");
  });

  it("ignores legacy project dev and thread lifecycle actions from stale callers", () => {
    const actions = {
      "new-workspace": { label: "New workspace" },
      "start-dev": { label: "Start dev" },
      "stop-dev": { label: "Stop dev" },
      "open-dev-server": { label: "Open dev server" },
      "archive-threads": { label: "Archive threads" },
      "delete-threads": { label: "Delete threads" },
    } as unknown as ProjectContextMenuActions;

    expect(getProjectContextMenuActionGroups(actions).flat()).toEqual(["new-workspace"]);
  });
});
