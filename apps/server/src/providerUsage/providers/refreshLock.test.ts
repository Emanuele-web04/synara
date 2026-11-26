// FILE: providerUsage/providers/refreshLock.test.ts
// Purpose: Covers per-key refresh serialization and eviction of settled entries.

import { describe, expect, it } from "vitest";

import { createRefreshLock } from "./refreshLock";

describe("createRefreshLock", () => {
  it("serializes concurrent operations on the same key and evicts settled entries", async () => {
    const withRefreshLock = createRefreshLock();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRefreshLock("/tmp/auth-a.json", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = withRefreshLock("/tmp/auth-a.json", async () => {
      events.push("second:start");
      return 2;
    });

    await Promise.resolve();
    expect(withRefreshLock.activeCount()).toBe(1);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    // Allow the microtask cleanup after settlement to run.
    await Promise.resolve();
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(withRefreshLock.activeCount()).toBe(0);
  });

  it("evicts failed operations without poisoning subsequent callers", async () => {
    const withRefreshLock = createRefreshLock();

    await expect(
      withRefreshLock("/tmp/auth-b.json", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await Promise.resolve();
    expect(withRefreshLock.activeCount()).toBe(0);

    await expect(withRefreshLock("/tmp/auth-b.json", async () => "recovered")).resolves.toBe(
      "recovered",
    );
    await Promise.resolve();
    expect(withRefreshLock.activeCount()).toBe(0);
  });
});
