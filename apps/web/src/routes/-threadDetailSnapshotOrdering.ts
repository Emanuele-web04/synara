// FILE: -threadDetailSnapshotOrdering.ts
// Purpose: Ordering rules between thread-detail snapshots, the pre-snapshot event
//          buffer, and the applied per-thread cursor.
// Layer: Web EventRouter helper (pure)
// Why: The event router applies stream events, stream snapshots, and projection
//      reads that race each other. A snapshot must never move the cursor behind
//      events the store already consumed, and events dropped from the bounded
//      pre-snapshot buffer must never leave an unnoticed hole in the transcript.

/**
 * Whether a thread-stream snapshot may replace the cached detail.
 *
 * A snapshot older than the applied cursor would roll the store back and move
 * the cursor behind events that were already consumed, so later deltas would
 * either be lost or re-applied by a catch-up replay. The only legitimate older
 * snapshot is a server-side reset (a fresh database restarts sequences), which
 * is observable only while the cursor is still the cached resume seed and no
 * event has moved it and no snapshot of the current subscription has confirmed it.
 */
export function shouldApplyThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly appliedSequence: number | undefined;
  readonly resumeSeedSequence: number | undefined;
}): boolean {
  if (input.appliedSequence === undefined || input.snapshotSequence >= input.appliedSequence) {
    return true;
  }
  return (
    input.resumeSeedSequence !== undefined && input.appliedSequence === input.resumeSeedSequence
  );
}

interface SequencedEvent {
  readonly sequence: number;
}

/**
 * Bounded buffer for thread events that arrive before the thread has a
 * snapshot cursor. Overflow drops the oldest events but remembers the highest
 * sequence it dropped, so draining can tell whether the snapshot covers them.
 */
export interface PreSnapshotThreadEventBuffer<TEvent extends SequencedEvent> {
  readonly events: TEvent[];
  droppedThroughSequence: number;
}

export function createPreSnapshotThreadEventBuffer<
  TEvent extends SequencedEvent,
>(): PreSnapshotThreadEventBuffer<TEvent> {
  return { events: [], droppedThroughSequence: -1 };
}

export function bufferPreSnapshotThreadEvent<TEvent extends SequencedEvent>(
  buffer: PreSnapshotThreadEventBuffer<TEvent>,
  event: TEvent,
  limit: number,
): void {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (buffer.events.length >= normalizedLimit) {
    const dropped = buffer.events.splice(0, buffer.events.length - normalizedLimit + 1);
    for (const droppedEvent of dropped) {
      buffer.droppedThroughSequence = Math.max(
        buffer.droppedThroughSequence,
        droppedEvent.sequence,
      );
    }
  }
  buffer.events.push(event);
}

/**
 * The buffered events that follow `appliedSequence`, in sequence order.
 * `lostEvents` is true when overflow dropped an event the applied snapshot does
 * not cover: applying the remainder would leave a hole (missing streamed text,
 * a skipped state transition), so the caller must resync from a fresh snapshot
 * instead.
 */
export function drainPreSnapshotThreadEvents<TEvent extends SequencedEvent>(
  buffer: PreSnapshotThreadEventBuffer<TEvent> | undefined,
  appliedSequence: number,
): { readonly events: TEvent[]; readonly lostEvents: boolean } {
  if (buffer === undefined) {
    return { events: [], lostEvents: false };
  }
  if (buffer.droppedThroughSequence > appliedSequence) {
    return { events: [], lostEvents: true };
  }
  const events: TEvent[] = [];
  let latestSequence = appliedSequence;
  for (const event of buffer.events.toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.sequence > latestSequence) {
      latestSequence = event.sequence;
      events.push(event);
    }
  }
  return { events, lostEvents: false };
}
