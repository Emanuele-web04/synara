import type { OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";

import { prepareSnapshotFirstDomainEvents } from "./rpc";

function event(sequence: number, type: OrchestrationEvent["type"] = "thread.meta-updated") {
  return {
    sequence,
    type,
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
  } as unknown as OrchestrationEvent;
}

describe("Companion snapshot-first event bridge", () => {
  it("emits the authorized snapshot first without losing an update committed during load", async () => {
    const persisted: OrchestrationEvent[] = [];
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareSnapshotFirstDomainEvents({
          loadSnapshot: Effect.sync(() => {
            persisted.push(event(1));
            return { snapshotSequence: 0 };
          }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          replay: (cursor) =>
            Stream.fromIterable(persisted.filter((next) => next.sequence > cursor)),
          loadAvailableSequence: Effect.succeed(1),
          live: Stream.empty,
          isRelevant: () => true,
        });

        return yield* Stream.concat(
          Stream.succeed("snapshot"),
          prepared.events.pipe(Stream.map((next) => `event:${next.sequence}`)),
        ).pipe(Stream.take(2), Stream.runCollect);
      }),
    );

    expect(items).toEqual(["snapshot", "event:1"]);
  });

  it("replays from the snapshot cursor, deduplicates, and rejects rollback", async () => {
    const sequences = await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareSnapshotFirstDomainEvents({
          loadSnapshot: Effect.succeed({ snapshotSequence: 5 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          replay: () => Stream.make(event(4), event(6), event(6), event(7)),
          loadAvailableSequence: Effect.succeed(7),
          live: Stream.empty,
          isRelevant: () => true,
        });

        return yield* prepared.events.pipe(
          Stream.map((next) => next.sequence),
          Stream.take(2),
          Stream.runCollect,
        );
      }),
    );

    expect(sequences).toEqual([6, 7]);
  });

  it("filters unrelated traffic before it occupies the snapshot bridge", async () => {
    const sequences = await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareSnapshotFirstDomainEvents({
          loadSnapshot: Effect.succeed({ snapshotSequence: 0 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          replay: () => Stream.make(event(1, "project.meta-updated"), event(2)),
          loadAvailableSequence: Effect.succeed(2),
          live: Stream.empty,
          isRelevant: (next) => next.aggregateKind === "thread",
        });

        return yield* prepared.events.pipe(Stream.take(1), Stream.runCollect);
      }),
    );

    expect(sequences.map((next) => next.sequence)).toEqual([2]);
  });
});
