import type { OrchestrationThread, ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { TurnCheckpointCoordinatorLive } from "./Layers/TurnCheckpointCoordinator.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { TurnCheckpointCoordinator } from "./Services/TurnCheckpointCoordinator.ts";
import { resolveProviderSessionThread } from "./providerSessionThread.ts";

describe("resolveProviderSessionThread", () => {
  it("propagates lookup failure, then recovers onto the parent lease key", async () => {
    const parentId = "thread-parent" as ThreadId;
    const childId = "subagent:thread-parent:child" as ThreadId;
    const parent = { id: parentId, parentThreadId: null } as OrchestrationThread;
    const child = { id: childId, parentThreadId: parentId } as OrchestrationThread;
    let childLookups = 0;
    const getThreadDetailById = vi.fn((threadId: ThreadId) => {
      if (threadId === childId && childLookups++ === 0) {
        return Effect.fail(new Error("transient projection failure"));
      }
      return Effect.succeed(Option.some(threadId === childId ? child : parent));
    });
    const projectionSnapshotQuery = {
      getThreadDetailById,
      findSyntheticSubagentParentThread: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQueryShape;

    await expect(
      Effect.runPromise(
        Effect.flip(resolveProviderSessionThread(projectionSnapshotQuery, childId)),
      ),
    ).resolves.toMatchObject({ message: "transient projection failure" });

    let childMutationStarted = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* TurnCheckpointCoordinator;
          const parentLeaseAcquired = yield* Deferred.make<void>();
          const releaseParentLease = yield* Deferred.make<void>();
          const holder = yield* Effect.forkScoped(
            coordinator.withThreadLease(
              parentId,
              Deferred.succeed(parentLeaseAcquired, undefined).pipe(
                Effect.andThen(Deferred.await(releaseParentLease)),
              ),
            ),
          );
          yield* Deferred.await(parentLeaseAcquired);

          const contender = yield* Effect.forkScoped(
            resolveProviderSessionThread(projectionSnapshotQuery, childId).pipe(
              Effect.flatMap((providerThread) =>
                coordinator.withThreadLease(
                  providerThread?.id ?? childId,
                  Effect.sync(() => {
                    childMutationStarted = true;
                  }),
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");
          expect(childMutationStarted).toBe(false);

          yield* Deferred.succeed(releaseParentLease, undefined);
          yield* Fiber.join(contender);
          yield* Fiber.join(holder);
        }),
      ).pipe(Effect.provide(TurnCheckpointCoordinatorLive)),
    );

    expect(childMutationStarted).toBe(true);
    expect(getThreadDetailById).toHaveBeenCalledWith(parentId);
  });
});
