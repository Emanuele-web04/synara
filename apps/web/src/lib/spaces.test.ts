// FILE: spaces.test.ts
// Purpose: Verifies web-client Space command batching and partial-failure reporting.

import {
  SPACE_PROJECTS_ASSIGN_MAX_COUNT,
  type NativeApi,
  type ProjectId,
  SpaceId,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projection = vi.hoisted(() => ({
  projects: [] as { id: ProjectId; spaceId: string | null }[],
  refreshShell: vi.fn(),
}));

vi.mock("~/store", () => ({
  useStore: {
    getState: () => ({
      projects: projection.projects,
    }),
  },
}));

vi.mock("~/routeRestoreRefreshCoordinator", () => ({
  requestShellSnapshotRefresh: projection.refreshShell,
}));

import {
  moveProjectToSpace,
  moveProjectsToSpace,
  reconcilePendingProjectSpaceMoves,
} from "./spaces";

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

describe("close-action Space membership fence", () => {
  const projectId = "project-close-race" as ProjectId;
  const targetSpaceId = SpaceId.makeUnsafe("space-after-move");

  beforeEach(async () => {
    // Finish receipts left by the batching cases without a production-only reset hook.
    projection.refreshShell.mockResolvedValue(true);
    await reconcilePendingProjectSpaceMoves();
    projection.refreshShell.mockReset();
    projection.projects = [{ id: projectId, spaceId: null }];
  });

  it.each(["single", "bulk"] as const)(
    "waits for a %s move receipt and refreshes membership once before closing a chat",
    async (kind) => {
      let accept!: (receipt: { sequence: number }) => void;
      const dispatchCommand = vi.fn(
        () =>
          new Promise<{ sequence: number }>((resolve) => {
            accept = resolve;
          }),
      );
      const getShellSnapshot = vi.fn().mockResolvedValue({
        snapshotSequence: 42,
        projects: [{ id: projectId, spaceId: targetSpaceId }],
      });
      projection.refreshShell.mockImplementation(async (minSequence: number) => {
        const snapshot = await getShellSnapshot();
        expect(snapshot.snapshotSequence).toBeGreaterThanOrEqual(minSequence);
        projection.projects = snapshot.projects;
        return true;
      });
      const api = makeApi(dispatchCommand, getShellSnapshot);
      const move =
        kind === "single"
          ? moveProjectToSpace({ api, projectId, spaceId: targetSpaceId })
          : moveProjectsToSpace({ api, projectIds: [projectId], spaceId: targetSpaceId });
      const closing = reconcilePendingProjectSpaceMoves();
      await Promise.resolve();
      expect(getShellSnapshot).not.toHaveBeenCalled();

      accept({ sequence: 42 });
      await move;
      await expect(closing).resolves.toBe(true);
      expect(projection.projects).toEqual([{ id: projectId, spaceId: targetSpaceId }]);
      await reconcilePendingProjectSpaceMoves();
      expect(getShellSnapshot).toHaveBeenCalledOnce();
    },
  );

  it("does not refresh when the accepted move to Void is already projected", async () => {
    const getShellSnapshot = vi.fn();
    const api = makeApi(vi.fn().mockResolvedValue({ sequence: 42 }), getShellSnapshot);
    await moveProjectToSpace({ api, projectId, spaceId: null });

    await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(true);
    expect(getShellSnapshot).not.toHaveBeenCalled();
  });

  it("drops rejected moves without waiting for a projection that will never arrive", async () => {
    const getShellSnapshot = vi.fn();
    const api = makeApi(vi.fn().mockRejectedValue(new Error("move rejected")), getShellSnapshot);
    await expect(moveProjectToSpace({ api, projectId, spaceId: targetSpaceId })).rejects.toThrow(
      "move rejected",
    );

    await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(true);
    expect(getShellSnapshot).not.toHaveBeenCalled();
  });

  it.each(["same project", "another project"] as const)(
    "keeps navigation fenced when a move for %s starts during refresh",
    async (kind) => {
      const api = makeApi(vi.fn().mockResolvedValue({ sequence: 42 }));
      await moveProjectToSpace({ api, projectId, spaceId: targetSpaceId });
      let newerMove: Promise<void> | null = null;
      projection.refreshShell.mockImplementationOnce(async () => {
        newerMove = moveProjectToSpace({
          api,
          projectId: kind === "same project" ? projectId : ("newly-moving-project" as ProjectId),
          spaceId: SpaceId.makeUnsafe("newer-space"),
        });
        return true;
      });

      await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(false);
      await newerMove;
      projection.refreshShell.mockResolvedValue(true);
      await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(true);
    },
  );

  it("keeps the fallback fenced until an unavailable or stale refresh can be confirmed", async () => {
    const getShellSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ snapshotSequence: 41, projects: [] })
      .mockResolvedValueOnce({
        snapshotSequence: 42,
        projects: [{ id: projectId, spaceId: targetSpaceId }],
      });
    const api = makeApi(vi.fn().mockResolvedValue({ sequence: 42 }), getShellSnapshot);
    projection.refreshShell.mockImplementation(async (minSequence: number) => {
      const snapshot = await getShellSnapshot();
      if (snapshot.snapshotSequence < minSequence) return false;
      projection.projects = snapshot.projects;
      return true;
    });
    await moveProjectToSpace({ api, projectId, spaceId: targetSpaceId });

    await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(false);
    await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(false);
    expect(projection.projects).toEqual([{ id: projectId, spaceId: null }]);
    await expect(reconcilePendingProjectSpaceMoves()).resolves.toBe(true);
    expect(projection.projects).toEqual([{ id: projectId, spaceId: targetSpaceId }]);
  });
});
