import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  cleanupSucceededUnlessInterrupted,
  isThreadCurrentlyArchived,
  isThreadLifecycleCleanupEvent,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor";

function lifecycleEvent(type: "thread.archived" | "thread.deleted"): OrchestrationEvent {
  const threadId = ThreadId.makeUnsafe(`thread-${type}`);
  const now = "2026-07-23T20:00:00.000Z";
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type,
    occurredAt: now,
    payload:
      type === "thread.deleted"
        ? { threadId, deletedAt: now }
        : { threadId, archivedAt: now, updatedAt: now },
  } as OrchestrationEvent;
}

describe("isThreadLifecycleCleanupEvent", () => {
  it("routes both archive and delete through server-owned cleanup", () => {
    expect(isThreadLifecycleCleanupEvent(lifecycleEvent("thread.archived"))).toBe(true);
    expect(isThreadLifecycleCleanupEvent(lifecycleEvent("thread.deleted"))).toBe(true);
  });
});

describe("isThreadCurrentlyArchived", () => {
  it("rejects stale archive cleanup after an undo has cleared archivedAt", () => {
    expect(isThreadCurrentlyArchived({ archivedAt: null })).toBe(false);
    expect(isThreadCurrentlyArchived(undefined)).toBe(false);
    expect(isThreadCurrentlyArchived({ archivedAt: "2026-07-23T20:00:00.000Z" })).toBe(true);
  });
});

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("cleanupSucceededUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("returns true for successful cleanup", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.void,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(true);
  });

  it("returns false for ordinary cleanup failures", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(false);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
