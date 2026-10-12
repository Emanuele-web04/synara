import { ThreadId, type PullRequestAutoFixState } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { PullRequestAutoFixRepository } from "../Services/PullRequestAutoFixRepository";
import { PullRequestAutoFixRepositoryLive } from "./PullRequestAutoFixRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  PullRequestAutoFixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const PR_1 = "https://github.com/o/r/pull/1";
const PR_2 = "https://github.com/o/r/pull/2";

function state(
  threadId: string,
  pullRequestUrl: string,
  overrides: Partial<PullRequestAutoFixState> = {},
): PullRequestAutoFixState {
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    pullRequestUrl,
    status: "watching",
    pauseReason: null,
    attempts: 0,
    lastHandledHeadSha: null,
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

layer("PullRequestAutoFixRepository", (it) => {
  it.effect("keeps one row per PR of a chat, updates in place, lists active rows, deletes", () =>
    Effect.gen(function* () {
      const repository = yield* PullRequestAutoFixRepository;
      const threadId = ThreadId.makeUnsafe("thread-a");

      yield* repository.upsert(state("thread-a", PR_1));
      yield* repository.upsert(state("thread-a", PR_2));
      yield* repository.upsert(
        state("thread-b", PR_1, { status: "paused", pauseReason: "attempt-limit", attempts: 3 }),
      );
      yield* repository.upsert(
        state("thread-a", PR_1, { status: "fixing", attempts: 1, lastHandledHeadSha: "abc123" }),
      );

      assert.deepStrictEqual(yield* repository.listByThread({ threadId }), [
        state("thread-a", PR_1, { status: "fixing", attempts: 1, lastHandledHeadSha: "abc123" }),
        state("thread-a", PR_2),
      ]);
      assert.deepStrictEqual(
        (yield* repository.listActive()).map((row) => [row.threadId, row.pullRequestUrl]),
        [
          [threadId, PR_1],
          [threadId, PR_2],
        ],
      );

      yield* repository.delete({ threadId, pullRequestUrl: PR_1 });
      assert.deepStrictEqual(
        (yield* repository.listByThread({ threadId })).map((row) => row.pullRequestUrl),
        [PR_2],
      );
    }),
  );
  it.effect(
    "permits only one active owner, releases paused ownership and rejects a conflicting resume",
    () =>
      Effect.gen(function* () {
        const repository = yield* PullRequestAutoFixRepository;
        const pr = "https://github.com/o/r/pull/99";
        yield* repository.upsert(state("owner-a", pr));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.upsert(state("owner-b", pr)))));
        yield* repository.upsert(
          state("owner-a", pr, { status: "paused", pauseReason: "no-push" }),
        );
        yield* repository.upsert(state("owner-b", pr));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.upsert(state("owner-a", pr)))));
        assert.deepStrictEqual(
          (yield* repository.listActive())
            .filter((row) => row.pullRequestUrl === pr)
            .map((row) => row.threadId),
          [ThreadId.makeUnsafe("owner-b")],
        );
        yield* repository.delete({ threadId: ThreadId.makeUnsafe("owner-b"), pullRequestUrl: pr });
        yield* repository.upsert(state("owner-a", pr));
        assert.deepStrictEqual(
          yield* repository.listByThread({ threadId: ThreadId.makeUnsafe("owner-a") }),
          [state("owner-a", pr)],
        );
        yield* repository.delete({ threadId: ThreadId.makeUnsafe("owner-a"), pullRequestUrl: pr });
      }),
  );
});
