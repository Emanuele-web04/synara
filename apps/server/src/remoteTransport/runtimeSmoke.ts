import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  initializeRemoteTlsIdentity,
  loadRemoteTlsIdentity,
  remoteTlsAnchor,
} from "./certificates";
import { connectRemoteWebSocket, RemoteTlsServer } from "./tunnel";

/** Executed from the built server and packaged Electron Node runtime. */
export async function verifyRemoteTlsRuntime(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-tls-runtime-"));
  let tunnel: RemoteTlsServer | undefined;
  let listener: WebSocketServer | undefined;
  try {
    const file = path.join(directory, "identity.json");
    const identity = await initializeRemoteTlsIdentity(file, "bundled-fixture");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const renewed = await loadRemoteTlsIdentity(
      file,
      "bundled-fixture",
      Date.now() + 65 * 86_400_000,
    );
    assert.equal(renewed.rootCertificate, identity.rootCertificate);
    assert.notEqual(renewed.leafCertificate, identity.leafCertificate);
    tunnel = new RemoteTlsServer({
      identity,
      accept: (socket) => {
        socket.on("message", (data, binary) => socket.send(data, { binary }));
      },
    });
    listener = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    listener.on("connection", (socket) => tunnel!.accept(socket));
    await once(listener, "listening");
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const outer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(outer, "open");
    const inner = await connectRemoteWebSocket(outer, remoteTlsAnchor(identity));
    const bytes = randomBytes(512 * 1024);
    const answer = once(inner, "message");
    inner.send(bytes);
    assert.deepEqual((await answer)[0], bytes);
    inner.terminate();
    console.log(
      JSON.stringify({
        check: "remote TLS runtime",
        passed: true,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        bytes: bytes.length,
        rootPreservedOnRenewal: true,
      }),
    );
  } finally {
    tunnel?.close();
    if (listener) {
      for (const socket of listener.clients) socket.terminate();
      await new Promise<void>((resolve) => listener!.close(() => resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
