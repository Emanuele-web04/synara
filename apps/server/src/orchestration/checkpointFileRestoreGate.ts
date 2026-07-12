import type { OrchestrationCommand, OrchestrationEvent } from "@synara/contracts";
import { CommandId } from "@synara/contracts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const CHECKPOINT_FILE_RESTORE_PENDING_DETAIL =
  "A checkpoint file restore is still pending. Wait for Synara to confirm it is safe to continue before starting workspace or provider mutations.";

const BLOCKED_ORCHESTRATION_COMMAND_TYPES = new Set<OrchestrationCommand["type"]>([
  "project.create",
  "project.meta.update",
  "thread.delete",
  "thread.turn.start",
  "thread.turn.dispatch-queued",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.checkpoint.files.restore.prepare",
  "thread.checkpoint.files.restore",
  "thread.conversation.rollback",
  "thread.message.edit-and-resend",
]);

function pendingCheckpointFileRestoreRequestCommandIds(
  events: Iterable<OrchestrationEvent>,
): Set<CommandId> {
  const pendingRequestCommandIds = new Set<CommandId>();
  const terminalRequestCommandIds = new Set<CommandId>();

  for (const event of events) {
    switch (event.type) {
      case "thread.checkpoint-files-restore-prepared":
        if (!terminalRequestCommandIds.has(event.payload.requestCommandId)) {
          pendingRequestCommandIds.add(event.payload.requestCommandId);
        }
        break;
      case "thread.checkpoint-files-restore-requested":
        if (event.commandId !== null && !terminalRequestCommandIds.has(event.commandId)) {
          pendingRequestCommandIds.add(event.commandId);
        }
        break;
      case "thread.checkpoint-files-restore-reconciliation-requested":
        if (!terminalRequestCommandIds.has(event.payload.requestCommandId)) {
          pendingRequestCommandIds.add(event.payload.requestCommandId);
        }
        break;
      case "thread.checkpoint-files-restored":
        terminalRequestCommandIds.add(event.payload.requestCommandId);
        pendingRequestCommandIds.delete(event.payload.requestCommandId);
        break;
      case "thread.checkpoint-files-restore-failed":
        if (event.payload.requiresWorkspaceReview) {
          if (!terminalRequestCommandIds.has(event.payload.requestCommandId)) {
            pendingRequestCommandIds.add(event.payload.requestCommandId);
          }
        } else {
          terminalRequestCommandIds.add(event.payload.requestCommandId);
          pendingRequestCommandIds.delete(event.payload.requestCommandId);
        }
        break;
      case "thread.checkpoint-files-restore-reviewed":
        terminalRequestCommandIds.add(event.payload.requestCommandId);
        pendingRequestCommandIds.delete(event.payload.requestCommandId);
        break;
      default:
        break;
    }
  }

  return pendingRequestCommandIds;
}

export function hasPendingCheckpointFileRestore(events: Iterable<OrchestrationEvent>): boolean {
  const pendingRequestCommandIds = pendingCheckpointFileRestoreRequestCommandIds(events);
  return pendingRequestCommandIds.size > 0;
}

export function hasRecordedOrchestrationCommand(
  events: Iterable<OrchestrationEvent>,
  commandId: CommandId,
): boolean {
  for (const event of events) {
    if (event.commandId === commandId) {
      return true;
    }
  }
  return false;
}

export function shouldBlockCommandForPendingCheckpointFileRestore(
  events: Iterable<OrchestrationEvent>,
  commandType: string,
  options?: {
    readonly allowRecordedCommandId?: CommandId;
    readonly allowRequestCommandId?: CommandId;
  },
): boolean {
  const eventList = Array.from(events);
  if (!isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(commandType)) {
    return false;
  }
  const pendingRequestCommandIds = pendingCheckpointFileRestoreRequestCommandIds(eventList);
  if (pendingRequestCommandIds.size === 0) {
    return false;
  }
  if (
    options?.allowRequestCommandId !== undefined &&
    pendingRequestCommandIds.size === 1 &&
    pendingRequestCommandIds.has(options.allowRequestCommandId)
  ) {
    return false;
  }
  if (
    options?.allowRecordedCommandId !== undefined &&
    hasRecordedOrchestrationCommand(eventList, options.allowRecordedCommandId)
  ) {
    return false;
  }
  return true;
}

export function isOrchestrationCommandBlockedByPendingCheckpointFileRestore(
  command: OrchestrationCommand,
): boolean {
  return isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(command.type);
}

export function isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(
  commandType: string,
): boolean {
  return BLOCKED_ORCHESTRATION_COMMAND_TYPES.has(commandType as OrchestrationCommand["type"]);
}

export function makePendingCheckpointFileRestoreCommandError(commandType: string) {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail: CHECKPOINT_FILE_RESTORE_PENDING_DETAIL,
  });
}
