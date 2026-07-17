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
}): Promise<SpaceId> {
  const spaceId = newSpaceId();
  await input.api.orchestration.dispatchCommand({
    type: "space.create",
    commandId: newCommandId(),
    spaceId,
    name: input.name,
    icon: input.icon,
    createdAt: new Date().toISOString(),
  });
  return spaceId;
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
 * moved is reported back for retry.
 */
export async function moveProjectsToSpace(input: {
  api: NativeApi;
  projectIds: ReadonlyArray<ProjectId>;
  spaceId: SpaceId;
}): Promise<{ movedProjectIds: ProjectId[]; failedProjectIds: ProjectId[] }> {
  const movedProjectIds: ProjectId[] = [];
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
      movedProjectIds.push(...chunk);
    } catch {
      return { movedProjectIds, failedProjectIds: input.projectIds.slice(offset) };
    }
  }
  return { movedProjectIds, failedProjectIds: [] };
}
