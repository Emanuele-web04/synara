import { ProjectId, WorktreeWorkspaceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { projectDevServerTargetKey } from "./projectDevServers";

describe("projectDevServerTargetKey", () => {
  it("distinguishes workspaces within the same project", () => {
    const projectId = ProjectId.makeUnsafe("project-1");

    expect(
      projectDevServerTargetKey({
        projectId,
        workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
      }),
    ).not.toBe(
      projectDevServerTargetKey({
        projectId,
        workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-2"),
      }),
    );
  });

  it("cannot collide through delimiter-like entity ids", () => {
    expect(
      projectDevServerTargetKey({
        projectId: ProjectId.makeUnsafe("project:one"),
        workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace:two"),
      }),
    ).not.toBe(
      projectDevServerTargetKey({
        projectId: ProjectId.makeUnsafe("project"),
        workspaceId: WorktreeWorkspaceId.makeUnsafe("one:workspace:two"),
      }),
    );
  });

  it("gives the legacy project target its own stable key", () => {
    const target = {
      projectId: ProjectId.makeUnsafe("project-1"),
      workspaceId: null,
    };

    expect(projectDevServerTargetKey(target)).toBe(projectDevServerTargetKey(target));
    expect(projectDevServerTargetKey(target)).not.toContain("undefined");
  });
});
