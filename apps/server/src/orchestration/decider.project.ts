// Purpose: Decider handlers for project.* orchestration commands.
// Layer: orchestration (event-sourcing decider). Pure event derivation, no I/O.
// Exports: decideProjectCommand.

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listActiveProjectsByWorkspaceRoot,
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireProjectHasNoThreads,
  requireProjectWorkspaceRootAvailable,
} from "./commandInvariants.ts";
import { nowIso, withEventBase, type DeciderReturn } from "./decider.shared.ts";

type ProjectCommand = Extract<OrchestrationCommand, { type: `project.${string}` }>;

export const decideProjectCommand = Effect.fn("decideProjectCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ProjectCommand;
  readonly readModel: OrchestrationReadModel;
}): DeciderReturn {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if ((command.kind ?? "project") === "project") {
        const existingProjects = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
        );
        const staleProjects: Array<(typeof existingProjects)[number]> = [];
        for (const existingProject of existingProjects) {
          const remainingThreads = listThreadsByProjectId(readModel, existingProject.id).filter(
            (thread) => thread.deletedAt === null,
          );
          if (remainingThreads.length > 0) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
            });
          }
          staleProjects.push(existingProject);
        }

        for (const staleProject of staleProjects) {
          // A removed folder can leave an active project shell with no live threads.
          // Retire that stale shell so re-adding the same folder creates a fresh project.
          events.push({
            ...withEventBase({
              aggregateKind: "project",
              aggregateId: staleProject.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            type: "project.deleted",
            payload: {
              projectId: staleProject.id,
              deletedAt: command.createdAt,
            },
          });
        }
      }

      events.push({
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          kind: command.kind ?? "project",
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      });
      return events.length === 1 ? events[0]! : events;
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined && command.kind !== "chat") {
        yield* requireProjectWorkspaceRootAvailable({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          excludeProjectId: command.projectId,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.kind !== undefined ? { kind: command.kind } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireProjectHasNoThreads({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
