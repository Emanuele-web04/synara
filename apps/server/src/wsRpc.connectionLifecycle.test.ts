import http from "node:http";

import type { AuthSessionId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { ServerAuth, AuthError, type ServerAuthShape } from "./auth/Services/ServerAuth";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import {
  MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
  SessionCredentialServiceLive,
} from "./auth/Layers/SessionCredentialService";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService";
import { ServerConfig } from "./config";
import { makeBoundedNodeHttpServer, MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { makeWebsocketRpcRouteLayer } from "./wsRpc";
import { makeCurrentWsFeatureCompatibilitySearchParams } from "./wsCompatibility";

const PingRpc = Rpc.make("test.ping", {
  payload: Schema.Struct({ label: Schema.String }),
  success: Schema.String,
});
const SlowRpc = Rpc.make("test.slow", {
  payload: Schema.Struct({}),
  success: Schema.String,
});
const PingRpcGroup = RpcGroup.make(PingRpc, SlowRpc);

interface RunningTestServer {
  readonly origin: string;
  readonly sessions: SessionCredentialServiceShape;
  readonly logout: (sessionId: AuthSessionId) => Promise<boolean>;
  readonly transportFinalizers: { count: number };
  readonly observedRpc: { decoderCalls: number; handlerCalls: number };
  readonly observedSlowRpc: { started: number; completed: number; finalized: number };
  readonly close: () => Promise<void>;
}

const openSockets = new Set<WebSocket>();

afterEach(() => {
  for (const socket of openSockets) socket.terminate();
  openSockets.clear();
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    openSockets.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      const error = Object.assign(new Error(`Unexpected response: ${response.statusCode}`), {
        statusCode: response.statusCode,
        headers: response.headers,
      });
      reject(error);
    });
  });
}

function waitForCloseInfo(
  socket: WebSocket,
  timeoutMs = 2_000,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for socket close details")),
      timeoutMs,
    );
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForRpcExit(socket: WebSocket, requestId: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for RPC exit ${requestId}`));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame._tag !== "Exit" || String(frame.requestId) !== requestId) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve();
    };
    socket.on("message", onMessage);
  });
}

function makeRpcFrame(totalBytes: number, requestId: string): string {
  const prefix = `{"_tag":"Request","id":"${requestId}","tag":"test.ping","payload":{"label":"`;
  const suffix = `"},"headers":[]}`;
  const paddingBytes = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (paddingBytes < 0) throw new Error("RPC frame byte budget is too small");
  const frame = `${prefix}${"x".repeat(paddingBytes)}${suffix}`;
  expect(Buffer.byteLength(frame)).toBe(totalBytes);
  return frame;
}

function sendFragment(
  socket: WebSocket,
  data: string,
  options: { readonly fin: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(data, { binary: false, compress: false, fin: options.fin }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for socket close")),
      timeoutMs,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function ping(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Socket is not open"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for RPC response")),
      timeoutMs,
    );
    const onMessage = (data: RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame._tag !== "Pong") return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve();
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ _tag: "Ping" }));
  });
}

async function startTestServer(): Promise<RunningTestServer> {
  const baseConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-ws-lifecycle-test-",
  }).pipe(Layer.provide(NodeServices.layer));
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return { ...config, authToken: "force-session-auth" };
    }),
  ).pipe(Layer.provide(baseConfigLayer));
  const sessionsLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const serverAuthLayer = Layer.effect(
    ServerAuth,
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      return {
        authenticateWebSocketUpgrade: (request) => {
          const token = request.url?.searchParams.get("wsToken") ?? "";
          return sessions.verifyWebSocketToken(token).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) => new AuthError({ message: "Unauthorized request.", status: 401, cause }),
            ),
          );
        },
        logoutSession: (sessionId) =>
          sessions
            .revoke(sessionId)
            .pipe(
              Effect.mapError(
                (cause) => new AuthError({ message: "Failed to log out session.", cause }),
              ),
            ),
      } as ServerAuthShape;
    }),
  ).pipe(Layer.provide(sessionsLayer));

  const transportFinalizers = { count: 0 };
  const observedRpc = { decoderCalls: 0, handlerCalls: 0 };
  const observedSlowRpc = { started: 0, completed: 0, finalized: 0 };
  const serializationLayer = Layer.succeed(RpcSerialization.RpcSerialization, {
    contentType: RpcSerialization.json.contentType,
    includesFraming: RpcSerialization.json.includesFraming,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      return {
        decode: (data: Uint8Array | string) => {
          observedRpc.decoderCalls += 1;
          return parser.decode(data);
        },
        encode: parser.encode,
      };
    },
  });
  const handlerLayer = PingRpcGroup.toLayer(
    Effect.succeed({
      "test.ping": (_input: { readonly label: string }) =>
        Effect.sync(() => {
          observedRpc.handlerCalls += 1;
          return "ok";
        }),
      "test.slow": () =>
        Effect.gen(function* () {
          observedSlowRpc.started += 1;
          yield* Effect.sleep(Duration.seconds(30));
          observedSlowRpc.completed += 1;
          return "ok";
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              observedSlowRpc.finalized += 1;
            }),
          ),
        ),
    }),
  );
  const rpcHttpEffectSource = RpcServer.toHttpEffectWebsocket(PingRpcGroup).pipe(
    Effect.provide(handlerLayer.pipe(Layer.provideMerge(serializationLayer))),
    Effect.map((httpEffect) =>
      httpEffect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            transportFinalizers.count += 1;
          }),
        ),
      ),
    ),
  );
  const routeLayer = makeWebsocketRpcRouteLayer(rpcHttpEffectSource);
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(configLayer, sessionsLayer, serverAuthLayer, NodeServices.layer),
      scope,
    ),
  );
  let nodeServer: http.Server | null = null;
  const started = await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const serverAuth = yield* ServerAuth;
        const httpServer = yield* makeBoundedNodeHttpServer(
          () => {
            nodeServer = http.createServer();
            return nodeServer;
          },
          { port: 0, host: "127.0.0.1" },
        );
        const httpApp = yield* HttpRouter.toHttpEffect(routeLayer);
        yield* httpServer.serve(httpApp);
        return { sessions, serverAuth };
      }).pipe(Effect.provide(context)),
      scope,
    ),
  );
  const address = (nodeServer as http.Server | null)?.address();
  if (!address || typeof address !== "object") throw new Error("Expected server address");
  return {
    origin: `ws://127.0.0.1:${address.port}`,
    sessions: started.sessions,
    logout: (sessionId) => Effect.runPromise(started.serverAuth.logoutSession(sessionId)),
    transportFinalizers,
    observedRpc,
    observedSlowRpc,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

async function connectSession(
  server: RunningTestServer,
  ttl?: Duration.Duration,
): Promise<{
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly socket: WebSocket;
}> {
  const issued = await Effect.runPromise(server.sessions.issue(ttl ? { ttl } : undefined));
  const websocket = await Effect.runPromise(server.sessions.issueWebSocketToken(issued.sessionId));
  const socket = await connect(featureSocketUrl(server, websocket.token));
  return { sessionId: issued.sessionId, token: websocket.token, socket };
}

async function connectExistingSession(
  server: RunningTestServer,
  sessionId: AuthSessionId,
): Promise<{ readonly token: string; readonly socket: WebSocket }> {
  const websocket = await Effect.runPromise(server.sessions.issueWebSocketToken(sessionId));
  const socket = await connect(featureSocketUrl(server, websocket.token));
  return { token: websocket.token, socket };
}

function featureSocketUrl(server: RunningTestServer, token: string): string {
  const searchParams = makeCurrentWsFeatureCompatibilitySearchParams("test-client");
  searchParams.set("wsToken", token);
  return `${server.origin}/ws?${searchParams.toString()}`;
}

async function waitForObserved(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observed server state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("websocket RPC payload admission", () => {
  it("rejects feature sockets before auth or RPC decoding when negotiation is missing", async () => {
    const server = await startTestServer();
    try {
      const issued = await Effect.runPromise(server.sessions.issue());
      const websocket = await Effect.runPromise(
        server.sessions.issueWebSocketToken(issued.sessionId),
      );

      await expect(
        connect(`${server.origin}/ws?wsToken=${encodeURIComponent(websocket.token)}`),
      ).rejects.toMatchObject({ statusCode: 426 });
      expect(server.observedRpc).toEqual({ decoderCalls: 0, handlerCalls: 0 });

      const admitted = await connect(featureSocketUrl(server, websocket.token));
      await expect(ping(admitted)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("admits an unfragmented message just below the byte ceiling", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      const frame = makeRpcFrame(MAX_WEBSOCKET_MESSAGE_BYTES - 1, "101");
      const exit = waitForRpcExit(connected.socket, "101");

      connected.socket.send(frame, { binary: false, compress: false });
      await exit;

      expect(server.observedRpc).toEqual({ decoderCalls: 1, handlerCalls: 1 });
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await server.close();
    }
  });

  it("assembles a fragmented message below the byte ceiling exactly once", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      const frame = makeRpcFrame(MAX_WEBSOCKET_MESSAGE_BYTES - 1, "102");
      const splitAt = Math.floor(frame.length / 2);

      await sendFragment(connected.socket, frame.slice(0, splitAt), { fin: false });
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.observedRpc).toEqual({ decoderCalls: 0, handlerCalls: 0 });
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);

      const exit = waitForRpcExit(connected.socket, "102");
      await sendFragment(connected.socket, frame.slice(splitAt), { fin: true });
      await exit;

      expect(server.observedRpc).toEqual({ decoderCalls: 1, handlerCalls: 1 });
    } finally {
      await server.close();
    }
  });

  it("closes an unfragmented oversized message before RPC decoding", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      const finalizersBefore = server.transportFinalizers.count;
      const close = waitForCloseInfo(connected.socket);

      connected.socket.send(makeRpcFrame(MAX_WEBSOCKET_MESSAGE_BYTES + 1, "103"), {
        binary: false,
        compress: false,
      });

      await expect(close).resolves.toMatchObject({ code: 1009 });
      await waitForObserved(() => server.transportFinalizers.count >= finalizersBefore + 1);
      expect(server.observedRpc).toEqual({ decoderCalls: 0, handlerCalls: 0 });

      const recovery = await connectSession(server);
      const recoveryExit = waitForRpcExit(recovery.socket, "104");
      recovery.socket.send(makeRpcFrame(256, "104"), {
        binary: false,
        compress: false,
      });
      await recoveryExit;
      expect(server.observedRpc).toEqual({ decoderCalls: 1, handlerCalls: 1 });
    } finally {
      await server.close();
    }
  });

  it("closes a fragmented message when its aggregate bytes cross the ceiling", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      const frame = makeRpcFrame(MAX_WEBSOCKET_MESSAGE_BYTES + 1, "105");
      const splitAt = Math.floor(frame.length / 2);
      expect(Buffer.byteLength(frame.slice(0, splitAt))).toBeLessThan(MAX_WEBSOCKET_MESSAGE_BYTES);
      expect(Buffer.byteLength(frame.slice(splitAt))).toBeLessThan(MAX_WEBSOCKET_MESSAGE_BYTES);

      await sendFragment(connected.socket, frame.slice(0, splitAt), { fin: false });
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.observedRpc).toEqual({ decoderCalls: 0, handlerCalls: 0 });
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);

      const finalizersBefore = server.transportFinalizers.count;
      const close = waitForCloseInfo(connected.socket);
      void sendFragment(connected.socket, frame.slice(splitAt), { fin: true }).catch(() => {});

      await expect(close).resolves.toMatchObject({ code: 1009 });
      await waitForObserved(() => server.transportFinalizers.count >= finalizersBefore + 1);
      expect(server.observedRpc).toEqual({ decoderCalls: 0, handlerCalls: 0 });
    } finally {
      await server.close();
    }
  });
});

describe("websocketRpcRouteLayer connection lifecycle", () => {
  it("closes with an established socket and finalizes its RPC work", async () => {
    const server = await startTestServer();
    let serverClosed = false;
    try {
      const connected = await connectSession(server);
      connected.socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "200",
          tag: "test.slow",
          payload: {},
          headers: [],
        }),
      );
      await waitForObserved(() => server.observedSlowRpc.started === 1);
      const socketClosed = waitForClose(connected.socket);

      await expect(server.close()).resolves.toBeUndefined();
      serverClosed = true;
      await socketClosed;

      expect(server.observedSlowRpc).toEqual({
        started: 1,
        completed: 0,
        finalized: 1,
      });
      expect(server.transportFinalizers.count).toBeGreaterThanOrEqual(1);
    } finally {
      if (!serverClosed) await server.close();
    }
  }, 2_000);

  it("interrupts and finalizes cancelled request work exactly once", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      connected.socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "201",
          tag: "test.slow",
          payload: {},
          headers: [],
        }),
      );
      await waitForObserved(() => server.observedSlowRpc.started === 1);

      const interrupt = JSON.stringify({ _tag: "Interrupt", requestId: "201" });
      connected.socket.send(interrupt);
      connected.socket.send(interrupt);
      await waitForObserved(() => server.observedSlowRpc.finalized === 1);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(server.observedSlowRpc).toEqual({
        started: 1,
        completed: 0,
        finalized: 1,
      });
      await expect(ping(connected.socket)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("accepts a websocket ticket only once while preserving the established socket", async () => {
    const server = await startTestServer();
    try {
      const connected = await connectSession(server);
      await expect(ping(connected.socket)).resolves.toBeUndefined();

      await expect(connect(featureSocketUrl(server, connected.token))).rejects.toMatchObject({
        statusCode: 401,
      });
      await expect(ping(connected.socket)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns retryable 429 at the per-session socket cap without affecting other sessions", async () => {
    const server = await startTestServer();
    try {
      const first = await connectSession(server);
      const saturatedSockets = [first.socket];
      for (let index = 1; index < MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION; index += 1) {
        saturatedSockets.push((await connectExistingSession(server, first.sessionId)).socket);
      }
      const independent = await connectSession(server);

      const rejectedTicket = await Effect.runPromise(
        server.sessions.issueWebSocketToken(first.sessionId),
      );
      await expect(connect(featureSocketUrl(server, rejectedTicket.token))).rejects.toMatchObject({
        statusCode: 429,
        headers: expect.objectContaining({ "retry-after": "1" }),
      });
      await expect(ping(saturatedSockets[0]!)).resolves.toBeUndefined();
      await expect(ping(independent.socket)).resolves.toBeUndefined();

      const released = saturatedSockets.pop()!;
      const close = waitForClose(released);
      released.close();
      await close;
      await new Promise((resolve) => setTimeout(resolve, 25));

      const replacement = await connectExistingSession(server, first.sessionId);
      await expect(ping(replacement.socket)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("logs out every current-session socket after transport finalization and preserves others", async () => {
    const server = await startTestServer();
    try {
      const revoked = await connectSession(server);
      const revokedSecond = await connectExistingSession(server, revoked.sessionId);
      const survivor = await connectSession(server);
      await expect(ping(revoked.socket)).resolves.toBeUndefined();
      await expect(ping(revokedSecond.socket)).resolves.toBeUndefined();
      await expect(ping(survivor.socket)).resolves.toBeUndefined();
      const revokedClose = waitForClose(revoked.socket);
      const revokedSecondClose = waitForClose(revokedSecond.socket);

      await expect(server.logout(revoked.sessionId)).resolves.toBe(true);
      await Promise.all([revokedClose, revokedSecondClose]);

      expect(revoked.socket.readyState).toBe(WebSocket.CLOSED);
      expect(revokedSecond.socket.readyState).toBe(WebSocket.CLOSED);
      expect(server.transportFinalizers.count).toBeGreaterThanOrEqual(2);
      await expect(ping(revoked.socket)).rejects.toThrow("not open");
      await expect(ping(survivor.socket)).resolves.toBeUndefined();
      await expect(connect(featureSocketUrl(server, revoked.token))).rejects.toThrow("401");
      await expect(connect(featureSocketUrl(server, revokedSecond.token))).rejects.toThrow("401");
    } finally {
      await server.close();
    }
  });

  it("closes an established socket at durable session expiry", async () => {
    const server = await startTestServer();
    try {
      const expiring = await connectSession(server, Duration.seconds(1));
      await expect(ping(expiring.socket)).resolves.toBeUndefined();
      const close = waitForClose(expiring.socket, 3_000);

      await close;

      expect(expiring.socket.readyState).toBe(WebSocket.CLOSED);
      expect(server.transportFinalizers.count).toBeGreaterThanOrEqual(1);
      await expect(connect(featureSocketUrl(server, expiring.token))).rejects.toThrow("401");
    } finally {
      await server.close();
    }
  });
});
