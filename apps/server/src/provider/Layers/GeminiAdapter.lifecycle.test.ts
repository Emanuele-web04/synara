import { EventId, ThreadId } from "@synara/contracts";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { makeGeminiRuntimeEventBase, teardownGeminiChildProcess } from "./GeminiAdapter.ts";

describe("GeminiAdapter lifecycle generation", () => {
  it("stamps canonical runtime events from the immutable session context", () => {
    expect(
      makeGeminiRuntimeEventBase({
        threadId: ThreadId.makeUnsafe("thread-gemini-generation"),
        lifecycleGeneration: "generation-gemini-a",
        eventId: EventId.makeUnsafe("event-gemini-generation"),
        createdAt: "2026-07-14T15:00:00.000Z",
      }),
    ).toEqual({
      eventId: "event-gemini-generation",
      provider: "gemini",
      threadId: "thread-gemini-generation",
      createdAt: "2026-07-14T15:00:00.000Z",
      lifecycleGeneration: "generation-gemini-a",
    });
  });

  it("awaits shared process-tree exit proof for the Gemini child", async () => {
    class FakeChild extends EventEmitter {
      readonly pid = 4242;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    const child = new FakeChild();
    let rootExitObserved = false;
    const teardown = vi.fn(async (input: { rootPid: number; rootExited: Promise<unknown> }) => {
      expect(input.rootPid).toBe(4242);
      await input.rootExited;
      rootExitObserved = true;
      return { escalated: false, signalErrors: [] };
    });

    const stopping = teardownGeminiChildProcess(child, teardown);
    await Promise.resolve();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(rootExitObserved).toBe(false);

    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
    expect(rootExitObserved).toBe(true);
  });
});
