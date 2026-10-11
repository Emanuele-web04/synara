import http from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Exit, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeBoundedNodeHttpServer } from "./nodeHttpServer";

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: Duplex): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function openPendingUpgrade(port: number, server: http.Server) {
  const upgraded = new Promise<Duplex>((resolve) => {
    server.once("upgrade", (_request, socket) => resolve(socket));
  });
  const client = net.createConnection({ host: "127.0.0.1", port });
  // A reset is expected in these tests and must not become a client-side
  // unhandled event either.
  client.on("error", () => undefined);
  return waitForConnect(client).then(() => {
    client.write(
      [
        "GET /hold HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    return upgraded.then((socket) => ({ client, socket }));
  });
}

describe("bounded Node HTTP server socket lifecycle", () => {
  it("survives peer resets while a WebSocket upgrade route is still pending", async () => {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let nodeServer: http.Server | null = null;
    let serverForCleanup: http.Server | undefined;
    const activeSockets = new Set<Duplex>();
    let releasePendingUpgrades = () => Promise.resolve(false);

    try {
      const port = await Effect.runPromise(
        Scope.provide(
          Effect.gen(function* () {
            const pendingUpgradeGate = yield* Deferred.make<void>();
            releasePendingUpgrades = () =>
              Effect.runPromise(Deferred.succeed(pendingUpgradeGate, undefined));
            const httpServer = yield* makeBoundedNodeHttpServer(
              () => {
                nodeServer = http.createServer();
                return nodeServer;
              },
              { host: "127.0.0.1", port: 0 },
            );
            const httpApp = Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.url === "/hold") {
                yield* Deferred.await(pendingUpgradeGate);
              }
              return HttpServerResponse.text("ok");
            });
            yield* httpServer.serve(httpApp);
            const address = nodeServer?.address();
            if (!address || typeof address === "string") {
              return yield* Effect.die(new Error("Expected a TCP server address"));
            }
            return address.port;
          }).pipe(Effect.provide(NodeServices.layer)),
          scope,
        ),
      );
      const server = nodeServer;
      if (!server) throw new Error("Expected the Node HTTP server");
      serverForCleanup = server;

      // Exercise an actual TCP RST from a client while the Effect upgrade
      // handler is waiting and `ws.handleUpgrade()` has not run yet.
      const first = await withTimeout(openPendingUpgrade(port, server), "first upgrade");
      activeSockets.add(first.client);
      activeSockets.add(first.socket);
      const firstClosed = waitForClose(first.socket);
      first.client.resetAndDestroy();
      await withTimeout(firstClosed, "first reset close");

      // Make the failure deterministic across kernels: this is the exact
      // EventEmitter condition that previously terminated the Node process.
      const second = await withTimeout(openPendingUpgrade(port, server), "second upgrade");
      activeSockets.add(second.client);
      activeSockets.add(second.socket);
      const reset = Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
        errno: -54,
        syscall: "read",
      });
      expect(second.socket.listenerCount("error")).toBeGreaterThan(0);
      expect(() => second.socket.emit("error", reset)).not.toThrow();
      await withTimeout(waitForClose(second.socket), "synthetic reset close");
      second.client.destroy();

      // The transport remains healthy after both resets.
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      for (const socket of activeSockets) socket.destroy();
      serverForCleanup?.closeAllConnections();
      await releasePendingUpgrades();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
