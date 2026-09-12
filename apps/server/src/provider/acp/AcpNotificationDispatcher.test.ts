import { describe, expect, it, vi } from "vitest";
import { makeAcpNotificationDispatcher } from "./AcpNotificationDispatcher.ts";

describe("ACP notification admission", () => {
  it.each(["bytes", "count"])(
    "rejects overflow by %s and releases a stalled backlog",
    async (limit) => {
      const received: number[] = [];
      const overflow = vi.fn();
      const dispatcher = makeAcpNotificationDispatcher<{ id: number; output: string }>({
        maxCount: limit === "count" ? 3 : 100,
        maxBytes: limit === "bytes" ? 400 : 100_000,
        deliver: (value, signal) => {
          received.push(value.id);
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
        onOverflow: overflow,
      });
      const deliveries: Promise<unknown>[] = [];
      deliveries.push(
        dispatcher.dispatch({ id: 0, output: "x".repeat(100) }).catch((error) => error),
      );
      await vi.waitFor(() => expect(received).toEqual([0]));
      for (let id = 1; id < 20; id++) {
        deliveries.push(
          dispatcher.dispatch({ id, output: "x".repeat(100) }).catch((error) => error),
        );
      }
      expect(dispatcher.status().count).toBeLessThanOrEqual(3);
      expect(dispatcher.status().bytes).toBeLessThanOrEqual(400);
      await Promise.all(deliveries);
      expect(overflow).toHaveBeenCalledTimes(1);
      expect(received).toEqual([0]);
      expect(dispatcher.status()).toEqual({ count: 0, bytes: 0, closed: true });
      await expect(dispatcher.drain()).rejects.toThrow("memory budget");
    },
  );

  it("delivers in order and releases accounting after handler failure", async () => {
    const received: number[] = [];
    const dispatcher = makeAcpNotificationDispatcher<number>({
      maxCount: 10,
      maxBytes: 100,
      deliver: async (value) => {
        received.push(value);
        if (value === 2) throw new Error("handler");
      },
      onOverflow: () => {
        throw new Error("unexpected overflow");
      },
    });
    const results = await Promise.allSettled([1, 2, 3].map(dispatcher.dispatch));
    await dispatcher.drain();
    expect(received).toEqual([1, 2, 3]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(dispatcher.status()).toEqual({ count: 0, bytes: 0, closed: false });
    dispatcher.close();
    await expect(dispatcher.dispatch(4)).rejects.toThrow("closed");
  });
});
