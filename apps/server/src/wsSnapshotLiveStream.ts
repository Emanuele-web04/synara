import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Queue, Scope, Stream } from "effect";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

/**
 * Attach live delivery first, capture a snapshot and durable high-water fence,
 * replay the exact gap, then continue with strictly newer live events.
 */
export function makeCursorSafeSnapshotLiveStream<Snapshot, E>(input: {
  readonly subscribeLive: Effect.Effect<Stream.Stream<OrchestrationEvent, E>, never, Scope.Scope>;
  readonly snapshot: Effect.Effect<Snapshot, E>;
  readonly snapshotSequence: (snapshot: Snapshot) => number;
  readonly getHighWaterSequence: Effect.Effect<number, E>;
  readonly replay: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, E>;
  readonly onResnapshotRequired?: (report: {
    readonly snapshotSequence: number;
    readonly highWaterSequence: number;
    readonly replayCount: number;
    readonly replayLimit: number;
  }) => Effect.Effect<void, never>;
}): Stream.Stream<SnapshotLiveStreamItem<Snapshot>, E | WsRpcError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // The scoped subscription is registered synchronously before snapshot IO.
      // A one-item handoff queue keeps the bridge bounded; the caller's live
      // stream owns its slow-consumer/drop policy ahead of this queue.
      const live = yield* input.subscribeLive;
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, E | Cause.Done>(1);
      yield* Stream.runIntoQueue(live, liveQueue).pipe(Effect.forkScoped);
      const snapshot = yield* input.snapshot;
      const snapshotSequence = input.snapshotSequence(snapshot);
      const highWaterSequence = yield* input.getHighWaterSequence;
      const replayCount = Math.max(0, highWaterSequence - snapshotSequence);
      if (replayCount > ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
        if (input.onResnapshotRequired) {
          yield* input.onResnapshotRequired({
            snapshotSequence,
            highWaterSequence,
            replayCount,
            replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
          });
        }
        return yield* new WsRpcError({
          message: `Orchestration snapshot is ${replayCount} events behind; restart the stream for a fresh snapshot.`,
          code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
          retryable: true,
        });
      }

      const replay = input.replay(snapshotSequence, highWaterSequence).pipe(
        Stream.filter(
          (event) => event.sequence > snapshotSequence && event.sequence <= highWaterSequence,
        ),
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );
      const liveAfterFence = Stream.fromQueue(liveQueue).pipe(
        Stream.filter((event) => event.sequence > highWaterSequence),
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );

      return Stream.concat(
        Stream.succeed<SnapshotLiveStreamItem<Snapshot>>({ kind: "snapshot", snapshot }),
        Stream.concat(replay, liveAfterFence),
      );
    }),
  );
}
