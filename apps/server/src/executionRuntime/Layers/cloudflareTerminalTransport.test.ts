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

  it("delivers data frames as inbound lines", async () => {
    const rt = makeRuntime();
    const fake = makeFakeSocket();
    const transport = await rt.runPromise(makeCloudflareTerminalTransport(fake.socket));
    const inboundPromise = firstInbound(rt, transport.inbound);
    fake.deliver({ _tag: "data", data: "ready\n" });
    expect(await inboundPromise).toContain("ready");
    await rt.runPromise(transport.close).catch(() => {});
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
