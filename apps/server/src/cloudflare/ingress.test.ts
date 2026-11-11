import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { once } from "node:events";
import http from "node:http";
import { Worker } from "node:worker_threads";
import { startCloudflareIngress } from "./ingress";
import type { RemoteTlsServer } from "../remoteTransport/tunnel";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function probe(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path, headers, signal: AbortSignal.timeout(5_000) },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      )
      .on("error", reject);
  });
}

it("denies unknown hosts, admin paths and spoofed forwarded headers on the dedicated listener", async () => {
  let ready = true;
  const accept = vi.fn((socket: WebSocket) => socket.close());
  const ingress = await startCloudflareIngress(
    { accept } as unknown as RemoteTlsServer,
    () => ready,
  );
  cleanups.push(ingress.close);
  ingress.setHostname("assigned.example.test");
  const headers = {
    host: "assigned.example.test",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-host": "localhost",
  };
  expect(await probe(ingress.port, "/health", headers)).toBe(200);
  for (const route of [
    "/",
    "/ws",
    "/api/server",
    "/api/remote/resource",
    "/health?admin=true",
    "/ws/host/v2?token=anything",
  ]) {
    expect(await probe(ingress.port, route, headers)).toBe(404);
  }
  expect(
    await probe(ingress.port, "/health", {
      host: "wrong.example.test",
      "x-forwarded-host": "assigned.example.test",
    }),
  ).toBe(404);
  const socket = new WebSocket(`ws://127.0.0.1:${ingress.port}/ws/host/v2`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
  expect(accept).toHaveBeenCalledWith(expect.anything(), { via: "cloudflare" });
  ready = false;
  expect(await probe(ingress.port, "/health", headers)).toBe(404);
});

it("keeps serving after a peer resets during a paused lease upgrade", async () => {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const host = "assigned.example.test";
  let ready = false;
  let peerReset = false;
  const accept = vi.fn();
  const ingress = await startCloudflareIngress({ accept } as unknown as RemoteTlsServer, () => {
    if (ready) return true;
    // Hold the admission check until the peer has closed its TCP handle.
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    peerReset = Atomics.wait(state, 0, 1, 5_000) !== "timed-out";
    return false;
  });
  cleanups.push(ingress.close);
  ingress.setHostname(host);
  const request = [
    "GET /ws/host/v2 HTTP/1.1",
    `Host: ${host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "",
    "",
  ].join("\r\n");

  // The peer needs its own event loop so it can reset while admission is held.
  const peer = new Worker(
    `
      const { createConnection } = require("node:net");
      const { workerData: { port, request, state } } = require("node:worker_threads");
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.write(request);
        if (Atomics.wait(state, 0, 0, 5000) === "timed-out") {
          throw new Error("Ingress did not receive the upgrade");
        }
        socket.resetAndDestroy();
      });
      socket.once("close", () => {
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
      });
    `,
    { eval: true, workerData: { port: ingress.port, request, state } },
  );
  try {
    const [exitCode] = await once(peer, "exit");
    expect(exitCode).toBe(0);
    expect(peerReset).toBe(true);
    expect(accept).not.toHaveBeenCalled();

    ready = true;
    expect(await probe(ingress.port, "/health", { host })).toBe(200);
  } finally {
    await peer.terminate();
  }
});
