import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Queue, Scope, Stream } from "effect";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

export interface ResnapshotReport {
  readonly snapshotSequence: number;
  readonly highWaterSequence: number;
  readonly replayCount: number;
  readonly replayLimit: number;
}

/** a healthy resnapshot strictly advances the snapshot fence; a frozen fence (stalled/missing projector) re-reads the same fence and re-demands forever — a repeat demand at a non-advancing fence escalates to non-retryable so clients stop tearing down the transport; callers must key per subscriber (client id + stream name) since concurrent demands are independent first offenses */
export function makeResnapshotEscalationTracker(): {
  readonly shouldEscalate: (streamKey: string, report: ResnapshotReport) => boolean;
  readonly recordHealthyStart: (streamKey: string) => void;
} {
  const lastDemandedFenceByStreamKey = new Map<string, number>();
  // entries for subscribers disconnecting mid-failure are never cleared by a healthy start — bound the map; losing an old entry merely re-grants one retryable demand (escalation is a loop guard, not correctness)
  const MAX_TRACKED_STREAM_KEYS = 4_096;
  return {
    shouldEscalate: (streamKey, report) => {
      const previousFence = lastDemandedFenceByStreamKey.get(streamKey);
      lastDemandedFenceByStreamKey.delete(streamKey);
      if (lastDemandedFenceByStreamKey.size >= MAX_TRACKED_STREAM_KEYS) {
        const oldestKey = lastDemandedFenceByStreamKey.keys().next().value;
        if (oldestKey !== undefined) {
          lastDemandedFenceByStreamKey.delete(oldestKey);
        }
      }
      lastDemandedFenceByStreamKey.set(streamKey, report.snapshotSequence);
      return previousFence !== undefined && report.snapshotSequence <= previousFence;
    },
    recordHealthyStart: (streamKey) => {
      lastDemandedFenceByStreamKey.delete(streamKey);
    },
  };
}

/** attach live delivery first, capture snapshot + durable fence, replay the exact gap, then continue with strictly newer live events; a negative gap (cursor ahead of head — restored backup/reset db) or overflowing gap is never trusted: both fall back to the full snapshot */
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
  /** a hard purge removes a thread's rows while unrelated events keep the journal head above the cursor — the gap check alone would accept the resume and stream an empty replay forever instead of surfacing the deletion */
  readonly resumeSubjectExists?: Effect.Effect<boolean, E>;
  readonly onResnapshotRequired?: (report: ResnapshotReport) => Effect.Effect<void, never>;
  readonly resnapshotEscalation?: {
    readonly streamKey: string;
    readonly tracker: ReturnType<typeof makeResnapshotEscalationTracker>;
  };
}): Stream.Stream<SnapshotLiveStreamItem<Snapshot>, E | WsRpcError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // the subscription registers synchronously before snapshot IO; a one-item handoff queue keeps the bridge bounded while the caller's live stream owns the slow-consumer policy
      const live = yield* input.subscribeLive;
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, E | Cause.Done>(1);
      yield* Stream.runIntoQueue(live, liveQueue).pipe(Effect.forkScoped);
      if (input.resumeFromSequence !== undefined) {
        // the head is read after the live attach — replay-through-head plus live-after-fence covers every event exactly once, same discipline as the snapshot path with the cursor standing in for the snapshot sequence
        const resumeFromSequence = input.resumeFromSequence;
        const highWaterSequence = yield* input.getHighWaterSequence;
        const resumeGap = highWaterSequence - resumeFromSequence;
        // the `resumeGap >= 0` guard is load-bearing: hard deletes remove rows from orchestration_events which can lower MAX(sequence) below a legitimately held cursor — such a cursor must never be trusted for gap replay; AUTOINCREMENT means sequences are never reused so a non-negative gap can't alias deleted history onto new events
        const subjectExists =
          input.resumeSubjectExists === undefined ? true : yield* input.resumeSubjectExists;
        if (subjectExists && resumeGap >= 0 && resumeGap <= ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
          input.resnapshotEscalation?.tracker.recordHealthyStart(
            input.resnapshotEscalation.streamKey,
          );
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
        const report: ResnapshotReport = {
          snapshotSequence,
          highWaterSequence,
          replayCount,
          replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
        };
        if (input.onResnapshotRequired) {
          yield* input.onResnapshotRequired(report);
        }
        const escalate =
          input.resnapshotEscalation?.tracker.shouldEscalate(
            input.resnapshotEscalation.streamKey,
            report,
          ) === true;
        if (escalate) {
          return yield* new WsRpcError({
            message:
              `Orchestration snapshot is still ${replayCount} events behind after a restart; ` +
              "the snapshot fence is not advancing (a projection is stalled or missing). " +
              "Restart the server or run repair local state.",
            code: "ORCHESTRATION_SNAPSHOT_STALLED",
            retryable: false,
          });
        }
        return yield* new WsRpcError({
          message: `Orchestration snapshot is ${replayCount} events behind; restart the stream for a fresh snapshot.`,
          code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
          retryable: true,
        });
      }
      input.resnapshotEscalation?.tracker.recordHealthyStart(input.resnapshotEscalation.streamKey);

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
