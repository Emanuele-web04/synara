import {
  EventId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
} from "./providerRuntimeEventIngress.ts";
import { makeBoundedCallbackIngress } from "./boundedCallbackIngress.ts";

function runtimeDelta(rawPayload: unknown): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.makeUnsafe("runtime-ingress-event"),
    provider: "codex",
    createdAt: "2026-08-20T00:00:00.000Z",
    threadId: ThreadId.makeUnsafe("runtime-ingress-thread"),
    turnId: TurnId.makeUnsafe("runtime-ingress-turn"),
    payload: { streamKind: "assistant_text", delta: "hello" },
    raw: {
      source: "codex.app-server.notification",
      method: "item/agentMessage/delta",
      payload: rawPayload,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider runtime event ingress sizing", () => {
  it("preserves task settlement and turn aborts under callback pressure", async () => {
    const base = runtimeDelta({});
    const taskId = RuntimeTaskId.makeUnsafe("memory-task");
    const terminals: ProviderRuntimeEvent[] = [
      { ...base, type: "turn.aborted", payload: { reason: "cancelled" } },
      { ...base, type: "task.completed", payload: { taskId, status: "completed" } },
      ...(["completed", "failed", "killed", "paused"] as const).map((status) => ({
        ...base,
        type: "task.updated" as const,
        payload: { taskId, status },
      })),
    ];
    for (const terminal of terminals) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const processed: ProviderRuntimeEvent[] = [];
            const ingress = yield* makeBoundedCallbackIngress<ProviderRuntimeEvent, never, never>(
              (event) =>
                Effect.sync(() => processed.push(event)).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              {
                capacity: 2,
                maxBufferedBytes: 100,
                terminalReserve: 1,
                isTerminal: isTerminalProviderRuntimeEvent,
                sizeOf: () => 1,
              },
            );
            ingress.offer(base);
            yield* Deferred.await(started);
            expect(ingress.offer(base)).toBe("accepted");
            expect(ingress.offer(base)).toBe("dropped");
            expect(ingress.offer(terminal)).toBe("accepted");
            yield* Deferred.succeed(release, undefined);
            yield* ingress.stop;
            expect(processed).toContain(terminal);
          }),
        ),
      );
    }
  });

  it("strips canonical and raw image bodies before sizing without changing model delivery", () => {
    const data = Buffer.alloc(512 * 1024, 123).toString("base64");
    const image = { type: "image", data, mimeType: "image/png" };
    const event: ProviderRuntimeEvent = {
      ...runtimeDelta({ content: [image] }),
      type: "item.completed",
      payload: { itemType: "mcp_tool_call", data: { result: { content: [image] } } },
    };
    const stringify = vi.spyOn(JSON, "stringify");
    const sized = compactProviderRuntimeEventForIngress(event);
    expect(sized.bytes).toBeLessThan(2000);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(sized.event.raw?.payload).toMatchObject({ content: [{ synaraImageOmitted: true }] });
    expect(JSON.stringify(sized.event)).not.toContain(data);
    expect(image.data).toBe(data);
    expect(sized.bytes).toBe(Buffer.byteLength(JSON.stringify(sized.event), "utf8"));
  });

  it("measures a normal event once and carries its exact byte count", () => {
    const event = runtimeDelta({ delta: "hello" });
    const expectedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const stringify = vi.spyOn(JSON, "stringify");
    const sized = compactProviderRuntimeEventForIngress(event);

    expect(sized.event).toBe(event);
    expect(sized.bytes).toBe(expectedBytes);
    expect(stringify).toHaveBeenCalledTimes(1);
  });

  it("measures the original and replacement objects once when compaction is required", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const event = runtimeDelta({
      output: "x".repeat(PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES),
    });
    const sized = compactProviderRuntimeEventForIngress(event);
    const callsBeforeAssertion = stringify.mock.calls.length;

    expect(sized.event).not.toBe(event);
    expect(sized.event.raw?.payload).toMatchObject({
      synaraTruncated: true,
      originalBytes: expect.any(Number),
    });
    expect(callsBeforeAssertion).toBe(2);
    expect(sized.bytes).toBe(Buffer.byteLength(JSON.stringify(sized.event), "utf8"));
  });
});
