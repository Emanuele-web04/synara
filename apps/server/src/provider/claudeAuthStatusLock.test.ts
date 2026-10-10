// FILE: claudeAuthStatusLock.test.ts
// Purpose: Regression tests for the in-process `claude auth status` mutex.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeAuthStatusLock.ts.
import { describe, it, assert } from "@effect/vitest";

import { acquireClaudeAuthStatusLock } from "./claudeAuthStatusLock.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("claudeAuthStatusLock", () => {
  it("serializes concurrent acquirers with no overlap, in FIFO order", async () => {
    const events: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;

    async function criticalSection(id: number, holdMs: number): Promise<void> {
      const release = await acquireClaudeAuthStatusLock();
      try {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        events.push(`start-${id}`);
        await delay(holdMs);
        events.push(`end-${id}`);
      } finally {
        activeCount -= 1;
        release();
      }
    }

    // Kick off three acquirers in the same tick (before any of them can have
    // acquired the lock yet) so FIFO registration order -- not incidental
    // timer delays -- is what determines execution order.
    const runs = [criticalSection(1, 20), criticalSection(2, 5), criticalSection(3, 15)];
    await Promise.all(runs);

    assert.strictEqual(maxActiveCount, 1);
    assert.deepStrictEqual(events, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("only lets the next acquirer through once release is called", async () => {
    const release1 = await acquireClaudeAuthStatusLock();

    let acquiredSecond = false;
    const secondAcquired = acquireClaudeAuthStatusLock().then((release2) => {
      acquiredSecond = true;
      release2();
    });

    await delay(10);
    assert.strictEqual(acquiredSecond, false);

    release1();
    await secondAcquired;
    assert.strictEqual(acquiredSecond, true);
  });

  it("treats a double release as a harmless no-op", async () => {
    const release = await acquireClaudeAuthStatusLock();
    release();
    release();

    // The lock must still be free for the next acquirer -- a double release
    // must not desynchronize the FIFO chain or deadlock later acquirers.
    const nextRelease = await acquireClaudeAuthStatusLock();
    nextRelease();
  });
});
