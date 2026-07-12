import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  WS_RPC_ERROR_CODES,
  WsRpcError,
  type OrchestrationEvent,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_FILE_RESTORE_BLOCKED_MESSAGE,
  checkpointFileRestoreStatusFromEvents,
  clearPendingCheckpointFileRestore,
  getPendingCheckpointFileRestoreSnapshot,
  hasPendingCheckpointFileRestore,
  isCheckpointFileRestoreReviewRequiredError,
  isStaleCheckpointFileRestoreConfirmation,
  isDefinitiveDispatchRejection,
  readPendingCheckpointFileRestore,
  savePendingCheckpointFileRestore,
  shouldReconcileCheckpointFileRestoreAcceptance,
  waitForCheckpointFileRestore,
} from "./checkpointFileRestore";

const requestCommandId = CommandId.makeUnsafe("restore-request");
const otherRequestCommandId = CommandId.makeUnsafe("other-restore-request");
const threadId = ThreadId.makeUnsafe("thread-1");
const messageId = MessageId.makeUnsafe("message-1");

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function eventBase(sequence: number) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: "2026-07-12T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function requestedEvent(sequence = 1): OrchestrationEvent {
  return {
    ...eventBase(sequence),
    commandId: requestCommandId,
    type: "thread.checkpoint-files-restore-requested",
    payload: {
      threadId,
      messageId,
      turnCount: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

function preparedEvent(sequence = 1): OrchestrationEvent {
  return {
    ...eventBase(sequence),
    type: "thread.checkpoint-files-restore-prepared",
    payload: {
      threadId,
      messageId,
      turnCount: 1,
      requestCommandId,
      createdAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

function successEvent(sequence = 2, commandId = requestCommandId): OrchestrationEvent {
  return {
    ...eventBase(sequence),
    type: "thread.checkpoint-files-restored",
    payload: {
      threadId,
      messageId,
      turnCount: 1,
      requestCommandId: commandId,
    },
  };
}

function reviewedEvent(sequence = 2): OrchestrationEvent {
  return {
    ...eventBase(sequence),
    type: "thread.checkpoint-files-restore-reviewed",
    payload: {
      threadId,
      messageId,
      turnCount: 1,
      requestCommandId,
      createdAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

function failureEvent(
  sequence = 2,
  detail = "Checkpoint is unavailable.",
  requiresWorkspaceReview = false,
): OrchestrationEvent {
  return {
    ...eventBase(sequence),
    type: "thread.checkpoint-files-restore-failed",
    payload: {
      threadId,
      messageId,
      turnCount: 1,
      requestCommandId,
      detail,
      requiresWorkspaceReview,
    },
  };
}

function makeHarness() {
  let listener: Parameters<
    Parameters<typeof waitForCheckpointFileRestore>[0]["subscribe"]
  >[0] = () => {};
  const wait = waitForCheckpointFileRestore({
    requestCommandId,
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
  });
  return { wait, listener };
}

describe("waitForCheckpointFileRestore", () => {
  it("resolves matching success and rejects matching failure immediately", async () => {
    const success = makeHarness();
    success.listener(successEvent());
    await expect(success.wait.promise).resolves.toBeUndefined();

    const failure = makeHarness();
    failure.listener(failureEvent());
    await expect(failure.wait.promise).rejects.toThrow("Checkpoint is unavailable.");
  });

  it("stays pending regardless of queue time until a terminal event arrives", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    let settled = false;
    void harness.wait.promise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);

    harness.listener(successEvent());
    await expect(harness.wait.promise).resolves.toBeUndefined();
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("shares one listener and reconciliation loop across mounted consumers", async () => {
    let listener: (event: OrchestrationEvent) => void = () => {};
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((next: (event: OrchestrationEvent) => void) => {
      listener = next;
      return unsubscribe;
    });
    const first = waitForCheckpointFileRestore({ requestCommandId, subscribe });
    const second = waitForCheckpointFileRestore({ requestCommandId, subscribe });

    expect(subscribe).toHaveBeenCalledTimes(1);
    first.cancel();
    expect(unsubscribe).not.toHaveBeenCalled();

    listener(successEvent());
    await expect(second.promise).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resolves a terminal status that was persisted while the live event was missed", async () => {
    vi.useFakeTimers();
    let status = checkpointFileRestoreStatusFromEvents({
      events: [requestedEvent()],
      threadId,
      requestCommandId,
    });
    const getStatus = vi.fn(async () => status);
    const wait = waitForCheckpointFileRestore({
      requestCommandId,
      subscribe: () => () => {},
      getStatus,
      reconcileIntervalMs: 100,
    });

    let settled = false;
    void wait.promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    status = checkpointFileRestoreStatusFromEvents({
      events: [requestedEvent(), successEvent()],
      threadId,
      requestCommandId,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait.promise).resolves.toBeUndefined();
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("rejects a terminal failure found by reconciliation", async () => {
    const wait = waitForCheckpointFileRestore({
      requestCommandId,
      subscribe: () => () => {},
      getStatus: async () =>
        checkpointFileRestoreStatusFromEvents({
          events: [requestedEvent(), failureEvent(2, "Session is inactive.")],
          threadId,
          requestCommandId,
        }),
    });

    await expect(wait.promise).rejects.toThrow("Session is inactive.");
  });

  it("preserves structured workspace-review requirements on terminal failure", async () => {
    const wait = waitForCheckpointFileRestore({
      requestCommandId,
      subscribe: (listener) => {
        listener(failureEvent(2, "Restart interrupted restore.", true));
        return () => {};
      },
    });

    await expect(wait.promise).rejects.toMatchObject({ requiresWorkspaceReview: true });
    await wait.promise.catch((error: unknown) => {
      expect(isCheckpointFileRestoreReviewRequiredError(error)).toBe(true);
    });
  });

  it("keeps waiting when reconciliation cannot prove a terminal state", async () => {
    vi.useFakeTimers();
    const wait = waitForCheckpointFileRestore({
      requestCommandId,
      subscribe: () => () => {},
      getStatus: async () =>
        checkpointFileRestoreStatusFromEvents({
          events: [successEvent(2, otherRequestCommandId)],
          threadId,
          requestCommandId,
        }),
      reconcileIntervalMs: 100,
    });

    let settled = false;
    void wait.promise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    wait.cancel();
    vi.useRealTimers();
  });

  it("does not leave a reconciliation interval after synchronous terminal replay", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () =>
      checkpointFileRestoreStatusFromEvents({
        events: [requestedEvent()],
        threadId,
        requestCommandId,
      }),
    );
    const wait = waitForCheckpointFileRestore({
      requestCommandId,
      subscribe: (listener) => {
        listener(successEvent());
        return () => {};
      },
      getStatus,
      reconcileIntervalMs: 100,
    });

    await expect(wait.promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(getStatus).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("checkpoint file restore status", () => {
  it("derives not-found, pending, succeeded, and failed from the persisted event log", () => {
    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [],
        threadId,
        requestCommandId,
      }),
    ).toEqual({ status: "not-found" });

    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [requestedEvent()],
        threadId,
        requestCommandId,
      }),
    ).toEqual({ status: "pending", sequence: 1 });

    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [preparedEvent()],
        threadId,
        requestCommandId,
      }),
    ).toEqual({ status: "pending", sequence: 1 });

    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [preparedEvent(1), reviewedEvent(2)],
        threadId,
        requestCommandId,
      }),
    ).toEqual({ status: "not-found" });

    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [requestedEvent(), successEvent()],
        threadId,
        requestCommandId,
      }),
    ).toEqual({ status: "succeeded", sequence: 2 });

    expect(
      checkpointFileRestoreStatusFromEvents({
        events: [requestedEvent(), failureEvent(3, "Missing checkpoint.")],
        threadId,
        requestCommandId,
      }),
    ).toEqual({
      status: "failed",
      sequence: 3,
      detail: "Missing checkpoint.",
      requiresWorkspaceReview: false,
    });
  });
});

describe("checkpoint file restore dispatch rejection", () => {
  it("recognizes only structured server-side dispatch rejection", () => {
    expect(
      isDefinitiveDispatchRejection(
        new WsRpcError({
          message: "Thread not found.",
          code: WS_RPC_ERROR_CODES.orchestrationDispatchRejected,
        }),
      ),
    ).toBe(true);

    expect(isDefinitiveDispatchRejection(new WsRpcError({ message: "Other server error." }))).toBe(
      false,
    );
    expect(isDefinitiveDispatchRejection(new Error("Transport closed"))).toBe(false);
  });
});

describe("checkpoint file restore pending storage", () => {
  it("round-trips and clears the pending restore by request id", () => {
    const storage = new MemoryStorage();
    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "dispatched",
        },
        storage,
      ),
    ).toBe(true);

    expect(hasPendingCheckpointFileRestore(storage)).toBe(true);
    expect(getPendingCheckpointFileRestoreSnapshot(storage)).toContain("restore-request");
    expect(readPendingCheckpointFileRestore(storage)).toEqual({
      threadId,
      messageId,
      requestCommandId,
      turnCount: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      phase: "dispatched",
    });

    clearPendingCheckpointFileRestore(otherRequestCommandId, storage);
    expect(readPendingCheckpointFileRestore(storage)?.requestCommandId).toBe(requestCommandId);

    clearPendingCheckpointFileRestore(requestCommandId, storage);
    expect(readPendingCheckpointFileRestore(storage)).toBeNull();
    expect(hasPendingCheckpointFileRestore(storage)).toBe(false);
    expect(getPendingCheckpointFileRestoreSnapshot(storage)).toBeNull();
  });

  it("requires durable exclusive persistence before a restore can be dispatched", () => {
    const storage = new MemoryStorage();

    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "confirming",
          clientId: "client-a",
        },
        storage,
      ),
    ).toBe(true);
    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "dispatched",
          reconciliationCommandId: CommandId.makeUnsafe("restore-reconcile"),
          clientId: "client-a",
        },
        storage,
      ),
    ).toBe(true);

    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId: otherRequestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "confirming",
          clientId: "client-b",
        },
        storage,
      ),
    ).toBe(false);

    expect(readPendingCheckpointFileRestore(storage)).toMatchObject({
      requestCommandId,
      phase: "dispatched",
      reconciliationCommandId: CommandId.makeUnsafe("restore-reconcile"),
      clientId: "client-a",
    });
  });

  it("does not report a pending restore when storage is unavailable", () => {
    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "confirming",
        },
        null,
      ),
    ).toBe(false);
    expect(hasPendingCheckpointFileRestore(null)).toBe(false);
    expect(CHECKPOINT_FILE_RESTORE_BLOCKED_MESSAGE).toContain("file restore");
  });

  it("defaults older pending records to dispatched so they reconcile conservatively", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "synara.pendingCheckpointFileRestore.v1",
      JSON.stringify({
        threadId,
        messageId,
        requestCommandId,
        turnCount: 1,
        createdAt: "2026-07-12T00:00:00.000Z",
      }),
    );

    expect(readPendingCheckpointFileRestore(storage)).toEqual({
      threadId,
      messageId,
      requestCommandId,
      turnCount: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      phase: "dispatched",
    });
  });

  it("reconciles only ambiguous or reloaded dispatched requests", () => {
    const pending = {
      threadId,
      messageId,
      requestCommandId,
      reconciliationCommandId: CommandId.makeUnsafe("restore-reconcile"),
      turnCount: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      phase: "dispatched" as const,
      clientId: "client-a",
    };

    expect(shouldReconcileCheckpointFileRestoreAcceptance(pending, "client-a")).toBe(false);
    expect(shouldReconcileCheckpointFileRestoreAcceptance(pending, "client-after-reload")).toBe(
      true,
    );
    expect(
      shouldReconcileCheckpointFileRestoreAcceptance(
        { ...pending, acceptanceAmbiguous: true },
        "client-a",
      ),
    ).toBe(true);
  });

  it("does not treat another tab's confirmation lock as stale", () => {
    const pending = {
      threadId,
      messageId,
      requestCommandId,
      turnCount: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      phase: "confirming" as const,
      clientId: "client-before-reload",
    };

    expect(isStaleCheckpointFileRestoreConfirmation(pending)).toBe(false);
    const { clientId: _clientId, ...ownerlessPending } = pending;
    expect(isStaleCheckpointFileRestoreConfirmation(ownerlessPending)).toBe(true);
  });

  it("rejects storage writes that cannot be read back", () => {
    const storage = new (class extends MemoryStorage {
      override getItem(): string | null {
        return null;
      }
    })();

    expect(
      savePendingCheckpointFileRestore(
        {
          threadId,
          messageId,
          requestCommandId,
          turnCount: 1,
          createdAt: "2026-07-12T00:00:00.000Z",
          phase: "confirming",
        },
        storage,
      ),
    ).toBe(false);
  });
});
