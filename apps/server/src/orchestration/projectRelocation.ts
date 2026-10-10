// relinks imported project paths atomically without replacing conversation identities

import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { threadHasCheckpointRevertInProgress, threadHasInFlightTurn } from "./commandInvariants.ts";
import { relocateProjectPath } from "./projectRelocationPaths.ts";

type ProjectUpdatedEvent = Omit<
  Extract<OrchestrationEvent, { type: "project.meta-updated" }>,
  "sequence"
>;

/** the engine persists the batch together — no intermediate root/thread split */
export const withProjectRelocationEvents = Effect.fn("withProjectRelocationEvents")(
  function* (input: {
    readonly event: ProjectUpdatedEvent;
    readonly previousProject: OrchestrationProject;
    readonly readModel: OrchestrationReadModel;
  }) {
    const { event, previousProject, readModel } = input;
    const nextRoot = event.payload.workspaceRoot;
    if (
      nextRoot === undefined ||
      workspaceRootsEqual(previousProject.workspaceRoot, nextRoot, {
        platform: process.platform,
      }) ||
      (previousProject.kind ?? "project") !== "project" ||
      (event.payload.kind ?? previousProject.kind ?? "project") !== "project"
    )
      return event;

    const events: Array<Omit<OrchestrationEvent, "sequence">> = [event];
    for (const thread of readModel.threads) {
      if (thread.projectId !== previousProject.id || thread.deletedAt !== null) continue;
      if (threadHasInFlightTurn(thread) || threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "project.meta.update",
          detail:
            "Stop active turns and wait for checkpoint restores before changing the project path.",
        });
      }
      // moving a linked worktree requires repairing Git's gitdir/common-dir links — string replacement isn't a safe substitute for git worktree repair
      for (const worktree of [thread.worktreePath, thread.associatedWorktreePath]) {
        if (relocateProjectPath(worktree, previousProject.workspaceRoot, nextRoot) !== worktree) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: "project.meta.update",
            detail:
              "This project has linked Git worktrees inside its old folder. Move and repair those worktrees separately before changing the project path.",
          });
        }
      }
      const workingDirectory = relocateProjectPath(
        thread.workingDirectory,
        previousProject.workspaceRoot,
        nextRoot,
      );
      if (typeof workingDirectory !== "string" || workingDirectory === thread.workingDirectory)
        continue;
      events.push({
        ...event,
        eventId: EventId.makeUnsafe(crypto.randomUUID()),
        aggregateKind: "thread",
        aggregateId: thread.id,
        type: "thread.meta-updated",
        payload: { threadId: thread.id, workingDirectory, updatedAt: event.payload.updatedAt },
      });
    }
    return events.length === 1 ? event : events;
  },
);
