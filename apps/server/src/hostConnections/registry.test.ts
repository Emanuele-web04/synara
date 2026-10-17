import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { controllerProtocol, type DialedSession } from "./dialer";
import { HostConnectionRegistry } from "./registry";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
