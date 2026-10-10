// Stable build: Groups is off, so a group folder reads as an ordinary project.
import { type ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock(import("../betaFeatures"), async (importOriginal) => ({
  ...(await importOriginal()),
  GROUPS_ON: false,
}));

import type { Project } from "../types";
import { isGroupContainerProject } from "./groupProjects";

describe("isGroupContainerProject on Stable", () => {
  it("treats a group folder as an ordinary project", () => {
    const project = {
      id: "project-group" as ProjectId,
      kind: "group",
      cwd: "/Users/tester/Documents/Synara/Groups/release",
    } as unknown as Project;
    expect(
      isGroupContainerProject(project, {
        homeDir: "/Users/tester",
        groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
      }),
    ).toBe(false);
  });
});
