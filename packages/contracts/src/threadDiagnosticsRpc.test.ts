import { Exit, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import { WsServerReadThreadDiagnosticsRpc } from "./rpc";

// This is the exact conversion RpcServer and RpcClient apply. Decoding the
// schema directly misses lossy JSON representations such as Schema.Unknown.
const exitCodec = Schema.toCodecJson(Rpc.exitSchema(WsServerReadThreadDiagnosticsRpc));
const encode = Schema.encodeUnknownSync(exitCodec);
const decode = Schema.decodeUnknownSync(exitCodec);

describe("owner diagnostic RPC JSON transport", () => {
  it.each([
    {
      threadId: "thread-1",
      events: [],
      coverage: {
        source: "orchestration_events",
        highWaterSequence: 0,
        durableSourceComplete: true,
        pageHasOlder: false,
      },
    },
    {
      threadId: "thread-1",
      events: [{ sequence: 7, type: "thread.created", payload: { title: "Computer fixture" } }],
      coverage: {
        source: "orchestration_events",
        highWaterSequence: 7,
        durableSourceComplete: true,
        pageHasOlder: false,
      },
    },
    {
      threadId: "thread-1",
      events: [],
      coverage: {
        source: "provider_runtime_events",
        highWaterSequence: 0,
        oldestRetainedSequence: null,
        retainedForThread: 0,
        globalAcceptedEventCap: 5_000,
        sourceComplete: false,
        pageHasOlder: false,
      },
    },
    {
      threadId: "thread-1",
      events: [
        {
          sequence: 8,
          type: "thread.token-usage.updated",
          detail: {
            payload: {
              usage: {
                cumulativeUsage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5 },
              },
            },
            raw: { token: "[redacted]" },
          },
        },
      ],
      coverage: {
        source: "provider_runtime_events",
        highWaterSequence: 8,
        oldestRetainedSequence: 1,
        retainedForThread: 8,
        globalAcceptedEventCap: 5_000,
        sourceComplete: false,
        pageHasOlder: true,
      },
      requestedLimit: 200,
      appliedLimit: 25,
      nextCursor: "next-page",
    },
  ])("preserves $coverage.source pages and nested evidence over the RPC codec", (page) => {
    const wire = JSON.parse(JSON.stringify(encode(Exit.succeed(page))));
    expect(wire).toEqual({ _tag: "Success", value: page });
    const exit = decode(wire);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) throw new Error("Expected successful page");
    expect(exit.value).toEqual(page);
  });

  it("rejects null or incomplete pages instead of acknowledging missing evidence", () => {
    expect(() => encode(Exit.succeed(null))).toThrow();
    expect(() => encode(Exit.succeed({ threadId: "thread-1", events: [] }))).toThrow();
  });
});
