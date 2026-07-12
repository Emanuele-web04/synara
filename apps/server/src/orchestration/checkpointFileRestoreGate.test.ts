import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  hasPendingCheckpointFileRestore,
  isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore,
  shouldBlockCommandForPendingCheckpointFileRestore,
} from "./checkpointFileRestoreGate.ts";

const threadId = ThreadId.makeUnsafe("thread-gate-test");
const messageId = MessageId.makeUnsafe("message-gate-test");
const requestCommandId = CommandId.makeUnsafe("cmd-gate-request");
const createdAt = "2026-07-12T13:00:00.000Z";

function base(sequence: number, commandId: CommandId | null) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`evt-gate-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
  };
}

function requested(sequence: number): OrchestrationEvent {
  return {
    ...base(sequence, requestCommandId),
    type: "thread.checkpoint-files-restore-requested",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      createdAt,
    },
  };
}

function prepared(sequence: number): OrchestrationEvent {
  return {
    ...base(sequence, CommandId.makeUnsafe(`cmd-prepare-${sequence}`)),
    type: "thread.checkpoint-files-restore-prepared",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      requestCommandId,
      createdAt,
    },
  };
}

function restored(sequence: number): OrchestrationEvent {
  return {
    ...base(sequence, CommandId.makeUnsafe(`cmd-terminal-${sequence}`)),
    type: "thread.checkpoint-files-restored",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      requestCommandId,
    },
  };
}

function failed(sequence: number, requiresWorkspaceReview: boolean): OrchestrationEvent {
  return {
    ...base(sequence, CommandId.makeUnsafe(`cmd-failed-${sequence}`)),
    type: "thread.checkpoint-files-restore-failed",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      requestCommandId,
      detail: "File restore failed.",
      requiresWorkspaceReview,
    },
  };
}

function reviewed(sequence: number): OrchestrationEvent {
  return {
    ...base(sequence, CommandId.makeUnsafe(`cmd-reviewed-${sequence}`)),
    type: "thread.checkpoint-files-restore-reviewed",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      requestCommandId,
      createdAt,
    },
  };
}

function reconcile(sequence: number): OrchestrationEvent {
  return {
    ...base(sequence, CommandId.makeUnsafe(`cmd-reconcile-${sequence}`)),
    type: "thread.checkpoint-files-restore-reconciliation-requested",
    payload: {
      threadId,
      messageId,
      turnCount: 0,
      requestCommandId,
      createdAt,
    },
  };
}

describe("checkpoint file restore gate", () => {
  it("keeps pending restores pending until a correlated terminal event", () => {
    expect(hasPendingCheckpointFileRestore([requested(1)])).toBe(true);
    expect(hasPendingCheckpointFileRestore([requested(1), restored(2)])).toBe(false);
  });

  it("keeps server reservations pending until they are used or explicitly reviewed", () => {
    expect(hasPendingCheckpointFileRestore([prepared(1)])).toBe(true);
    expect(hasPendingCheckpointFileRestore([prepared(1), reviewed(2)])).toBe(false);
    expect(hasPendingCheckpointFileRestore([prepared(1), requested(2), restored(3)])).toBe(false);
  });

  it("keeps review-required failures gated until explicit review unlock", () => {
    expect(hasPendingCheckpointFileRestore([requested(1), failed(2, true)])).toBe(true);
    expect(hasPendingCheckpointFileRestore([requested(1), failed(2, false)])).toBe(false);
    expect(hasPendingCheckpointFileRestore([requested(1), failed(2, true), reviewed(3)])).toBe(
      false,
    );
  });

  it("does not reopen the gate when reconciliation is logged after terminal state", () => {
    expect(hasPendingCheckpointFileRestore([requested(1), restored(2), reconcile(3)])).toBe(false);
    expect(
      hasPendingCheckpointFileRestore([requested(1), failed(2, true), reviewed(3), reconcile(4)]),
    ).toBe(false);
  });

  it("allows recorded command ids to reach receipt-based idempotency", () => {
    expect(
      shouldBlockCommandForPendingCheckpointFileRestore(
        [requested(1)],
        "thread.checkpoint.files.restore",
        { allowRecordedCommandId: requestCommandId },
      ),
    ).toBe(false);
    expect(
      shouldBlockCommandForPendingCheckpointFileRestore(
        [requested(1)],
        "thread.checkpoint.files.restore",
        { allowRecordedCommandId: CommandId.makeUnsafe("cmd-unrecorded-retry") },
      ),
    ).toBe(true);
    expect(
      shouldBlockCommandForPendingCheckpointFileRestore(
        [prepared(1)],
        "thread.checkpoint.files.restore",
        { allowRequestCommandId: requestCommandId },
      ),
    ).toBe(false);
    expect(
      shouldBlockCommandForPendingCheckpointFileRestore(
        [prepared(1)],
        "thread.checkpoint.files.restore",
        { allowRequestCommandId: CommandId.makeUnsafe("cmd-other-request") },
      ),
    ).toBe(true);
    expect(
      shouldBlockCommandForPendingCheckpointFileRestore(
        [requested(1), restored(2)],
        "thread.checkpoint.files.restore",
        { allowRecordedCommandId: CommandId.makeUnsafe("cmd-unrecorded-after-terminal") },
      ),
    ).toBe(false);
  });

  it("blocks orchestration commands that can start workspace or provider mutations", () => {
    expect(isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore("project.create")).toBe(
      true,
    );
    expect(
      isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore("project.meta.update"),
    ).toBe(true);
    expect(
      isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore("thread.turn.start"),
    ).toBe(true);
    expect(isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore("thread.delete")).toBe(
      true,
    );
    expect(
      isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(
        "thread.checkpoint.files.restore",
      ),
    ).toBe(true);
    expect(
      isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(
        "thread.checkpoint.files.restore.prepare",
      ),
    ).toBe(true);
    expect(isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore("thread.archive")).toBe(
      false,
    );
  });
});
