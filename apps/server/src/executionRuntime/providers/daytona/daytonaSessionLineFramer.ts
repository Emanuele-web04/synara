/**
 * Daytona session line framer - the one line-framing + echo-suppression unit
 * shared by every Daytona stdout transport.
 *
 * Both Daytona output transports - the cumulative-body poll loop and the PTY
 * WebSocket - face the identical hazard: codex stdout arrives as raw bytes that
 * can carry zero, partial, or multiple newlines, a single JSON-RPC message can
 * split across two reads, and a written outbound frame is echoed back
 * byte-identically (the PTY/`stty -echo` race) where it would be mis-dispatched
 * as a spurious inbound request. This module owns all three concerns so the
 * transports never duplicate the framing logic (a code smell per AGENTS.md):
 *
 *   - `offerCompleteLines(output)` frames the cumulative output buffer, emitting
 *     only complete lines (text up to and including a `\n`) and carrying the
 *     residual after the last `\n` in `consumed` for the next call. The poll
 *     loop re-passes the whole cumulative body each tick; the PTY path appends
 *     each chunk and re-passes the growing buffer. `consumed` makes both emit
 *     each line exactly once, so a mid-turn fallback (poll after a dropped
 *     stream) that re-reads from offset 0 does not re-emit already-seen lines.
 *   - `flushResidual(output)` emits the trailing residual once the process has
 *     exited and no terminating byte can arrive. A residual that starts like a
 *     JSON object but does not parse is a truncated frame (the process died
 *     mid-write) and is dropped rather than offered as a corrupt half-frame.
 *   - `trackOutboundFrame(line)` / the consume gate suppress echoes: a counted
 *     multiset of written frames drops each echo exactly once, with bounded
 *     retention so a never-echoed entry (echo already disabled at the terminal)
 *     cannot leak.
 *
 * The framer offers into a caller-provided `Queue` so the transport owns the
 * queue lifecycle (`Queue.end` on teardown). It is single-consumer: the two
 * `Ref`s and the echo multiset assume the offer calls are not run concurrently
 * with each other, which both transports satisfy (one forked output fiber).
 *
 * @module daytona/daytonaSessionLineFramer
 */
import { Effect, Queue, Ref, type Cause } from "effect";

const isParseableJson = (value: string): boolean => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

export interface DaytonaSessionLineFramer {
  /**
   * Frame the cumulative output buffer, offering each newly completed line to
   * the queue exactly once. The residual after the last `\n` is retained.
   */
  readonly offerCompleteLines: (output: string) => Effect.Effect<void>;
  /**
   * Flush the trailing residual as a final line once the process has exited.
   * Drops a residual that looks like a truncated JSON frame.
   */
  readonly flushResidual: (output: string) => Effect.Effect<void>;
  /**
   * Record that `line` was written outbound, so its byte-identical echo is
   * dropped on the way back in (the PTY/`stty -echo` race).
   */
  readonly trackOutboundFrame: (line: string) => void;
}

const PENDING_ECHO_LIMIT = 256;

/**
 * Build a framer that offers complete lines into `stdoutQueue`. The queue's
 * error channel is `Cause.Done` so the transport can `Queue.end` it and let the
 * consumer drain the last offered lines on teardown.
 */
export const makeDaytonaSessionLineFramer = (
  stdoutQueue: Queue.Queue<string, Cause.Done>,
): Effect.Effect<DaytonaSessionLineFramer> =>
  Effect.gen(function* () {
    const consumed = yield* Ref.make(0);

    // A counted multiset of outbound frames plus an insertion-ordered key list
    // for bounded eviction. A duplicate write is suppressed as many times as it
    // was written, never more; the oldest tracked frame is dropped once the
    // window is full so a never-echoed entry cannot leak.
    const pendingEcho = new Map<string, number>();
    const pendingEchoOrder: string[] = [];

    const trackOutboundFrame = (line: string): void => {
      pendingEcho.set(line, (pendingEcho.get(line) ?? 0) + 1);
      pendingEchoOrder.push(line);
      while (pendingEchoOrder.length > PENDING_ECHO_LIMIT) {
        const evicted = pendingEchoOrder.shift();
        if (evicted === undefined) {
          break;
        }
        const remaining = (pendingEcho.get(evicted) ?? 0) - 1;
        if (remaining <= 0) {
          pendingEcho.delete(evicted);
        } else {
          pendingEcho.set(evicted, remaining);
        }
      }
    };

    const consumeEcho = (line: string): boolean => {
      const count = pendingEcho.get(line);
      if (count === undefined || count <= 0) {
        return false;
      }
      if (count === 1) {
        pendingEcho.delete(line);
      } else {
        pendingEcho.set(line, count - 1);
      }
      const index = pendingEchoOrder.indexOf(line);
      if (index >= 0) {
        pendingEchoOrder.splice(index, 1);
      }
      return true;
    };

    const offerCompleteLines = (output: string) =>
      Effect.gen(function* () {
        const seen = yield* Ref.get(consumed);
        const lastNewline = output.lastIndexOf("\n");
        if (lastNewline < seen) {
          return;
        }
        const fresh = output.slice(seen, lastNewline + 1);
        yield* Ref.set(consumed, lastNewline + 1);
        for (const raw of fresh.split("\n")) {
          const line = raw.replace(/\r$/, "");
          if (line.length === 0) {
            continue;
          }
          if (consumeEcho(line)) {
            continue;
          }
          yield* Queue.offer(stdoutQueue, line);
        }
      });

    const flushResidual = (output: string) =>
      Effect.gen(function* () {
        const seen = yield* Ref.get(consumed);
        const residual = output.slice(seen).replace(/\r$/, "");
        if (residual.length === 0) {
          return;
        }
        yield* Ref.set(consumed, output.length);
        if (consumeEcho(residual)) {
          return;
        }
        if (residual.trimStart().startsWith("{") && !isParseableJson(residual)) {
          return;
        }
        yield* Queue.offer(stdoutQueue, residual);
      });

    return { offerCompleteLines, flushResidual, trackOutboundFrame };
  });
