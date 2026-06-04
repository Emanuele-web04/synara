import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import {
  makeCloudflareTerminalTransport,
  type BridgeWebSocket,
} from "./cloudflareTerminalTransport.ts";

/** An in-process bridge WebSocket pair driven directly by the test. */
const makeFakeSocket = () => {
  const messageHandlers: Array<(data: string) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const sent: string[] = [];
  let closed = false;
  const socket: BridgeWebSocket = {
    send: (data) => {
      sent.push(data);
    },
    close: () => {
      closed = true;
      for (const handler of closeHandlers) {
        handler();
      }
    },
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
  };
  return {
    socket,
    sent,
    closed: () => closed,
    deliver: (frame: unknown) => {
      for (const handler of messageHandlers) {
        handler(JSON.stringify(frame));
      }
    },
  };
};

type EmptyRuntime = ManagedRuntime.ManagedRuntime<never, never>;

describe("cloudflareTerminalTransport", () => {
  let runtime: EmptyRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose().catch(() => {});
      runtime = undefined;
    }
  });

  const makeRuntime = (): EmptyRuntime => {
    const made = ManagedRuntime.make(Layer.empty);
    runtime = made;
    return made;
  };

  const firstInbound = (
    rt: EmptyRuntime,
    inbound: JsonRpcLineTransport["inbound"],
  ): Promise<string> =>
    rt.runPromise(
      Stream.runHead(inbound).pipe(
        Effect.map((option) => (option._tag === "Some" ? option.value : "")),
      ),
    );

  const takeInbound = (
    rt: EmptyRuntime,
    inbound: JsonRpcLineTransport["inbound"],
    count: number,
  ): Promise<ReadonlyArray<string>> =>
    rt.runPromise(
      Stream.take(inbound, count).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );

  it("delivers data frames as inbound lines", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    const inboundPromise = firstInbound(rt, transport.inbound);
    fake.deliver({ _tag: "data", data: "ready\n" });
    expect(await inboundPromise).toContain("ready");
    await rt.runPromise(transport.close).catch(() => {});
  });

  it("splits a data frame carrying multiple messages into separate inbound lines", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    const inboundPromise = takeInbound(rt, transport.inbound, 2);
    // A single terminal chunk carrying two whole JSON-RPC messages must surface
    // as two inbound elements, not one (each is JSON.parse'd by the consumer).
    fake.deliver({ _tag: "data", data: '{"id":1}\n{"id":2}\n' });
    expect(await inboundPromise).toEqual(['{"id":1}', '{"id":2}']);
    await rt.runPromise(transport.close).catch(() => {});
  });

  it("carries a message split across two data frames as one inbound line", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    const message = '{"jsonrpc":"2.0","id":7,"method":"ping"}';
    const inboundPromise = takeInbound(rt, transport.inbound, 1);
    // The message's bytes arrive across two frames; the first frame ends
    // mid-message (no newline). It must not be emitted until terminated.
    fake.deliver({ _tag: "data", data: message.slice(0, 15) });
    fake.deliver({ _tag: "data", data: `${message.slice(15)}\n` });
    expect(await inboundPromise).toEqual([message]);
    await rt.runPromise(transport.close).catch(() => {});
  });

  it("flushes an unterminated residual line on exit", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    const inboundPromise = takeInbound(rt, transport.inbound, 1);
    // A final message with no trailing newline must still surface once the
    // process exits, since no further bytes can arrive to terminate it.
    fake.deliver({ _tag: "data", data: '{"final":true}' });
    fake.deliver({ _tag: "exit", exitCode: 0 });
    expect(await inboundPromise).toEqual(['{"final":true}']);
  });

  it("relays consumer sends as stdin frames over the socket", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    await rt.runPromise(transport.send({ method: "ping", id: 1 }));
    // Give the forwarding fiber a tick to relay the frame.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frames = fake.sent.map((raw) => JSON.parse(raw) as { _tag: string; data: string });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?._tag).toBe("stdin");
    expect(frames[0]?.data).toContain("ping");
    await rt.runPromise(transport.close).catch(() => {});
  });

  it("resolves the transport exit when the bridge sends an exit frame", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    fake.deliver({ _tag: "exit", exitCode: 0 });
    const exit = await rt.runPromise(Deferred.await(transport.exit));
    expect(exit.code).toBe(0);
  });

  it("closes the socket when the transport is closed", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    await rt.runPromise(transport.close);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.closed()).toBe(true);
  });
});
