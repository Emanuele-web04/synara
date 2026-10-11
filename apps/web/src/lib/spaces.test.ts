// FILE: spaces.test.ts
// Purpose: Verifies web-client Space command batching and partial-failure reporting.

import {
  SPACE_PROJECTS_ASSIGN_MAX_COUNT,
  type NativeApi,
  type ProjectId,
  SpaceId,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { moveProjectsToSpace } from "./spaces";

function makeApi(
  dispatchCommand: ReturnType<typeof vi.fn>,
  getShellSnapshot: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(new Error("offline")),
): NativeApi {
  return {
    orchestration: {
      dispatchCommand,
      getShellSnapshot,
    },
  } as unknown as NativeApi;
}

describe("moveProjectsToSpace", () => {
  it("reports only the failed and unattempted chunks without inventing a moved count", async () => {
    const projectIds = Array.from(
      { length: SPACE_PROJECTS_ASSIGN_MAX_COUNT + 2 },
      (_, index) => `project-${index}` as ProjectId,
    );
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({ sequence: 1 })
      .mockRejectedValueOnce(new Error("dispatch failed"));

    const result = await moveProjectsToSpace({
      api: makeApi(dispatchCommand),
      projectIds,
      spaceId: SpaceId.makeUnsafe("space-target"),
    });

    expect(result).toEqual({
      failedProjectIds: projectIds.slice(SPACE_PROJECTS_ASSIGN_MAX_COUNT),
    });
    expect(result).not.toHaveProperty("movedProjectIds");
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it("returns no failures when every chunk is accepted", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 1 });

    await expect(
      moveProjectsToSpace({
        api: makeApi(dispatchCommand),
        projectIds: ["project-1" as ProjectId, "project-2" as ProjectId],
        spaceId: SpaceId.makeUnsafe("space-target"),
      }),
    ).resolves.toEqual({ failedProjectIds: [] });
  });

  it("does not report projects that committed before a transport failure", async () => {
    const targetSpaceId = SpaceId.makeUnsafe("space-target");
    const projectIds = ["project-1", "project-2"] as ProjectId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getShellSnapshot = vi.fn().mockResolvedValue({
      projects: [
        { id: projectIds[0], spaceId: targetSpaceId },
        { id: projectIds[1], spaceId: null },
      ],
    });

    await expect(
      moveProjectsToSpace({
        api: makeApi(dispatchCommand, getShellSnapshot),
        projectIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedProjectIds: [projectIds[1]] });
    expect(getShellSnapshot).toHaveBeenCalledOnce();
  });

  it("does not report projects deleted concurrently with an ambiguous dispatch", async () => {
    const targetSpaceId = SpaceId.makeUnsafe("space-target");
    const projectIds = ["project-deleted", "project-still-active"] as ProjectId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getShellSnapshot = vi.fn().mockResolvedValue({
      projects: [{ id: projectIds[1], spaceId: null }],
    });

    await expect(
      moveProjectsToSpace({
        api: makeApi(dispatchCommand, getShellSnapshot),
        projectIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedProjectIds: [projectIds[1]] });
  });
});
