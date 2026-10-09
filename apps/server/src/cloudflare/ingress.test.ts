import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import http from "node:http";
import { startCloudflareIngress } from "./ingress";
import type { RemoteTlsServer } from "../remoteTransport/tunnel";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
it("denies unknown hosts, admin paths and spoofed forwarded headers on the dedicated listener", async () => {
  let ready = true;
  const accept = vi.fn((socket: WebSocket) => socket.close());
  const ingress = await startCloudflareIngress(
    { accept } as unknown as RemoteTlsServer,
    () => ready,
  );
  cleanups.push(ingress.close);
  ingress.setHostname("assigned.example.test");
  const url = `http://127.0.0.1:${ingress.port}`;
  const probe = (route: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http
        .get(`${url}${route}`, { headers }, (response) => {
          response.resume();
          resolve(response.statusCode!);
        })
        .on("error", reject);
    });
  const headers = {
    host: "assigned.example.test",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-host": "localhost",
  };
  expect(await probe("/health", headers)).toBe(200);
  for (const route of [
    "/",
    "/ws",
    "/api/server",
    "/api/remote/resource",
    "/health?admin=true",
    "/ws/host/v2?token=anything",
  ]) {
    expect(await probe(route, headers)).toBe(404);
  }
  expect(
    await probe("/health", {
      host: "wrong.example.test",
      "x-forwarded-host": "assigned.example.test",
    }),
  ).toBe(404);
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws/host/v2`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
  expect(accept).toHaveBeenCalledWith(expect.anything(), { via: "cloudflare" });
  ready = false;
  expect(await probe("/health", headers)).toBe(404);
});
