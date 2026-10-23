import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { controllerProtocol, type DialedSession } from "./dialer";
import { HostConnectionRegistry } from "./registry";
import { forwardBoundedRelayResponses, MAX_RELAY_RESPONSE_BYTES } from "../relaySocket";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A native socket boundary whose write completion can be held, failed or cancelled. */
function controlledResponseSocket() {
  const socket = new EventEmitter() as WebSocket;
  Object.setPrototypeOf(socket, WebSocket.prototype);
  Object.defineProperties(socket, {
    readyState: { value: WebSocket.OPEN, writable: true },
    bufferedAmount: { value: 0, writable: true },
  });
  const writes: Array<{
    bytes: Buffer;
    binary: boolean;
    fin: boolean;
    complete: (error?: Error) => void;
  }> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  socket.pause = vi.fn();
  socket.resume = vi.fn();
  socket.send = vi.fn((data, options, callback) => {
    const flags = options as { binary: boolean; fin: boolean };
    writes.push({
      bytes: Buffer.from(data as Buffer),
      binary: flags.binary,
      fin: flags.fin,
      complete: callback as (error?: Error) => void,
    });
  }) as unknown as WebSocket["send"];
  socket.close = vi.fn((code = 1000, reason = "") => {
    closes.push({ code, reason: String(reason) });
    Object.defineProperty(socket, "readyState", { value: WebSocket.CLOSED, writable: true });
    socket.emit("close", code, Buffer.from(reason));
  });
  socket.terminate = vi.fn();
  return { socket, writes, closes };
}

describe("bounded response forwarding", () => {
  it("preserves ordered text, split UTF-8 and binary messages while waiting for each write", async () => {
    const source = controlledResponseSocket();
    const target = controlledResponseSocket();
    const stop = forwardBoundedRelayResponses(source.socket, target.socket);
    const text = Buffer.from(`${"a".repeat(65_535)}🦊${"b".repeat(65_536)}`);
    const binary = Buffer.from([0, 255, 127]);
    source.socket.emit("message", text, false);
    source.socket.emit("message", Buffer.from("next reply"), false);
    source.socket.emit("message", binary, true);
    expect(target.writes).toHaveLength(1);
    expect(source.socket.pause).toHaveBeenCalledTimes(1);
    const messages: Array<{ bytes: Buffer; binary: boolean }> = [];
    let parts: Buffer[] = [];
    for (let index = 0; index < target.writes.length; index++) {
      const write = target.writes[index]!;
      expect(write.bytes.length).toBeLessThanOrEqual(64 * 1024);
      parts.push(write.bytes);
      if (write.fin) {
        messages.push({ bytes: Buffer.concat(parts), binary: write.binary });
        parts = [];
      }
      write.complete();
      await Promise.resolve();
    }
    expect(messages).toEqual([
      { bytes: text, binary: false },
      { bytes: Buffer.from("next reply"), binary: false },
      { bytes: binary, binary: true },
    ]);
    expect(target.closes).toEqual([]);
    expect(source.socket.resume).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each(["response", "waiting bytes", "waiting count", "wire backlog"])(
    "refuses an oversized %s without an unbounded pending queue",
    (limit) => {
      const source = controlledResponseSocket();
      const target = controlledResponseSocket();
      forwardBoundedRelayResponses(source.socket, target.socket);
      if (limit === "wire backlog") {
        Object.defineProperty(target.socket, "bufferedAmount", { value: 8 * 1024 * 1024 });
      }
      source.socket.emit(
        "message",
        Buffer.alloc(limit === "response" ? MAX_RELAY_RESPONSE_BYTES + 1 : 1),
        false,
      );
      if (limit === "waiting bytes") {
        for (let index = 0; index < 4; index++)
          source.socket.emit("message", Buffer.alloc(2 * 1024 * 1024), false);
        expect(target.closes).toEqual([]);
        source.socket.emit("message", Buffer.alloc(1), false);
      }
      if (limit === "waiting count") {
        for (let index = 0; index < 128; index++)
          source.socket.emit("message", Buffer.alloc(0), false);
        expect(target.closes).toEqual([]);
        source.socket.emit("message", Buffer.alloc(0), false);
      }
      expect(target.closes).toMatchObject([{ code: 1009 }]);
      expect(target.writes.length).toBeLessThanOrEqual(1);
      expect(source.socket.listenerCount("message")).toBe(0);
    },
  );

  it("closes a stalled writer and ignores its late completion", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledResponseSocket();
      const target = controlledResponseSocket();
      forwardBoundedRelayResponses(source.socket, target.socket);
      source.socket.emit("message", Buffer.alloc(128 * 1024), false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(target.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(target.closes).toMatchObject([{ code: 1013 }]);
      target.writes[0]!.complete();
      await Promise.resolve();
      expect(target.writes).toHaveLength(1);
      expect(source.socket.listenerCount("message")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["source", "target"])("releases responses when the %s closes", async (side) => {
    const source = controlledResponseSocket();
    const target = controlledResponseSocket();
    forwardBoundedRelayResponses(source.socket, target.socket);
    source.socket.emit("message", Buffer.alloc(128 * 1024), false);
    source.socket.emit("message", Buffer.from("pending reply"), false);
    (side === "source" ? source : target).socket.close();
    target.writes[0]!.complete();
    await Promise.resolve();
    expect(target.writes).toHaveLength(1);
    expect(source.socket.listenerCount("message")).toBe(0);
    expect(target.socket.listenerCount("close")).toBe(0);
  });

  it.each(["throw", "callback"])(
    "propagates a %s write failure without sending the rest",
    async (failure) => {
      const source = controlledResponseSocket();
      const target = controlledResponseSocket();
      if (failure === "throw")
        target.socket.send = () => {
          throw new Error("write failed");
        };
      forwardBoundedRelayResponses(source.socket, target.socket);
      source.socket.emit("message", Buffer.alloc(128 * 1024), false);
      if (failure === "callback") target.writes[0]!.complete(new Error("write failed"));
      await Promise.resolve();
      expect(target.closes).toMatchObject([{ code: 1011 }]);
      expect(target.writes.length).toBeLessThanOrEqual(1);
      expect(source.socket.listenerCount("message")).toBe(0);
    },
  );
});
async function fixture(
  firstTtlSeconds = 3600,
  rpcReply?: (socket: WebSocket, frame: { id: string; tag: string }) => void,
) {
  const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(host, "listening");
  let hostOpens = 0;
  let hostCloses = 0;
  host.on("connection", (socket) => {
    hostOpens++;
    socket.on("close", () => hostCloses++);
    socket.on("message", (data, binary) => {
      if (rpcReply && data.toString().startsWith("{"))
        rpcReply(socket, JSON.parse(data.toString()));
      else socket.send(data, { binary });
    });
  });
  const registry = new HostConnectionRegistry();
  const compatibility = {
    protocolEpoch: 1,
    negotiatedRevision: 1,
    serverBuild: "host-build",
    serverInstanceId: "host-generation",
    capabilities: [],
  };
  let dials = 0;
  const dial = async (): Promise<DialedSession> => {
    dials++;
    const address = host.address();
    if (typeof address === "string" || !address) throw new Error("No address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    return {
      socket,
      compatibility,
      environmentId: "remote-environment",
      credential: "server-only",
      credentialExpiresAtSeconds: Date.now() / 1000 + (dials === 1 ? firstTtlSeconds : 3600),
      transport: "lan",
      race: { outcome: "unreachable", attempts: [] },
    };
  };
  registry.setConnector("host", "Mini", dial);
  const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(bridge, "listening");
  let externalCloseEvents = 0;
  bridge.on("connection", (socket, request) => {
    socket.on("close", () => externalCloseEvents++);
    registry.attach("host", request.url!.slice(1), socket, "host-generation");
  });
  cleanups.push(() => {
    for (const socket of host.clients) socket.terminate();
    host.close();
    for (const socket of bridge.clients) socket.terminate();
    bridge.close();
    registry.closeAll();
  });
  const attach = async (id: string) => {
    const address = bridge.address();
    if (typeof address === "string" || !address) throw new Error("No address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/${id}`);
    await once(socket, "open");
    return socket;
  };
  return { registry, dial, attach, counts: () => ({ hostOpens, hostCloses, externalCloseEvents }) };
}

describe("renderer remote streams", () => {
  it("prepares a fresh stream before renewal and consumes it exactly once after reconnect", async () => {
    const f = await fixture(45.15);
    const first = await f.registry.prepare("host", controllerProtocol);
    const a = await f.attach(first.remoteAttachmentId!);
    expect((await once(a, "close"))[0]).toBe(1012);
    expect(f.counts().hostOpens).toBe(2);
    const second = await f.registry.prepare("host", controllerProtocol);
    const b = await f.attach(second.remoteAttachmentId!);
    expect(second.remoteAttachmentId).not.toBe(first.remoteAttachmentId);
    expect(f.counts().hostOpens).toBe(2);
    const received = once(b, "message");
    b.send("request-id-0-new-renderer");
    expect((await received)[0].toString()).toBe("request-id-0-new-renderer");
    const third = await f.registry.prepare("host", controllerProtocol);
    expect(third.remoteAttachmentId).not.toBe(second.remoteAttachmentId);
    expect(f.counts().hostOpens).toBe(3);
  });

  it("releases the probe stream immediately instead of waiting for an abandoned renderer", async () => {
    const f = await fixture();
    await f.registry.probe("host", controllerProtocol);
    await vi.waitFor(() => expect(f.counts().hostCloses).toBe(1));
    expect(f.registry.status("host").state).toBe("idle");
    expect(f.registry.hasConnector("host")).toBe(true);
  });
  it("gives each renderer an independent stream and closes both sides without removing other owners' listeners", async () => {
    const f = await fixture();
    const first = await f.registry.prepare("host", controllerProtocol);
    const a = await f.attach(first.remoteAttachmentId!);
    const second = await f.registry.prepare("host", controllerProtocol);
    const b = await f.attach(second.remoteAttachmentId!);
    const roundTrip = async (socket: WebSocket, data: string | Buffer) => {
      const response = once(socket, "message");
      socket.send(data);
      return response;
    };
    const [text, textBinary] = await roundTrip(a, "request-id-0");
    expect(text.toString()).toBe("request-id-0");
    expect(textBinary).toBe(false);
    const [bytes, binary] = await roundTrip(b, Buffer.from([0, 255, 11]));
    expect(bytes).toEqual(Buffer.from([0, 255, 11]));
    expect(binary).toBe(true);
    a.close();
    await once(a, "close");
    await vi.waitFor(() =>
      expect(f.counts()).toEqual({ hostOpens: 2, hostCloses: 1, externalCloseEvents: 1 }),
    );
    expect((await roundTrip(b, "still-alive"))[0].toString()).toBe("still-alive");
    const reused = await f.attach(first.remoteAttachmentId!);
    expect((await once(reused, "close"))[0]).toBe(4404);
    const third = await f.registry.prepare("host", controllerProtocol);
    expect(third.remoteAttachmentId).not.toBe(first.remoteAttachmentId);
    const c = await f.attach(third.remoteAttachmentId!);
    expect((await roundTrip(c, "request-id-0"))[0].toString()).toBe("request-id-0");
    f.registry.remove("host");
    await Promise.all([once(b, "close"), once(c, "close")]);
    await vi.waitFor(() => expect(f.counts().hostCloses).toBe(3));
    expect(f.registry.list()).toEqual([]);
  });

  it("uses a private tool stream and keeps the renderer alive after success", async () => {
    let calls = 0;
    const f = await fixture(3600, (socket, frame) => {
      calls++;
      socket.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: frame.id,
          exit: { _tag: "Success", value: { side: "remote" } },
        }),
      );
    });
    const ready = await f.registry.prepare("host", controllerProtocol);
    const renderer = await f.attach(ready.remoteAttachmentId!);
    expect(
      await f.registry.call(
        "host",
        controllerProtocol,
        "agentGateway.call",
        {},
        new AbortController().signal,
      ),
    ).toEqual({ side: "remote" });
    await vi.waitFor(() => expect(f.counts().hostCloses).toBe(1));
    expect(calls).toBe(1);
    expect(f.counts().hostOpens).toBe(2);
    const echo = once(renderer, "message");
    renderer.send("renderer still connected");
    expect((await echo)[0].toString()).toBe("renderer still connected");
  });

  it("aborts the tool stream without replaying a submitted mutation", async () => {
    let calls = 0;
    const abort = new AbortController();
    const f = await fixture(3600, () => {
      calls++;
      abort.abort();
    });
    await expect(
      f.registry.call("host", controllerProtocol, "agentGateway.call", {}, abort.signal),
    ).rejects.toThrow("may have completed");
    await vi.waitFor(() => expect(f.counts().hostCloses).toBe(1));
    expect(calls).toBe(1);
    expect(f.registry.hasConnector("host")).toBe(true);
  });

  it("cancels an in-flight dial on disconnect and never publishes its late result", async () => {
    const f = await fixture();
    f.registry.remove("host");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.registry.setConnector("host", "Mini", async () => {
      await gate;
      return f.dial();
    });
    const preparing = f.registry.prepare("host", controllerProtocol);
    f.registry.remove("host");
    finish();
    await expect(preparing).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(f.counts().hostCloses).toBe(1));
    expect(f.registry.list()).toEqual([]);
  });
});
