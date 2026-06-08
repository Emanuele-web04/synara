import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadMarker,
} from "@t3tools/contracts";
import {
  MAX_PINNED_PROJECTS,
  PINNED_MESSAGES_MAX_COUNT,
  THREAD_MARKERS_MAX_COUNT,
  TurnId,
} from "@t3tools/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  deriveAssociatedWorktreeMetadataPatch,
} from "@t3tools/shared/threadWorkspace";
import { doThreadMarkerRangesOverlap } from "@t3tools/shared/threadMarkers";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@t3tools/shared/conversationEdit";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { hasNativeHandoffMessages } from "./handoff.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import {
  listActiveProjectsByWorkspaceRoot,
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireProjectHasNoThreads,
  requireProjectWorkspaceRootAvailable,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function omitNullUserInputAnswers(
  command: Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>,
) {
  return Object.fromEntries(
    Object.entries(command.answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

function countPinnedProjects(
  readModel: OrchestrationReadModel,
  options?: { readonly excludeProjectIds?: ReadonlySet<string> },
): number {
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      project.kind === "project" &&
      project.isPinned === true &&
      !options?.excludeProjectIds?.has(project.id),
  ).length;
}

function validateProjectPinLimit(input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "project.create" | "project.meta.update" }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly projectId: OrchestrationEvent["aggregateId"];
  readonly nextKind: "project" | "chat";
  readonly nextDeletedAt?: string | null;
  readonly wasPinned?: boolean;
  readonly staleProjectIds?: ReadonlySet<string>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.command.isPinned !== true) {
    return Effect.void;
  }

  if (input.nextKind !== "project") {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Only projects can be pinned.`,
      }),
    );
  }

  if (input.nextDeletedAt !== undefined && input.nextDeletedAt !== null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Deleted project '${input.projectId}' cannot be pinned.`,
      }),
    );
  }

  if (input.wasPinned === true) {
    return Effect.void;
  }

  const excludeProjectIds = new Set<string>([input.projectId, ...(input.staleProjectIds ?? [])]);
  const pinnedProjectCount = countPinnedProjects(input.readModel, { excludeProjectIds });
  if (pinnedProjectCount < MAX_PINNED_PROJECTS) {
    return Effect.void;
  }

  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Only ${MAX_PINNED_PROJECTS} projects can be pinned at once.`,
    }),
  );
}

function deriveCommandAssociatedWorktreeMetadata(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadata({
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

function deriveCommandAssociatedWorktreeMetadataPatch(input: {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadataPatch({
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

function deriveConversationRollbackTarget(
  messages: OrchestrationReadModel["threads"][number]["messages"],
  messageId: string,
): {
  readonly role: OrchestrationReadModel["threads"][number]["messages"][number]["role"];
  readonly removedTurnIds: ReadonlySet<string>;
} | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return null;
  }

  return {
    role: messages[targetIndex]!.role,
    removedTurnIds: new Set(collectTailTurnIds({ messages, messageId })),
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const staleProjects: Array<OrchestrationReadModel["projects"][number]> = [];
      if ((command.kind ?? "project") === "project") {
        const existingProjects = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
        );
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
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: command.kind ?? "project",
        staleProjectIds: new Set(staleProjects.map((project) => project.id)),
      });

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
          isPinned: command.isPinned,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      });
      return events.length === 1 ? events[0]! : events;
    }

    case "project.meta.update": {
      const existingProject = yield* requireProject({
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
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: command.kind ?? existingProject.kind ?? "project",
        nextDeletedAt: existingProject.deletedAt,
        wasPinned: existingProject.isPinned === true,
      });
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
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
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

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: command.isPinned,
          parentThreadId: command.parentThreadId,
          subagentAgentId: command.subagentAgentId,
          subagentNickname: command.subagentNickname,
          subagentRole: command.subagentRole,
          forkSourceThreadId: null,
          lastKnownPr: command.lastKnownPr,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.handoff.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }
      if (sourceThread.handoff !== null && !hasNativeHandoffMessages(sourceThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' must contain at least one native chat message after handoff before it can be handed off again.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          handoff: {
            sourceThreadId: command.sourceThreadId,
            sourceProvider: sourceThread.modelSelection.provider,
            importedAt: command.createdAt,
            bootstrapStatus: "pending",
          },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        command.importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "handoff-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.fork.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...deriveCommandAssociatedWorktreeMetadata({
            branch: command.branch,
            worktreePath: command.worktreePath,
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          createBranchFlowCompleted: command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: command.sourceThreadId,
          sidechatSourceThreadId: command.sidechatSourceThreadId,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        command.importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "fork-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.envMode !== undefined ? { envMode: command.envMode } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...deriveCommandAssociatedWorktreeMetadataPatch({
            ...(command.branch !== undefined ? { branch: command.branch } : {}),
            ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
            ...(command.associatedWorktreePath !== undefined
              ? { associatedWorktreePath: command.associatedWorktreePath }
              : {}),
            ...(command.associatedWorktreeBranch !== undefined
              ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
              : {}),
            ...(command.associatedWorktreeRef !== undefined
              ? { associatedWorktreeRef: command.associatedWorktreeRef }
              : {}),
          }),
          ...(command.createBranchFlowCompleted !== undefined
            ? { createBranchFlowCompleted: command.createBranchFlowCompleted }
            : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          ...(command.handoff !== undefined ? { handoff: command.handoff } : {}),
          ...(command.lastKnownPr !== undefined ? { lastKnownPr: command.lastKnownPr } : {}),
          ...(command.pinnedMessages !== undefined
            ? { pinnedMessages: command.pinnedMessages }
            : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingPin = thread.pinnedMessages?.find((pin) => pin.messageId === command.messageId);
      if (!existingPin && (thread.pinnedMessages?.length ?? 0) >= PINNED_MESSAGES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${PINNED_MESSAGES_MAX_COUNT} pinned messages.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-added",
        payload: {
          threadId: command.threadId,
          pin: existingPin ?? {
            messageId: command.messageId,
            label: null,
            done: false,
            pinnedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-removed",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-done-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-label-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.endOffset <= command.startOffset) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Marker end offset must be greater than start offset.`,
        });
      }
      let existingMarker: ThreadMarker | undefined = undefined;
      let replacedMarkerCount = 0;
      for (const marker of thread.threadMarkers ?? []) {
        if (
          marker.id === command.markerId ||
          (marker.messageId === command.messageId &&
            marker.startOffset === command.startOffset &&
            marker.endOffset === command.endOffset &&
            marker.style === command.style)
        ) {
          existingMarker = marker;
        }
        if (
          doThreadMarkerRangesOverlap(marker, {
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
          })
        ) {
          replacedMarkerCount += 1;
        }
      }
      if (
        !existingMarker &&
        (thread.threadMarkers?.length ?? 0) - replacedMarkerCount >= THREAD_MARKERS_MAX_COUNT
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${THREAD_MARKERS_MAX_COUNT} markers.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-added",
        payload: {
          threadId: command.threadId,
          marker: existingMarker ?? {
            id: command.markerId,
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
            selectedText: command.selectedText,
            style: command.style,
            color: command.color,
            label: null,
            done: false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-removed",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-done-set",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-label-set",
        payload: {
          threadId: command.threadId,
          markerId: command.markerId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      const dispatchMode = command.dispatchMode ?? "queue";
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(command.message.mentions !== undefined ? { mentions: command.message.mentions } : {}),
          dispatchMode,
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnRequestPayload = {
        threadId: command.threadId,
        messageId: command.message.messageId,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.providerOptions !== undefined
          ? { providerOptions: command.providerOptions }
          : {}),
        ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
        assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
        dispatchMode,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
        createdAt: command.createdAt,
      } as const;
      const activeProvider =
        targetThread.session?.providerName ?? targetThread.modelSelection.provider;
      const isThreadRunning =
        targetThread.session?.status === "running" && targetThread.session.activeTurnId !== null;
      const shouldQueue =
        isThreadRunning && (dispatchMode === "queue" || activeProvider !== "codex");
      const queuedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: shouldQueue ? "thread.turn-queued" : "thread.turn-start-requested",
        payload: turnRequestPayload,
      };
      if (shouldQueue && dispatchMode === "steer") {
        return [
          userMessageEvent,
          queuedEvent,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: queuedEvent.eventId,
            type: "thread.turn-interrupt-requested",
            payload: {
              threadId: command.threadId,
              turnId: targetThread.session?.activeTurnId ?? undefined,
              createdAt: command.createdAt,
            },
          },
        ];
      }
      return [userMessageEvent, queuedEvent];
    }

    case "thread.turn.dispatch-queued": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: command.dispatchMode ?? "queue",
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: command.sourceProposedPlan }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const answers = omitNullUserInputAnswers(command);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.conversation.rollback": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const rollbackTarget = deriveConversationRollbackTarget(thread.messages, command.messageId);
      if (!rollbackTarget || rollbackTarget.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Conversation rollback must target an existing user message.",
        });
      }
      if (command.numTurns <= 0 || rollbackTarget.removedTurnIds.size !== command.numTurns) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Conversation rollback requested ${command.numTurns} turn(s), but target message '${command.messageId}' would remove ${rollbackTarget.removedTurnIds.size} turn(s).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rollback-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.message.edit-and-resend": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const editTarget = resolveTailUserMessageEditTarget({
        messages: thread.messages,
        messageId: command.messageId,
        activeTurnId:
          thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null,
      });
      if (!editTarget.editable) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest rollbackable user message can be edited and resent (${editTarget.reason}).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-edit-resend-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          rollbackTurnCount: editTarget.rollbackTurnCount,
          removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: command.assistantDeliveryMode }
            : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.messages.import": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return command.messages.map((message) => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent" as const,
        payload: {
          threadId: command.threadId,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: null,
          streaming: false,
          source: "native" as const,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      }));
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: existingMessage?.text ?? "",
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.conversation.rollback.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rolled-back",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          ...(command.removedTurnIds !== undefined
            ? { removedTurnIds: command.removedTurnIds }
            : {}),
          ...(command.skipAttachmentPrune !== undefined
            ? { skipAttachmentPrune: command.skipAttachmentPrune }
            : {}),
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
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
