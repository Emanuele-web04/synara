import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { reportReliabilityIssue } from "../reliability";
import { initializeRemoteTlsIdentity, remoteTlsAnchor } from "./certificates";
import { connectRemoteWebSocket, RemoteTlsServer } from "./tunnel";

vi.mock("../reliability", () => ({ reportReliabilityIssue: vi.fn() }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(reportReliabilityIssue).mockClear();
});

async function dial(admit: () => Promise<boolean>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-tunnel-admission-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = await initializeRemoteTlsIdentity(
    path.join(directory, "identity.json"),
    "admission-fixture",
  );
  const accept = vi.fn((socket: WebSocket) => socket.close());
  const tunnel = new RemoteTlsServer({ identity, accept, admit });
  cleanups.push(() => tunnel.close());
  const listener = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  listener.on("connection", (socket) => tunnel.accept(socket));
  cleanups.push(async () => {
    for (const socket of listener.clients) socket.terminate();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP");
  const outer = new WebSocket(`ws://127.0.0.1:${address.port}`);
  cleanups.push(() => outer.terminate());
  await once(outer, "open");
  return {
    accept,
    inner: connectRemoteWebSocket(outer, remoteTlsAnchor(identity)),
  };
}

it.each([
  ["refuses", async () => false],
  ["fails", async () => Promise.reject(new Error("authorization check failed"))],
])("counts an inner upgrade whose admission %s", async (_name, admit) => {
  const { accept, inner } = await dial(admit);
  await expect(inner).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
  expect(reportReliabilityIssue).toHaveBeenCalledExactlyOnceWith("remote.admission_refused");
});

it("does not count an admitted inner upgrade", async () => {
  const { accept, inner } = await dial(async () => true);
  (await inner).terminate();
  expect(accept).toHaveBeenCalledOnce();
  expect(reportReliabilityIssue).not.toHaveBeenCalled();
});
