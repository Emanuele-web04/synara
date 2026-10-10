import {
  ThreadId,
  WsServerReadThreadDiagnosticsRpc,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Exit, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { describe, expect, it, vi } from "vitest";
import {
  makeThreadDiagnosticPageReaders,
  type ThreadDiagnosticPageDependencies,
} from "../agentGateway/threadDiagnosticTools.ts";
import { makeOwnerThreadDiagnosticReader } from "./ownerThreadDiagnostics.ts";

function dependencies() {
  const readThreadEvents = vi.fn(() =>
    Effect.succeed(
      Array.from({ length: 26 }, (_, index) => ({
        sequence: 30 - index,
        event: {
          eventId: `event-${index}`,
          type: "thread.token-usage.updated",
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          createdAt: "2026-09-20T10:00:00.000Z",
          payload: {
            usage: {
              cumulativeUsage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
            },
          },
          raw: { token: "private-credential" },
        },
      })),
    ),
  );
  const requireThreadShell = vi.fn(() => Effect.succeed({} as OrchestrationThreadShell));
  const input = {
    eventStore: {
      getThreadHighWaterSequence: () => Effect.succeed(0),
      readThreadEvents: () => Effect.succeed([]),
    },
    providerRuntimeEvents: {
      getThreadCoverage: () =>
        Effect.succeed({ highWaterSequence: 30, oldestSequence: 5, retainedCount: 26 }),
      readThreadEvents,
    },
    requireThreadShell,
  } as unknown as ThreadDiagnosticPageDependencies;
  return { input, readThreadEvents, requireThreadShell };
}

describe("owner thread diagnostic adapter", () => {
  it("reuses identical sanitized bounded runtime pages and retention coverage", async () => {
    const { input, readThreadEvents } = dependencies();
    const args = { threadId: ThreadId.makeUnsafe("thread-1"), includeDetails: true, limit: 200 };
    const owner = await Effect.runPromise(
      makeOwnerThreadDiagnosticReader(input)({ source: "runtime", ...args }),
    );
    const mcp = await Effect.runPromise(
      makeThreadDiagnosticPageReaders(input).readRuntimeEvents.handler(args),
    );
    expect(mcp.content[0]?.type).toBe("text");
    if (mcp.content[0]?.type !== "text") throw new Error("Missing JSON");
    expect(owner).toEqual(JSON.parse(mcp.content[0].text));
    expect(owner).toMatchObject({
      appliedLimit: 25,
      coverage: { sourceComplete: false, highWaterSequence: 30, pageHasOlder: true },
    });
    expect(JSON.stringify(owner)).not.toContain("private-credential");
    expect(JSON.stringify(owner)).toContain('"inputTokens":100');
    expect(readThreadEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 26 }));
    const wireCodec = Schema.toCodecJson(Rpc.exitSchema(WsServerReadThreadDiagnosticsRpc));
    const wire = Schema.encodeUnknownSync(wireCodec)(Exit.succeed(owner));
    expect(JSON.parse(JSON.stringify(wire))).toEqual({ _tag: "Success", value: owner });
  });

  it("keeps event coverage and validates existence before returning an empty page", async () => {
    const { input, requireThreadShell } = dependencies();
    const page = await Effect.runPromise(
      makeOwnerThreadDiagnosticReader(input)({
        source: "events",
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(requireThreadShell).toHaveBeenCalledWith("thread-1");
    expect(page).toMatchObject({
      events: [],
      coverage: {
        source: "orchestration_events",
        durableSourceComplete: true,
        pageHasOlder: false,
      },
    });
  });

  it("refuses cross-source options and invalid cursors without exposing source errors", async () => {
    const { input } = dependencies();
    const read = makeOwnerThreadDiagnosticReader(input);
    await expect(
      Effect.runPromise(
        read({
          source: "events",
          threadId: ThreadId.makeUnsafe("thread-1"),
          includeDetails: true,
        }),
      ),
    ).rejects.toThrow("do not match");
    await expect(
      Effect.runPromise(
        read({
          source: "runtime",
          threadId: ThreadId.makeUnsafe("thread-1"),
          cursor: "private-invalid-cursor",
        }),
      ),
    ).rejects.toThrow("request was refused");
    const failed = makeOwnerThreadDiagnosticReader({
      ...input,
      requireThreadShell: () => Effect.fail(new Error("private-source-error")),
    });
    await expect(
      Effect.runPromise(failed({ source: "events", threadId: ThreadId.makeUnsafe("thread-1") })),
    ).rejects.not.toThrow("private-source-error");
  });
});
