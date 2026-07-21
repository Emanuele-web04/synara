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
import { isStudioContainerProject } from "~/lib/studioProjects";
import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";
import { newCommandId, newSpaceId } from "~/lib/utils";

/**
 * Spaces organize ordinary projects only: the Chats and Studio containers are reachable
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
    !isStudioContainerProject(project, paths)
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
  await input.api.orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId: input.projectId,
    spaceId: input.spaceId,
  });
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
      await input.api.orchestration.dispatchCommand({
        type: "space.projects.assign",
        commandId: newCommandId(),
        spaceId: input.spaceId,
        projectIds: chunk,
      });
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
