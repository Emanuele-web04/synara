// FILE: moveThreadToProject.ts
// Purpose: Move an ordinary thread between ordinary projects from the sidebar thread menu.
// Layer: Web domain helper
// Why: The server validates the same rules inside `thread.meta.update`; these helpers keep
//      the menu listing and the dispatch path in one place so the menu cannot offer a move
//      the decider would reject.

import type { ProjectId, ThreadId } from "@synara/contracts";

import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { Project, Thread } from "~/types";

/** Ordinary projects the thread may move into: ordinary targets only, current excluded. */
export function resolveMoveToProjectTargets(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly currentProjectId: ProjectId;
  readonly workspacePaths: ServerWorkspacePaths;
}): Project[] {
  return input.projects
    .filter(
      (project) =>
        project.id !== input.currentProjectId &&
        isOrdinarySpaceProject(project, input.workspacePaths),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Threads may leave ordinary projects only: hub, Studio, and chat containers own their
 * chats, and coordinator/subagent threads stay with the structure that spawned them.
 */
export function canMoveThreadToProject(input: {
  readonly thread: Pick<Thread, "parentThreadId">;
  readonly sourceProject: Project | null | undefined;
  readonly workspacePaths: ServerWorkspacePaths;
  readonly isCoordinatorThread: boolean;
}): boolean {
  return (
    input.thread.parentThreadId == null &&
    !input.isCoordinatorThread &&
    isOrdinarySpaceProject(input.sourceProject, input.workspacePaths)
  );
}

export type MoveThreadToProjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export async function moveThreadToProject(input: {
  readonly threadId: ThreadId;
  readonly targetProjectId: ProjectId;
}): Promise<MoveThreadToProjectResult> {
  const api = readNativeApi();
  if (!api) {
    return { ok: false, message: "The Synara API is unavailable." };
  }
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      projectId: input.targetProjectId,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The move failed.",
    };
  }
}
