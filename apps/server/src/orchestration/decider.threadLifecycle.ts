// Purpose: Decider handlers for thread lifecycle and metadata commands
//   (create, handoff/fork, delete, archive/unarchive, meta/mode updates).
// Layer: orchestration (event-sourcing decider). Pure event derivation, no I/O.
// Exports: decideThreadLifecycleCommand.

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { hasNativeHandoffMessages } from "./handoff.ts";
import {
  requireProject,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import {
  deriveCommandAssociatedWorktreeMetadata,
  deriveCommandAssociatedWorktreeMetadataPatch,
  nowIso,
  withEventBase,
  type DeciderReturn,
} from "./decider.shared.ts";

type ThreadLifecycleCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.create"
      | "thread.handoff.create"
      | "thread.fork.create"
      | "thread.delete"
      | "thread.archive"
      | "thread.unarchive"
      | "thread.meta.update"
      | "thread.runtime-mode.set"
      | "thread.interaction-mode.set";
  }
>;

export const decideThreadLifecycleCommand = Effect.fn("decideThreadLifecycleCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadLifecycleCommand;
  readonly readModel: OrchestrationReadModel;
}): DeciderReturn {
  switch (command.type) {
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
          isPinned: command.isPinned,
          parentThreadId: command.parentThreadId,
          subagentAgentId: command.subagentAgentId,
          subagentNickname: command.subagentNickname,
          subagentRole: command.subagentRole,
          forkSourceThreadId: null,
          lastKnownPr: command.lastKnownPr,
          reviewChatTarget: command.reviewChatTarget,
          runtimePlan: command.runtimePlan,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return createdEvent;
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
          runtimePlan: command.runtimePlan,
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
          runtimePlan: command.runtimePlan,
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
          ...(command.reviewChatTarget !== undefined
            ? { reviewChatTarget: command.reviewChatTarget }
            : {}),
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
