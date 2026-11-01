// FILE: spaces.ts
// Purpose: The Spaces domain for the web client — which projects Spaces organize, plus the
//          durable commands that move them around.
// Layer: Web domain helper

import {
  SPACE_PROJECTS_ASSIGN_MAX_COUNT,
  type NativeApi,
  type ProjectId,
  type SpaceIconName,
  type SpaceId,
} from "@synara/contracts";

import type { Project } from "~/types";
import { isHomeChatContainerProject } from "~/lib/chatProjects";
import { isGroupContainerProject } from "~/lib/groupProjects";
import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";
import { newCommandId, newSpaceId } from "~/lib/utils";
import { useStore } from "~/store";
import { requestShellSnapshotRefresh } from "~/routeRestoreRefreshCoordinator";

type PendingProjectSpaceMove = {
  readonly spaceId: SpaceId | null;
  readonly receipt: Promise<{ readonly sequence: number }>;
};
const pendingProjectSpaceMoves = new Map<ProjectId, PendingProjectSpaceMove>();

// Receipts precede shell pushes; keep only unconfirmed membership, not a second project store.
async function trackProjectSpaceMove(
  projectIds: readonly ProjectId[],
  spaceId: SpaceId | null,
  receipt: Promise<{ readonly sequence: number }>,
): Promise<void> {
  const move = { spaceId, receipt };
  const previousMoves = projectIds.map((projectId) => pendingProjectSpaceMoves.get(projectId));
  for (const projectId of projectIds) pendingProjectSpaceMoves.set(projectId, move);
  try {
    await receipt;
  } catch (error) {
    for (const [index, projectId] of projectIds.entries()) {
      if (pendingProjectSpaceMoves.get(projectId) === move) {
        const previous = previousMoves[index];
        if (previous) pendingProjectSpaceMoves.set(projectId, previous);
        else pendingProjectSpaceMoves.delete(projectId);
      }
    }
    throw error;
  }
}

/** Refresh only when a local Space move could make a close-action fallback read stale membership. */
export async function reconcilePendingProjectSpaceMoves(): Promise<boolean> {
  const moves = [...pendingProjectSpaceMoves];
  if (moves.length === 0) return true;
  const receipts = await Promise.allSettled(moves.map(([, move]) => move.receipt));
  const projectById = new Map(useStore.getState().projects.map((project) => [project.id, project]));
  const needsRefresh = moves.some(
    ([projectId, move], index) =>
      receipts[index]?.status === "fulfilled" &&
      pendingProjectSpaceMoves.get(projectId) === move &&
      (!projectById.has(projectId) ||
        (projectById.get(projectId)?.spaceId ?? null) !== move.spaceId),
  );
  if (needsRefresh) {
    try {
      const minSequence = Math.max(
        ...receipts.flatMap((receipt) =>
          receipt.status === "fulfilled" ? [receipt.value.sequence] : [],
        ),
      );
      if (!(await requestShellSnapshotRefresh(minSequence))) return false;
    } catch {
      // The close succeeded; keep its route rather than select a chat using stale membership.
      return false;
    }
  }
  for (const [projectId, move] of moves) {
    if (pendingProjectSpaceMoves.get(projectId) === move) {
      pendingProjectSpaceMoves.delete(projectId);
    }
  }
  // A newer move started during the refresh; leave navigation for its confirmed membership.
  return pendingProjectSpaceMoves.size === 0;
}

/**
 * Spaces organize ordinary projects only: the Chats and Groups containers are reachable
 * from every Space and so belong to none. This is the membership rule the whole feature
 * turns on — the sidebar list, the tab activity dots, the pickers, and the shortcut
 * targets all have to agree on it, so it lives here rather than being spelled out again
 * at each call site.
 */
export function isOrdinarySpaceProject(
  project: Project | null | undefined,
  paths: ServerWorkspacePaths,
): project is Project {
  return (
    project?.kind === "project" &&
    !isHomeChatContainerProject(project, paths) &&
    !isGroupContainerProject(project, paths)
  );
}

export async function createSpace(input: {
  api: NativeApi;
  name: string;
  icon: SpaceIconName;
}): Promise<{ spaceId: SpaceId; sequence: number }> {
  const spaceId = newSpaceId();
  const receipt = await input.api.orchestration.dispatchCommand({
    type: "space.create",
    commandId: newCommandId(),
    spaceId,
    name: input.name,
    icon: input.icon,
    createdAt: new Date().toISOString(),
  });
  return { spaceId, sequence: receipt.sequence };
}

/**
 * Fields left undefined are not sent, so an icon-only edit cannot collide with a
 * concurrent rename from another window (and vice versa).
 */
export async function updateSpace(input: {
  api: NativeApi;
  spaceId: SpaceId;
  name?: string | undefined;
  icon?: SpaceIconName | undefined;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "space.meta.update",
    commandId: newCommandId(),
    spaceId: input.spaceId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
  });
}

export async function deleteSpace(input: { api: NativeApi; spaceId: SpaceId }): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "space.delete",
    commandId: newCommandId(),
    spaceId: input.spaceId,
  });
}

export async function reorderSpaces(input: {
  api: NativeApi;
  movedSpaceId: SpaceId;
  orderedSpaceIds: ReadonlyArray<SpaceId>;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "space.reorder",
    commandId: newCommandId(),
    spaceId: input.movedSpaceId,
    orderedSpaceIds: [...input.orderedSpaceIds],
  });
}

export async function moveProjectToSpace(input: {
  api: NativeApi;
  projectId: ProjectId;
  spaceId: SpaceId | null;
}): Promise<void> {
  await trackProjectSpaceMove(
    [input.projectId],
    input.spaceId,
    input.api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId: input.projectId,
      spaceId: input.spaceId,
    }),
  );
}

/**
 * Files projects into a space as one atomic command per chunk (the command payload is
 * capped, so oversized selections split). A chunk either fully applies or fully fails;
 * on the first failure the remaining chunks are not attempted and everything not yet
 * processed is reported back for retry. The server may skip projects that are already
 * settled (assigned to the target or deleted), so a successful chunk must not be used
 * to infer an exact count of projects whose assignment changed.
 */
export async function moveProjectsToSpace(input: {
  api: NativeApi;
  projectIds: ReadonlyArray<ProjectId>;
  spaceId: SpaceId;
}): Promise<{ failedProjectIds: ProjectId[] }> {
  for (
    let offset = 0;
    offset < input.projectIds.length;
    offset += SPACE_PROJECTS_ASSIGN_MAX_COUNT
  ) {
    const chunk = input.projectIds.slice(offset, offset + SPACE_PROJECTS_ASSIGN_MAX_COUNT);
    try {
      await trackProjectSpaceMove(
        chunk,
        input.spaceId,
        input.api.orchestration.dispatchCommand({
          type: "space.projects.assign",
          commandId: newCommandId(),
          spaceId: input.spaceId,
          projectIds: chunk,
        }),
      );
    } catch {
      const remainingProjectIds = input.projectIds.slice(offset);
      // A transport error can race a committed command. Re-read the authoritative shell
      // before offering a retry so we do not report projects that already reached the target.
      try {
        const snapshot = await input.api.orchestration.getShellSnapshot();
        const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
        return {
          failedProjectIds: remainingProjectIds.filter((projectId) => {
            const project = projectById.get(projectId);
            // Missing shell rows were deleted concurrently and are settled just like rows
            // already assigned to the target; neither should be offered for a doomed retry.
            return project !== undefined && project.spaceId !== input.spaceId;
          }),
        };
      } catch {
        return { failedProjectIds: remainingProjectIds };
      }
    }
  }
  return { failedProjectIds: [] };
}
