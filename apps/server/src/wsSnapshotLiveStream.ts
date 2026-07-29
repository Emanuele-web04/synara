import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Queue, Scope, Stream } from "effect";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

/**
 * Attach live delivery first, capture a snapshot and durable high-water fence,
 * replay the exact gap, then continue with strictly newer live events.
 *
 * When `resumeFromSequence` is provided and the gap to the durable head is
 * non-negative and within the replay limit, the snapshot is skipped entirely
 * and only the gap is replayed. A negative gap (client cursor ahead of the
 * server head — restored backup or reset database) or an overflowing gap is
 * never trusted: both fall back to the full snapshot path.
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
  readonly resumeFromSequence?: number | undefined;
  /**
   * Guards the resume shortcut against a subject that no longer exists. A hard
   * purge removes a thread's rows while unrelated events keep the journal head
   * above the client's cursor, so the gap check alone would accept the resume
   * and stream an empty replay forever instead of surfacing the deletion.
   */
  readonly resumeSubjectExists?: Effect.Effect<boolean, E>;
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
      if (input.resumeFromSequence !== undefined) {
        // The head is read after the live attach, so replay through the head
        // plus live-after-fence covers every event exactly once — the same
        // fence discipline as the snapshot path, with the cursor standing in
        // for the snapshot sequence.
        const resumeFromSequence = input.resumeFromSequence;
        const highWaterSequence = yield* input.getHighWaterSequence;
        const resumeGap = highWaterSequence - resumeFromSequence;
        // The `resumeGap >= 0` guard is load-bearing, not defensive: hard
        // deletes remove rows from `orchestration_events` (see the thread purge
        // in profileStatsArchive.ts), which can lower the journal-wide
        // MAX(sequence) below a cursor a client legitimately held. Such a
        // cursor must never be trusted for a gap replay — fall through to the
        // full snapshot instead. Sequences themselves are never reused
        // (`sequence INTEGER PRIMARY KEY AUTOINCREMENT`), so a non-negative
        // gap cannot silently alias deleted history onto new events.
        const subjectExists =
          input.resumeSubjectExists === undefined ? true : yield* input.resumeSubjectExists;
        if (subjectExists && resumeGap >= 0 && resumeGap <= ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
          const replay = input.replay(resumeFromSequence, highWaterSequence).pipe(
            Stream.filter(
              (event) => event.sequence > resumeFromSequence && event.sequence <= highWaterSequence,
            ),
            Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
          );
          const liveAfterFence = Stream.fromQueue(liveQueue).pipe(
            Stream.filter((event) => event.sequence > highWaterSequence),
            Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
          );
          return Stream.concat(replay, liveAfterFence);
        }
      }
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
