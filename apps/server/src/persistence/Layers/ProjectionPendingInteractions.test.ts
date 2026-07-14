import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionPendingInteractionRepository } from "../Services/ProjectionPendingInteractions.ts";
import { ProjectionPendingInteractionRepositoryLive } from "./ProjectionPendingInteractions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingInteractionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingInteractionRepository", (it) => {
  it.effect("keeps equal provider request ids independent across threads and kinds", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const requestId = ApprovalRequestId.makeUnsafe("shared-provider-request");
      const firstThreadId = ThreadId.makeUnsafe("thread-provider-request-a");
      const secondThreadId = ThreadId.makeUnsafe("thread-provider-request-b");
      const base = {
        requestId,
        turnId: null,
        lifecycleGeneration: "generation-a",
        status: "pending" as const,
        decision: null,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-07-14T12:00:00.000Z",
        resolvedAt: null,
      };

      yield* repository.upsert({
        ...base,
        interactionKind: "approval",
        threadId: firstThreadId,
      });
      yield* repository.upsert({
        ...base,
        interactionKind: "userInput",
        threadId: firstThreadId,
      });
      yield* repository.upsert({
        ...base,
        interactionKind: "approval",
        threadId: secondThreadId,
      });

      yield* repository.deleteByIdentity({
        threadId: firstThreadId,
        interactionKind: "approval",
        requestId,
      });
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: firstThreadId,
          interactionKind: "approval",
          requestId,
        }))._tag,
        "None",
      );
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: firstThreadId,
          interactionKind: "userInput",
          requestId,
        }))._tag,
        "Some",
      );
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: secondThreadId,
          interactionKind: "approval",
          requestId,
        }))._tag,
        "Some",
      );
    }),
  );

  it.effect("lets exactly one command claim each interaction response", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const threadId = ThreadId.makeUnsafe("thread-claim-response");
      const requestId = ApprovalRequestId.makeUnsafe("request-claim-response");
      yield* repository.upsert({
        interactionKind: "userInput",
        requestId,
        threadId,
        turnId: null,
        lifecycleGeneration: "generation-claim",
        status: "pending",
        decision: null,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-07-14T12:10:00.000Z",
        resolvedAt: null,
      });

      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-claim",
          responseCommandId: "command-claim-a" as never,
          decision: null,
          requestedAt: "2026-07-14T12:10:01.000Z",
        }),
        true,
      );
      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-claim",
          responseCommandId: "command-claim-b" as never,
          decision: null,
          requestedAt: "2026-07-14T12:10:02.000Z",
        }),
        false,
      );
      const row = yield* repository.getByIdentity({
        threadId,
        interactionKind: "userInput",
        requestId,
      });
      assert.strictEqual(row._tag, "Some");
      if (row._tag === "Some") {
        assert.strictEqual(row.value.status, "responding");
        assert.strictEqual(row.value.responseCommandId, "command-claim-a");
      }
    }),
  );
});
