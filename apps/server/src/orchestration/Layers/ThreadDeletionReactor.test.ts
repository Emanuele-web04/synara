import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupSucceededUnlessInterrupted,
  closeThreadTerminalScopes,
  detachThreadDevice,
  detachThreadComputer,
  isThreadCurrentlyArchived,
  isThreadLifecycleCleanupEvent,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor";
import { ServerConfig } from "../../config";
import { GitCore } from "../../git/Services/GitCore";
import { ProfileStatsArchive } from "../../profileStatsArchive";
import { ProviderService } from "../../provider/Services/ProviderService";
import { TerminalManager } from "../../terminal/Services/Manager";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor";
import { DeviceService } from "../../device/Services/DeviceService";
import { ComputerService } from "../../computer/Services/ComputerService";
import { ComputerApprovalGate } from "../../computer/ComputerApprovalGate";
import { ComputerManager } from "../../computer/ComputerManager";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend";
import { DeviceManager } from "../../device/DeviceManager";
import { FakeDeviceBackend } from "../../device/FakeDeviceBackend";
import { TerminalError } from "../../terminal/Services/Manager";

describe("terminal scope cleanup", () => {
  it("closes dock terminals even when the host terminal close fails", async () => {
    const close = vi.fn(() => Effect.void as Effect.Effect<void, TerminalError>);
    close.mockReturnValueOnce(Effect.fail(new TerminalError({ message: "host close failed" })));
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore: () => Effect.void },
        ThreadId.makeUnsafe("host"),
        true,
      ),
    );
    expect(result).toBe(false);
    expect(close.mock.calls).toEqual([
      [{ threadId: "host", deleteHistory: true }],
      [{ threadId: "dock-terminal:host", deleteHistory: true }],
    ]);
  });

  it("preserves the archive generation fence for both terminal scopes", async () => {
    const close = vi.fn(() => Effect.void);
    const closeSessionsOpenedAtOrBefore = vi.fn(() => Effect.void);
    const archivedAt = "2026-09-09T12:00:00.000Z";
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore },
        ThreadId.makeUnsafe("host"),
        false,
        archivedAt,
      ),
    );
    expect(result).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeSessionsOpenedAtOrBefore.mock.calls).toEqual([
      [{ threadId: "host", openedAtOrBefore: archivedAt }],
      [{ threadId: "dock-terminal:host", openedAtOrBefore: archivedAt }],
    ]);
  });
});

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

describe("detachThreadDevice", () => {
  it("releases the device attachment when an active thread is deleted", async () => {
    const threadId = ThreadId.makeUnsafe("thread-delete-device");
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    await backend.boot("FAKE-0001");
    await manager.attach(threadId, "FAKE-0001");

    await Effect.runPromise(
      detachThreadDevice(threadId).pipe(
        Effect.provideService(DeviceService, { supported: true, manager }),
      ),
    );

    expect((await manager.getThreadState(threadId)).attachedDeviceUdid).toBeNull();
    expect(backend.hasStream("FAKE-0001")).toBe(false);
  });
});

it("deletion releases computer state and the desktop lease", async () => {
  const manager = new ComputerManager({ backend: new FakeComputerBackend() });
  try {
    const threadId = ThreadId.makeUnsafe("deleted-owner");
    await manager.getThreadState(threadId);
    await manager.click(threadId, { x: 10, y: 10 });
    await Effect.runPromise(
      detachThreadComputer(threadId).pipe(
        Effect.provideService(ComputerService, {
          supported: true,
          availability: { kind: "available" },
          manager,
          approvalGate: new ComputerApprovalGate(),
        }),
      ),
    );
    await expect(manager.click("next-owner", { x: 10, y: 10 })).resolves.toBeDefined();
  } finally {
    await manager.dispose();
  }
});

/**
 * The reactor over one archive event, with every unrelated service stubbed to
 * the call the archive path makes of it. The archive path is only reachable
 * through the layer, so this is the only place it can be proven to run.
 */
type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;

async function runArchiveCleanup(input: {
  readonly event: ThreadArchivedEvent;
  readonly archived: boolean;
  readonly computerManager: ComputerManager;
}): Promise<void> {
  const deviceManager = new DeviceManager({ backend: new FakeDeviceBackend() });
  const threadId = input.event.payload.threadId;
  let consulted = false;
  const layer = ThreadDeletionReactorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          streamDomainEvents: Stream.make(input.event),
          refreshCommandReadModel: () => Effect.void,
        } as never),
        Layer.succeed(ProfileStatsArchive, {
          hasThreadPurgeFence: () => Effect.succeed(false),
          purgeThreadWithStatsSnapshot: () => Effect.succeed(false),
          purgeSoftDeletedManualThreads: () => Effect.succeed(0),
        } as never),
        Layer.succeed(ProviderService, { stopSession: () => Effect.void } as never),
        Layer.succeed(TerminalManager, {
          close: () => Effect.void,
          closeSessionsOpenedAtOrBefore: () => Effect.void,
        } as never),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: () =>
            Effect.sync(() => {
              consulted = true;
              return Option.some({
                id: threadId,
                archivedAt: input.archived ? "2026-07-23T20:00:00.000Z" : null,
              });
            }),
        } as never),
        Layer.succeed(ServerConfig, { homeDir: "/tmp/home", worktreesDir: "/tmp/wt" } as never),
        Layer.succeed(GitCore, {} as never),
        Layer.succeed(DeviceService, { supported: false, manager: deviceManager }),
        Layer.succeed(ComputerService, {
          supported: true,
          availability: { kind: "available" },
          manager: input.computerManager,
          approvalGate: new ComputerApprovalGate(),
        }),
      ),
    ),
  );
  const scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* Scope.provide(reactor.start(), scope);
      // The event is consumed on a forked fiber, so wait for the worker to
      // reach the archive check, then drain the work it accepted.
      const deadline = Date.now() + 2_000;
      while (!consulted) {
        if (Date.now() > deadline) throw new Error("archive cleanup never ran");
        yield* Effect.sleep(5);
      }
      yield* reactor.drain;
    }).pipe(Effect.provide(layer), Effect.runPromise);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await deviceManager.dispose();
  }
}

describe("archive cleanup", () => {
  it("releases the desktop lease and thread state when a thread is archived", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    try {
      const event = lifecycleEvent("thread.archived") as ThreadArchivedEvent;
      const threadId = event.payload.threadId;
      await manager.getThreadState(threadId);
      await manager.click(threadId, { x: 10, y: 10 });
      await expect(manager.click("next-owner", { x: 10, y: 10 })).rejects.toMatchObject({
        code: "computer_controlled_by_other_thread",
      });

      await runArchiveCleanup({ event, archived: true, computerManager: manager });

      await expect(manager.click("next-owner", { x: 10, y: 10 })).resolves.toBeDefined();
    } finally {
      await manager.dispose();
    }
  });

  it("leaves the desktop alone for a stale archive event the user already undid", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    try {
      const event = lifecycleEvent("thread.archived") as ThreadArchivedEvent;
      const threadId = event.payload.threadId;
      await manager.click(threadId, { x: 10, y: 10 });

      await runArchiveCleanup({ event, archived: false, computerManager: manager });

      await expect(manager.click("next-owner", { x: 10, y: 10 })).rejects.toMatchObject({
        code: "computer_controlled_by_other_thread",
      });
    } finally {
      await manager.dispose();
    }
  });
});
