import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcRequestQueue, RpcRequestQueueWaitExpiredError } from "./rpcRequestQueue";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RpcRequestQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants slots in arrival order as holders release", async () => {
    const queue = new RpcRequestQueue({ read: 2 });
    const granted: number[] = [];
    const releases = new Map<number, () => void>();
    for (const id of [1, 2, 3, 4, 5]) {
      void queue.acquire("read").then((release) => {
        granted.push(id);
        releases.set(id, release);
      });
    }
    await flush();
    expect(granted).toEqual([1, 2]);
    releases.get(2)!();
    await flush();
    expect(granted).toEqual([1, 2, 3]);
    // A caller arriving after a release cannot overtake an existing waiter.
    void queue.acquire("read").then(() => granted.push(6));
    releases.get(1)!();
    releases.get(3)!();
    await flush();
    expect(granted).toEqual([1, 2, 3, 4, 5]);
    releases.get(4)!();
    await flush();
    expect(granted).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps lanes independent", async () => {
    const queue = new RpcRequestQueue({ read: 1, control: 1 });
    await queue.acquire("read");
    let readGranted = false;
    void queue.acquire("read").then(() => {
      readGranted = true;
    });
    await expect(queue.acquire("control")).resolves.toBeTypeOf("function");
    await flush();
    expect(readGranted).toBe(false);
  });

  it("removes an aborted waiter without consuming a slot", async () => {
    const queue = new RpcRequestQueue({ read: 1 });
    const release = await queue.acquire("read");
    const controller = new AbortController();
    const aborted = queue.acquire("read", { signal: controller.signal });
    let nextGranted = false;
    void queue.acquire("read").then(() => {
      nextGranted = true;
    });
    controller.abort(new Error("caller gave up"));
    await expect(aborted).rejects.toThrow("caller gave up");
    release();
    await flush();
    expect(nextGranted).toBe(true);
    await expect(
      queue.acquire("read", { signal: AbortSignal.abort(new Error("already")) }),
    ).rejects.toThrow("already");
  });

  it("gives up after the wait limit and lets the next waiter keep its place", async () => {
    vi.useFakeTimers();
    const queue = new RpcRequestQueue({ read: 1 });
    const release = await queue.acquire("read");
    const expiring = queue.acquire("read", { maxWaitMs: 3_000 });
    const patient = queue.acquire("read");
    const expired = expect(expiring).rejects.toBeInstanceOf(RpcRequestQueueWaitExpiredError);
    await vi.advanceTimersByTimeAsync(3_000);
    await expired;
    release();
    release();
    await expect(patient).resolves.toBeTypeOf("function");
  });

  it("starts the wait limit over while waiting may not expire", async () => {
    vi.useFakeTimers();
    const queue = new RpcRequestQueue({ read: 1 });
    const release = await queue.acquire("read");
    let open = false;
    let settled = false;
    const waiting = queue.acquire("read", { maxWaitMs: 3_000, canExpire: () => open });
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false);
    open = true;
    const expired = expect(waiting).rejects.toBeInstanceOf(RpcRequestQueueWaitExpiredError);
    await vi.advanceTimersByTimeAsync(3_000);
    await expired;
    release();
  });

  it("rejects waiters and later acquires once closed", async () => {
    const queue = new RpcRequestQueue({ read: 1 });
    const release = await queue.acquire("read");
    const waiting = queue.acquire("read");
    queue.close(new Error("Transport disposed"));
    await expect(waiting).rejects.toThrow("Transport disposed");
    await expect(queue.acquire("read")).rejects.toThrow("Transport disposed");
    expect(() => release()).not.toThrow();
  });
});
