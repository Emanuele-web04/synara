import { describe, expect, it } from "vitest";

import { decodeFrameResyncRequest, FrameTransport, makeFrameSink } from "./frameTransport";

interface TestFrame {
  readonly sequence: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

class Sink {
  readonly received: Uint8Array[] = [];
  open = true;
  buffered = 0;

  /** Sequence numbers, for the tests that only care about frame order. */
  get sequences(): readonly number[] {
    return this.received.map((bytes) => bytes[0] ?? 0);
  }

  readonly send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
  };
  readonly bufferedAmount = (): number => this.buffered;
  readonly isOpen = (): boolean => this.open;
}

function makeTransport(options: { queueLimit?: number; socketBudgetBytes?: number } = {}) {
  return new FrameTransport<string, TestFrame>({
    encode: (_streamId, frame) =>
      Uint8Array.of(frame.sequence, frame.keyframe ? 1 : 0, frame.codecConfig ? 1 : 0),
    classify: (frame) => ({ keyframe: frame.keyframe, codecConfig: frame.codecConfig }),
    ...options,
  });
}

describe("shared frame transport", () => {
  it("gates new subscribers and primes them with codec config and keyframe", () => {
    const transport = makeTransport();
    const early = new Sink();
    transport.subscribe("desktop", early);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.sequences).toEqual([1, 2]);

    transport.publish("desktop", { sequence: 4, keyframe: false, codecConfig: false });
    expect(early.sequences).toEqual([1, 2, 3, 4]);
  });

  it("drops a stalled backlog until the next keyframe", () => {
    const transport = makeTransport({ queueLimit: 2, socketBudgetBytes: 0 });
    const sink = new Sink();
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: true, codecConfig: false });
    sink.buffered = 100;
    transport.publish("desktop", { sequence: 2, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 4, keyframe: false, codecConfig: false });
    sink.buffered = 0;
    transport.publish("desktop", { sequence: 5, keyframe: true, codecConfig: false });
    transport.publish("desktop", { sequence: 6, keyframe: false, codecConfig: false });

    expect(sink.sequences).toEqual([1, 5, 6]);
    expect(transport.statsFor("desktop")[0]?.awaitingKeyframe).toBe(false);
  });

  it("keeps only the latest codec config for a stalled subscriber", () => {
    const transport = makeTransport({ queueLimit: 2, socketBudgetBytes: 10 });
    const sink = new Sink();
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: true, codecConfig: false });
    sink.buffered = 100;
    for (let sequence = 2; sequence <= 40; sequence += 1) {
      transport.publish("desktop", { sequence, keyframe: false, codecConfig: true });
    }
    expect(transport.statsFor("desktop")[0]?.queued).toBe(1);

    // Deltas before the next keyframe are undecodable under the new config.
    transport.publish("desktop", { sequence: 41, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 42, keyframe: true, codecConfig: false });
    expect(transport.statsFor("desktop")[0]?.queued).toBe(2);

    sink.buffered = 0;
    transport.publish("desktop", { sequence: 43, keyframe: false, codecConfig: false });
    expect(sink.sequences).toEqual([1, 40, 42, 43]);
  });

  it.each([
    { queueLimit: 8, socketBudgetBytes: 1 },
    { queueLimit: 1, socketBudgetBytes: 10 },
  ])("retains configuration across overflowing keyframes with %j", (limits) => {
    const transport = makeTransport(limits);
    const sink = new Sink();
    sink.buffered = 100;
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    for (let sequence = 2; sequence <= 20; sequence += 1) {
      transport.publish("desktop", { sequence, keyframe: true, codecConfig: false });
      expect(transport.statsFor("desktop")[0]?.queued).toBe(1);
      expect(transport.statsFor("desktop")[0]?.awaitingKeyframe).toBe(true);
    }
    sink.buffered = 0;
    transport.publish("desktop", { sequence: 21, keyframe: false, codecConfig: false });
    expect(sink.sequences).toEqual([]);
    transport.publish("desktop", { sequence: 22, keyframe: true, codecConfig: false });
    expect(sink.sequences).toEqual([1, 22]);
  });

  it("retains a late subscriber's config when its cached keyframe overflows", () => {
    const transport = makeTransport({ socketBudgetBytes: 1 });
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });
    const sink = new Sink();
    sink.buffered = 100;
    transport.subscribe("desktop", sink);
    expect(transport.statsFor("desktop")[0]?.queued).toBe(1);
    sink.buffered = 0;
    transport.publish("desktop", { sequence: 3, keyframe: true, codecConfig: false });
    expect(sink.sequences).toEqual([1, 3]);
  });

  it("never primes a subscriber with a keyframe from the previous codec config", () => {
    const transport = makeTransport();
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });
    // A new parameter set lands; the keyframe that matches it has not arrived.
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: true });

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.received).toEqual([Uint8Array.of(3, 0, 1)]);

    transport.publish("desktop", { sequence: 4, keyframe: true, codecConfig: false });
    expect(late.received).toEqual([Uint8Array.of(3, 0, 1), Uint8Array.of(4, 1, 0)]);
  });

  it("releases the cached primer on reset and parks the subscribers", () => {
    const transport = makeTransport();
    const sink = new Sink();
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });

    transport.reset("desktop");
    expect(transport.streamSubscriberCount("desktop")).toBe(1);
    expect(transport.statsFor("desktop")[0]?.awaitingKeyframe).toBe(true);

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.sequences).toEqual([]);
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });
    expect(late.sequences).toEqual([]);
  });

  it("releases the cached primer when the producer ends the stream", () => {
    const transport = makeTransport();
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });

    transport.endStream("desktop");

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.sequences).toEqual([]);
  });

  it("releases the cached primer when the last subscriber goes away", () => {
    const transport = makeTransport();
    const sink = new Sink();
    const unsubscribe = transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });

    unsubscribe();
    expect(transport.subscriberCount).toBe(0);
    // Unsubscribing twice must not disturb whoever replaced this subscriber.
    unsubscribe();

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.sequences).toEqual([]);
    expect(transport.subscriberCount).toBe(1);
  });

  it("drops a subscriber whose sink is already closed and keeps the rest primed", () => {
    const transport = makeTransport();
    const live = new Sink();
    transport.subscribe("desktop", live);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });

    const closed = new Sink();
    closed.open = false;
    transport.subscribe("desktop", closed);
    expect(closed.sequences).toEqual([]);
    expect(transport.subscriberCount).toBe(1);

    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });
    expect(live.sequences).toEqual([1, 2, 3]);

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.sequences).toEqual([1, 2]);
  });

  it("drops a subscriber whose sink closes mid-stream without disturbing the others", () => {
    const transport = makeTransport();
    const first = new Sink();
    const second = new Sink();
    transport.subscribe("desktop", first);
    transport.subscribe("desktop", second);
    transport.publish("desktop", { sequence: 1, keyframe: true, codecConfig: false });

    first.open = false;
    transport.publish("desktop", { sequence: 2, keyframe: false, codecConfig: false });

    expect(transport.subscriberCount).toBe(1);
    expect(first.sequences).toEqual([1]);
    expect(second.sequences).toEqual([1, 2]);
  });

  it("shares bounded sink accounting and resync parsing", async () => {
    let open = true;
    let sent = 0;
    const sink = makeFrameSink({
      send: async (bytes) => {
        sent += bytes.byteLength;
      },
      isOpen: () => open,
    });
    sink.send(Uint8Array.of(1, 2, 3));
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
    expect(sent).toBe(3);
    expect(decodeFrameResyncRequest('{"type":"device.frame.resync"}', "device.frame.resync")).toBe(
      "resync",
    );
    expect(decodeFrameResyncRequest('{"type":"wrong"}', "device.frame.resync")).toBeNull();
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});
