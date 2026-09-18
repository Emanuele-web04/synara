import { ProjectId, type OrchestrationProjectShell } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { relocateProjectFromClient } from "./projectRelocation";

const now = "2026-09-18T10:00:00.000Z";
const project: OrchestrationProjectShell = {
  id: ProjectId.makeUnsafe("project-1"),
  kind: "project",
  title: "Project",
  workspaceRoot: "/missing/repo",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  spaceId: null,
  createdAt: now,
  updatedAt: now,
};
const input = {
  projectId: project.id,
  previousWorkspaceRoot: project.workspaceRoot,
  workspaceRoot: "/restored/repo",
};
function api(projects: readonly OrchestrationProjectShell[] = [project]) {
  return {
    getShellSnapshot: vi.fn(async () => ({
      projects,
      threads: [],
      spaces: [],
      snapshotSequence: 0,
      updatedAt: now,
    })),
    dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
  };
}

describe("relocateProjectFromClient", () => {
  it("updates the same project and does not create folders, threads, or stop sessions", async () => {
    const client = api();
    await relocateProjectFromClient(client, { ...input, workspaceRoot: "  /restored/repo  " });
    expect(client.dispatchCommand).toHaveBeenCalledExactlyOnceWith({
      type: "project.meta.update",
      commandId: expect.any(String),
      projectId: project.id,
      workspaceRoot: "/restored/repo",
      createWorkspaceRootIfMissing: false,
    });
  });

  it("rejects stale, deleted, and managed project selections without dispatching", async () => {
    for (const projects of [
      [],
      [{ ...project, workspaceRoot: "/already/moved" }],
      [{ ...project, kind: "chat" as const }],
    ]) {
      const client = api(projects);
      await expect(relocateProjectFromClient(client, input)).rejects.toThrow();
      expect(client.dispatchCommand).not.toHaveBeenCalled();
    }
  });

  it("does nothing for an unchanged path and rejects an empty target", async () => {
    const client = api();
    await relocateProjectFromClient(client, { ...input, workspaceRoot: project.workspaceRoot });
    await expect(
      relocateProjectFromClient(client, { ...input, workspaceRoot: " " }),
    ).rejects.toThrow("Enter");
    expect(client.dispatchCommand).not.toHaveBeenCalled();
  });

  it("propagates server directory-validation failures", async () => {
    const client = api();
    client.dispatchCommand.mockRejectedValue(new Error("Directory does not exist"));
    await expect(relocateProjectFromClient(client, input)).rejects.toThrow(
      "Directory does not exist",
    );
  });
});
