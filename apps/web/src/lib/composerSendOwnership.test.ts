import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  hasActiveComposerSend,
  runComposerSendOnce,
  subscribeComposerSends,
  getActiveComposerSendThreadIds,
} from "./composerSendOwnership";

describe("composer send ownership", () => {
  it("notifies the sidebar when a background send starts and settles", async () => {
    const threadId = ThreadId.makeUnsafe("observable-send");
    const snapshots: boolean[] = [];
    const unsubscribe = subscribeComposerSends(() => {
      snapshots.push(getActiveComposerSendThreadIds().has(threadId));
    });
    try {
      await runComposerSendOnce(threadId, async () => true);
      expect(snapshots).toEqual([true, false]);
    } finally {
      unsubscribe();
    }
  });

  it("coalesces attempts until work settles and releases ownership for retry", async () => {
    const threadId = ThreadId.makeUnsafe("send-ownership");
    let finish!: (result: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn(() => pending);
    const first = runComposerSendOnce(threadId, send);
    expect(hasActiveComposerSend(threadId)).toBe(true);
    expect(runComposerSendOnce(threadId, send)).toBe(first);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    finish(false);
    expect(await first).toBe(false);
    expect(hasActiveComposerSend(threadId)).toBe(false);
    expect(await runComposerSendOnce(threadId, async () => true)).toBe(true);
  });

  it("releases ownership on unexpected rejection without blocking other threads", async () => {
    const threadId = ThreadId.makeUnsafe("failed-send-ownership");
    const failure = runComposerSendOnce(threadId, async () => {
      throw new Error("failed");
    });
    expect(
      await runComposerSendOnce(ThreadId.makeUnsafe("independent-send"), async () => true),
    ).toBe(true);
    await expect(failure).rejects.toThrow("failed");
    expect(hasActiveComposerSend(threadId)).toBe(false);
  });
});
