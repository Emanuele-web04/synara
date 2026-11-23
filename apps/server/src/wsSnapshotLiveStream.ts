import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";

import { makeFailingLiveUiStream, type BufferLiveUiStreamOptions } from "./wsStreamBackpressure";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;
const ORCHESTRATION_RESUME_REPLAY_LIMIT = 128;
const ORCHESTRATION_RESUME_REPLAY_MAX_BYTES = 1024 * 1024;
// Subscribers share immutable journal objects; cache wire size, never payload copies.
const eventSizes = new WeakMap<OrchestrationEvent, number>();

// Computes exact UTF-8 JSON byte length of a string (including quotes and
// JSON escapes) without allocating a JSON-serialized copy.
function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2; // surrounding quotes
  const length = value.length;
  for (let i = 0; i < length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      if (code === 0x22 || code === 0x5c) {
        bytes += 2; // \" or \\
      } else if (code < 0x20) {
        // \b \f \n \r \t take 2 bytes; other control chars take \u00XX (6 bytes)
        bytes +=
          code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
      } else {
        bytes += 1;
      }
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 6; // lone high surrogate -> \uXXXX
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6; // lone low surrogate -> \uXXXX
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Computes exact UTF-8 JSON byte length for JSON-serializable values without
// allocating giant intermediate strings on every live event.
function exactJsonUtf8Bytes(value: unknown, depth = 0): number {
  if (value === null) return 4;
  switch (typeof value) {
    case "string":
      return jsonStringUtf8Bytes(value);
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "undefined":
    case "function":
    case "symbol":
      return 0;
    case "bigint":
      return value.toString().length;
    case "object": {
      if (depth > 32) return Buffer.byteLength(JSON.stringify(value));
      if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
        return exactJsonUtf8Bytes((value as { toJSON: () => unknown }).toJSON(), depth + 1);
      }
      if (Array.isArray(value)) {
        let total = 2;
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) total += 1;
          const entry = value[index];
          total +=
            entry === undefined || typeof entry === "function" || typeof entry === "symbol"
              ? 4
              : exactJsonUtf8Bytes(entry, depth + 1);
        }
        return total;
      }
      const record = value as Record<string, unknown>;
      let total = 2;
      let first = true;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const entry = record[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          continue;
        }
        if (!first) total += 1;
        first = false;
        total += jsonStringUtf8Bytes(key) + 1 + exactJsonUtf8Bytes(entry, depth + 1);
      }
      return total;
    }
    default:
      return 0;
  }
}

const eventBytes = (event: OrchestrationEvent) => {
  const cached = eventSizes.get(event);
  if (cached !== undefined) return cached;
  // Envelope `{"kind":"event","event":...}` adds 25 bytes around the event JSON.
  const bytes = 25 + exactJsonUtf8Bytes(event);
  eventSizes.set(event, bytes);
  return bytes;
};
class ResumeReplayLimitExceeded extends Error {}
const resumeReplayLimitExceeded = new ResumeReplayLimitExceeded();

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "replay"; readonly events: ReadonlyArray<OrchestrationEvent> };

export interface ResnapshotReport {
  readonly snapshotSequence: number;
  readonly highWaterSequence: number;
  readonly replayCount: number;
  readonly replayLimit: number;
}

/**
 * Detects a resnapshot demand that restarting the stream cannot satisfy.
 *
 * A healthy resnapshot cycle strictly advances the snapshot fence: the client
 * restarts, the server serves a fresh snapshot at (or near) the journal head,
 * and the gap closes. When the snapshot fence is frozen — a stalled or missing
 * projector — every restart re-reads the same fence and re-demands the same
 * resnapshot forever. Track the fence of the last demand per stream key; a
 * repeat demand at a non-advancing fence is escalated to a non-retryable
 * failure so clients stop tearing the transport down and surface the fault.
 *
 * Callers must key the tracker per subscriber (client id + stream name), not
 * per stream name alone: two clients demanding the same stale stream
 * concurrently are two first offenses, not one restart cycle — a shared key
 * would hand the second client a non-retryable verdict before either had
 * actually restarted. The fence itself is shared database state, so each
 * subscriber's chain still converges on the same evidence; per-subscriber
 * keying only ensures the "did not advance" comparison spans one
 * subscription's own retries. State is cleared the moment that subscriber's
 * stream start succeeds.
 */
export function makeResnapshotEscalationTracker(): {
  readonly shouldEscalate: (streamKey: string, report: ResnapshotReport) => boolean;
  readonly recordHealthyStart: (streamKey: string) => void;
} {
  const lastDemandedFenceByStreamKey = new Map<string, number>();
  // Entries for subscribers that disconnect mid-failure are never cleared by a
  // healthy start, so bound the map: evict the oldest insertions once the
  // ceiling is reached. Losing an old entry merely re-grants one retryable
  // demand to that subscriber — safe, since escalation is a loop guard, not a
  // correctness fence.
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

/**
 * Attach live delivery first, capture a snapshot and durable high-water fence,
 * replay the exact gap, then continue with strictly newer live events.
 *
 * When `resumeFromSequence` is provided and the replay fits 128 events and one
 * MiB, the snapshot is skipped. A scoped stream can check its own event count
 * when the global gap exceeds the event limit. A cursor ahead of the server
 * head or an overflowing replay falls back to the full snapshot. With `batchReplay`
 * the resume gap arrives as a single `replay` item (omitted when empty) so the
 * client can apply the whole catch-up at once; the snapshot path is unchanged.
 */
export function makeCursorSafeSnapshotLiveStream<Snapshot, E>(input: {
  readonly subscribeLive: Effect.Effect<Stream.Stream<OrchestrationEvent, E>, never, Scope.Scope>;
  readonly liveBufferOptions?: Omit<
    BufferLiveUiStreamOptions<WsRpcError, never, OrchestrationEvent>,
    "overflowStrategy" | "serializedBytes" | "sharedBudget" | "retentionKey"
  >;
  readonly snapshot: Effect.Effect<Snapshot, E>;
  readonly snapshotSequence: (snapshot: Snapshot) => number;
  readonly getHighWaterSequence: Effect.Effect<number, E>;
  readonly replay: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, E>;
  readonly resumeFromSequence?: number | undefined;
  readonly batchReplay?: boolean | undefined;
  /** Check a scoped replay's event budget when the global distance exceeds it. */
  readonly resumeReplayFits?: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    maxEvents: number,
  ) => Effect.Effect<boolean, E>;
  /**
   * Guards the resume shortcut against a subject that no longer exists. A hard
   * purge removes a thread's rows while unrelated events keep the journal head
   * above the client's cursor, so the gap check alone would accept the resume
   * and stream an empty replay forever instead of surfacing the deletion.
   */
  readonly resumeSubjectExists?: Effect.Effect<boolean, E>;
  readonly onResnapshotRequired?: (report: ResnapshotReport) => Effect.Effect<void, never>;
  /**
   * Loop guard: pairs a stable stream key with a process-wide tracker so a
   * resnapshot demand whose fence did not advance since the previous demand
   * fails non-retryable instead of prompting another identical restart.
   */
  readonly resnapshotEscalation?: {
    readonly streamKey: string;
    readonly tracker: ReturnType<typeof makeResnapshotEscalationTracker>;
  };
}): Stream.Stream<SnapshotLiveStreamItem<Snapshot>, E | WsRpcError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // The scoped subscription is registered synchronously before snapshot IO.
      // A bounded live tail drains while snapshot IO or RPC delivery waits.
      // Its subscription has a separate scope so overflow closes it at once.
      const subscriptionScope = yield* Scope.fork(yield* Effect.scope);
      const live = yield* input.subscribeLive.pipe(Scope.provide(subscriptionScope));
      const liveFailure = yield* Deferred.make<never, E | WsRpcError>();
      const bufferedLive = yield* makeFailingLiveUiStream(
        live,
        {
          ...input.liveBufferOptions,
          serializedBytes: eventBytes,
        },
        true,
      );
      yield* bufferedLive.failureExit.pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit)
            ? Scope.close(subscriptionScope, exit).pipe(
                Effect.andThen(Deferred.failCause(liveFailure, exit.cause)),
                Effect.uninterruptible,
              )
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const deliveryScope = yield* Effect.scope;
      const duringLive = <A, E2>(effect: Effect.Effect<A, E2>) =>
        bufferedLive.check.pipe(
          Effect.andThen(Effect.raceFirst(effect, Deferred.await(liveFailure))),
          Effect.tap(() => bufferedLive.check),
        );
      // Only finite bootstrap/SQL pulls need this race. The live queue itself
      // fails on overflow, avoiding two extra fibers for each live batch.
      const finite = <A>(stream: Stream.Stream<A, E | WsRpcError>) =>
        Stream.fromPull(
          Stream.toPull(stream).pipe(
            Scope.provide(deliveryScope),
            Effect.map((pull) => duringLive(pull)),
          ),
        );
      const liveAfterFence = bufferedLive.stream.pipe(
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );
      if (input.resumeFromSequence !== undefined) {
        // The head is read after the live attach, so replay through the head
        // plus live-after-fence covers every event exactly once — the same
        // fence discipline as the snapshot path, with the cursor standing in
        // for the snapshot sequence.
        const resumeFromSequence = input.resumeFromSequence;
        const highWaterSequence = yield* duringLive(input.getHighWaterSequence);
        const resumeGap = highWaterSequence - resumeFromSequence;
        // The `resumeGap >= 0` guard is load-bearing, not defensive: hard
        // deletes remove rows from `orchestration_events` (see the thread purge
        // in profileStatsArchive.ts), which can lower the journal-wide
        // MAX(sequence) below a cursor a client legitimately held. Such a
        // cursor must never be trusted for a gap replay — fall through to the
        // full snapshot instead. Sequences themselves are never reused
        // (`sequence INTEGER PRIMARY KEY AUTOINCREMENT`), so a non-negative
        // gap cannot silently alias deleted history onto new events.
        const canAttemptResume =
          resumeGap >= 0 &&
          (input.resumeSubjectExists === undefined ||
            (yield* duringLive(input.resumeSubjectExists))) &&
          (resumeGap <= ORCHESTRATION_RESUME_REPLAY_LIMIT ||
            (input.resumeReplayFits !== undefined &&
              (yield* duringLive(
                input.resumeReplayFits(
                  resumeFromSequence,
                  highWaterSequence,
                  ORCHESTRATION_RESUME_REPLAY_LIMIT,
                ),
              ))));
        if (canAttemptResume) {
          yield* bufferedLive.retainAfter((event) => event.sequence > highWaterSequence, false);
          const resumeRows: Array<OrchestrationEvent> = [];
          const releaseResumeRows = () => {
            resumeRows.length = 0;
          };
          yield* Effect.addFinalizer(() => Effect.sync(releaseResumeRows));
          let resumeBytes = 0;
          // Preflight prevents retrying the same oversized cursor gap forever.
          // Finite rows are bounded separately and never charged as live events.
          const canResume = yield* duringLive(
            input.replay(resumeFromSequence, highWaterSequence).pipe(
              Stream.filter(
                (event) =>
                  event.sequence > resumeFromSequence && event.sequence <= highWaterSequence,
              ),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  const bytes = eventBytes(event);
                  if (
                    resumeRows.length >= ORCHESTRATION_RESUME_REPLAY_LIMIT ||
                    resumeBytes + bytes > ORCHESTRATION_RESUME_REPLAY_MAX_BYTES
                  ) {
                    return yield* Effect.fail(resumeReplayLimitExceeded);
                  }
                  resumeRows.push(event);
                  resumeBytes += bytes;
                }),
              ),
              Effect.as(true),
              Effect.onError(() => Effect.sync(releaseResumeRows)),
              Effect.catchIf(
                (error): error is ResumeReplayLimitExceeded => error === resumeReplayLimitExceeded,
                () => Effect.succeed(false),
              ),
            ),
          );
          if (canResume) {
            yield* bufferedLive.retainAfter((event) => event.sequence > highWaterSequence);
            input.resnapshotEscalation?.tracker.recordHealthyStart(
              input.resnapshotEscalation.streamKey,
            );
            // With `batchReplay` the bounded gap goes out as one item so the
            // client can apply the whole catch-up in a single store update.
            const replayItems: Stream.Stream<SnapshotLiveStreamItem<Snapshot>> =
              input.batchReplay === true
                ? resumeRows.length === 0
                  ? Stream.empty
                  : Stream.succeed({ kind: "replay", events: [...resumeRows] })
                : Stream.fromIterable(resumeRows).pipe(
                    Stream.map(
                      (event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event }),
                    ),
                  );
            const replay = replayItems.pipe(Stream.ensuring(Effect.sync(releaseResumeRows)));
            return Stream.concat(finite(replay), liveAfterFence);
          }
        }
      }
      const snapshot = yield* duringLive(input.snapshot);
      const snapshotSequence = input.snapshotSequence(snapshot);
      const highWaterSequence = yield* duringLive(input.getHighWaterSequence);
      yield* bufferedLive.retainAfter((event) => event.sequence > highWaterSequence);
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
      return Stream.concat(
        finite(
          Stream.concat(
            Stream.succeed<SnapshotLiveStreamItem<Snapshot>>({ kind: "snapshot", snapshot }),
            replay,
          ),
        ),
        liveAfterFence,
      );
    }),
  );
}
