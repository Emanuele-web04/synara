// FILE: messageTextSegments.ts
// Purpose: Keep a message's streamed text segments consistent with its text after
//          live deltas land on top of a snapshot.
// Layer: Web store helper (pure)
// Why: Segments only arrive with thread snapshots, while later deltas extend the
//      message text. The timeline renders a settled multi-segment message from
//      its segments alone, so stale segments would hide the tail of the reply.
//      These rules mirror the server's message_text_segments projection
//      (`apps/server/src/persistence/messageTextChunks.ts`, completion handling in
//      `ProjectionPipeline.ts`).

import type { OrchestrationMessageTextSegment } from "./types";

export function textSegmentsCoverText(
  segments: ReadonlyArray<OrchestrationMessageTextSegment>,
  text: string,
): boolean {
  let collated = "";
  for (const segment of segments) {
    collated += segment.text;
  }
  return collated === text;
}

/**
 * The segments of a message after one `thread.message-sent` event.
 *
 * The client never derives segments for a message the server did not segment:
 * without a snapshot it has no segments, and it stays that way. A streamed delta
 * extends the tail segment, or opens (or restarts) the segment named by its
 * boundary. A completion keeps multi-segment boundaries only while they still
 * spell the final text; anything else drops them so the full text renders.
 */
export function advanceMessageTextSegments(
  previous: ReadonlyArray<OrchestrationMessageTextSegment> | undefined,
  input: {
    readonly streaming: boolean;
    /** The event's own text: the delta while streaming. */
    readonly deltaText: string;
    /** The message text after the event is applied. */
    readonly nextText: string;
    readonly segmentStartedAt: string | undefined;
    readonly segmentSequence: number;
    readonly updatedAt: string;
  },
): OrchestrationMessageTextSegment[] | undefined {
  if (previous === undefined || previous.length === 0) {
    return undefined;
  }
  if (!input.streaming) {
    if (previous.length < 2 || !textSegmentsCoverText(previous, input.nextText)) {
      return undefined;
    }
    const tail = previous.at(-1)!;
    return [...previous.slice(0, -1), { ...tail, endedAt: input.updatedAt }];
  }
  if (input.segmentStartedAt !== undefined) {
    const opened: OrchestrationMessageTextSegment = {
      sequence: input.segmentSequence,
      startedAt: input.segmentStartedAt,
      endedAt: input.updatedAt,
      text: input.deltaText,
    };
    // A repeated boundary restarts that segment's displayed text.
    const restartedIndex = previous.findIndex(
      (segment) => segment.sequence === input.segmentSequence,
    );
    return restartedIndex >= 0 ? previous.with(restartedIndex, opened) : [...previous, opened];
  }
  const tail = previous.at(-1)!;
  return [
    ...previous.slice(0, -1),
    { ...tail, text: `${tail.text}${input.deltaText}`, endedAt: input.updatedAt },
  ];
}
