// FILE: httpRoute.test.ts
// Purpose: Verifies remote negotiation admission and live bridge session ownership.
// Layer: Host connection route integration tests

import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  RemoteConnectionUnavailable,
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WsCompatibilityError,
} from "@synara/contracts";
import { Duration, Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../accountAuth";
import { RemoteSessionRegistryLive } from "../remoteSessions/sessionRegistry";
import {
  AuthError,
  ServerAuth,
  type AuthRequest,
  type ServerAuthShape,
} from "../auth/Services/ServerAuth";
import {
  MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
  SessionCredentialServiceLive,
} from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeBoundedNodeHttpServer } from "../nodeHttpServer";
import { controllerProtocol } from "./dialer";
import { RemoteHostTrustError } from "./failure";
import { hostConnectionRouteLayer } from "./httpRoute";
import {
  HostConnectionRegistry,
  HostConnectionRegistryService,
  REMOTE_ATTACHMENT_QUERY,
} from "./registry";

const desktopOrigin = "synara://app";

/** Only synthetic owner/client credentials are exposed to this isolated loopback fixture. */
async function withRemoteNegotiation(
  failure: Error,
  run: (fixture: {
    readonly url: string;
    readonly dials: () => number;
    readonly registry: HostConnectionRegistry;
  }) => Promise<void>,
): Promise<void> {
  const registry = new HostConnectionRegistry();
  let dials = 0;
  registry.setConnector("host", "Fixture Mini", async () => {
    dials++;
    throw failure;
  });
  const auth = {
    authenticateWebSocketUpgrade: (request: AuthRequest) => {
      const token = request.headers.authorization;
      if (token !== "Bearer owner" && token !== "Bearer client") {
        return Effect.fail(new AuthError({ message: "Unauthorized", status: 401 }));
      }
      return Effect.succeed({
        sessionId: AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111"),
        subject: "fixture",
        method: "bearer-session-token",
        role: token === "Bearer owner" ? "owner" : "client",
      });
    },
  } as unknown as ServerAuthShape;
  const scope = await Effect.runPromise(Scope.make("sequential"));
  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerAuth, auth),
          Layer.succeed(HostConnectionRegistryService, registry),
          RemoteSessionRegistryLive,
          SessionCredentialServiceLive.pipe(
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(ServerSecretStoreLive),
          ),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(
              process.cwd(),
              { prefix: "synara-remote-negotiate-" },
              { host: "127.0.0.1" },
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        scope,
      ),
    );
    const port = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const server = yield* makeBoundedNodeHttpServer(() => http.createServer(), {
            host: "127.0.0.1",
            port: 0,
          });
          yield* server.serve(yield* HttpRouter.toHttpEffect(hostConnectionRouteLayer));
          if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP");
          return server.address.port;
        }).pipe(Effect.provide(context)),
        scope,
      ),
    );
    const query = new URLSearchParams({
      [WS_NEGOTIATE_QUERY.clientBuild]: controllerProtocol.clientBuild,
      [WS_NEGOTIATE_QUERY.protocolEpoch]: String(controllerProtocol.protocolEpoch),
      [WS_NEGOTIATE_QUERY.minRevision]: String(controllerProtocol.minRevision),
      [WS_NEGOTIATE_QUERY.maxRevision]: String(controllerProtocol.maxRevision),
    });
    await run({
      url: `http://127.0.0.1:${port}/ws/remote/host${WS_NEGOTIATE_HTTP_PATH}?${query}`,
      dials: () => dials,
      registry,
    });
  } finally {
    registry.closeAll();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const ownerHeaders = { authorization: "Bearer owner", origin: desktopOrigin };

describe("remote negotiation failures", () => {
  it.each([
    { state: "revoked", failure: new RemoteHostTrustError("private trust detail") },
    { state: "needs-sign-in", failure: new SessionExpiredError() },
  ] as const)(
    "returns only typed $state metadata on initial and subsequent refusal",
    async ({ state, failure }) => {
      await withRemoteNegotiation(failure, async ({ url, dials }) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(url, { headers: ownerHeaders });
          expect(response.status).toBe(409);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("access-control-allow-origin")).toBe(desktopOrigin);
          const body = await response.json();
          expect(body).toEqual({ code: "REMOTE_CONNECTION_REQUIRES_ATTENTION", state });
          expect(Schema.is(RemoteConnectionUnavailable)(body)).toBe(true);
        }
        expect(dials()).toBe(1);
      });
    },
  );

  it("preserves the original compatibility verdict before returning typed terminal state", async () => {
    const failure = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "fixture",
      protocolEpoch: controllerProtocol.protocolEpoch,
      minRevision: controllerProtocol.minRevision,
      maxRevision: controllerProtocol.maxRevision,
    });
    await withRemoteNegotiation(failure, async ({ url, dials }) => {
      const first = await fetch(url, { headers: ownerHeaders });
      expect(first.status).toBe(426);
      expect(await first.json()).toEqual(JSON.parse(JSON.stringify(failure)));
      const second = await fetch(url, { headers: ownerHeaders });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        code: "REMOTE_CONNECTION_REQUIRES_ATTENTION",
        state: "incompatible",
      });
      expect(dials()).toBe(1);
    });
  });

  it("keeps transient failures and cooldown responses retryable without exposing error text", async () => {
    await withRemoteNegotiation(new Error("private transport detail"), async ({ url, dials }) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, { headers: ownerHeaders });
        expect(response.status).toBe(503);
        expect(await response.text()).toBe("Remote host unavailable");
      }
      expect(dials()).toBe(1);
    });
  });

  it("pauses the real renderer transport at this HTTP route and resumes through a fresh authenticated stream", async () => {
    // Load the browser runtime without pulling its DOM project into server's
    // composite TypeScript program. The integration still uses its real public API.
    const { WsTransport } = await vi.importActual<{
      WsTransport: new (url: string) => {
        getState(): string;
        request(method: string): Promise<unknown>;
        waitForRemoteConnectionRecovery(error: unknown): Promise<boolean>;
        resumeRemoteConnection(): void;
        dispose(): Promise<void>;
      };
    }>("../../../web/src/wsTransport");
    const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(host, "listening");
    host.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag === "Request")
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: null },
            }),
          );
      });
    });
    const fetchHttp = globalThis.fetch;
    const fetch = vi.fn(fetchHttp);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    try {
      await withRemoteNegotiation(
        new RemoteHostTrustError("synthetic revocation"),
        async ({ url, registry }) => {
          const remoteUrl = new URL(url);
          remoteUrl.protocol = "ws:";
          remoteUrl.pathname = "/ws/remote/host/ws";
          remoteUrl.search = "";
          const transport = new WsTransport(remoteUrl.toString());
          try {
            await vi.waitFor(() => expect(transport.getState()).toBe("closed"));
            expect(fetch).toHaveBeenCalledTimes(1);
            const failure = await transport
              .request("server.getEnvironment")
              .catch((error) => error);
            const recovery = transport.waitForRemoteConnectionRecovery(failure);
            registry.remove("host");
            registry.setConnector("host", "Fixture Mini", async () => {
              const address = host.address();
              if (!address || typeof address === "string") throw new Error("Expected TCP");
              const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
              await once(socket, "open");
              return {
                socket,
                environmentId: "fixture-environment",
                credential: "synthetic-server-only",
                credentialExpiresAtSeconds: Date.now() / 1_000 + 3_600,
                transport: "cloudflare",
                race: { outcome: "unreachable", attempts: [] },
                compatibility: {
                  protocolEpoch: controllerProtocol.protocolEpoch,
                  negotiatedRevision: controllerProtocol.maxRevision,
                  serverBuild: "fixture",
                  serverInstanceId: "recovered-fixture",
                  capabilities: [],
                },
              };
            });
            transport.resumeRemoteConnection();
            await expect(recovery).resolves.toBe(true);
            await vi.waitFor(() => expect(transport.getState()).toBe("open"), { timeout: 5_000 });
            expect(fetch).toHaveBeenCalledTimes(2);
          } finally {
            await transport.dispose();
          }
        },
      );
    } finally {
      vi.unstubAllGlobals();
      for (const socket of host.clients) socket.terminate();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  });

  it("retains owner authentication and trusted-origin admission before terminal state is exposed", async () => {
    await withRemoteNegotiation(
      new RemoteHostTrustError("private trust detail"),
      async ({ url, dials }) => {
        const client = await fetch(url, {
          headers: { ...ownerHeaders, authorization: "Bearer client" },
        });
        expect(client.status).toBe(403);
        const unauthorized = await fetch(url, {
          headers: { ...ownerHeaders, authorization: "Bearer invalid" },
        });
        expect(unauthorized.status).toBe(401);
        const untrusted = await fetch(url, {
          headers: { ...ownerHeaders, origin: "https://untrusted.example" },
        });
        expect(untrusted.status).toBe(403);
        expect(dials()).toBe(0);
      },
    );
  });
});

/** Uses real durable sessions and two loopback WS peers; no account or native backend is used. */
async function withLiveRemoteBridge(
  run: (fixture: {
    readonly sessions: SessionCredentialServiceShape;
    readonly openBridge: (sessionId?: AuthSessionId) => Promise<{
      readonly local: WebSocket;
      readonly remote: WebSocket;
      readonly received: string[];
    }>;
  }) => Promise<void>,
): Promise<void> {
  const registry = new HostConnectionRegistry();
  const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(host, "listening", { signal: AbortSignal.timeout(2_000) });
  const hostAddress = host.address();
  if (!hostAddress || typeof hostAddress === "string") throw new Error("Expected TCP");
  const sockets = new Set<WebSocket>();
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      return { ...(yield* ServerConfig), authToken: "fixture-startup" };
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        { prefix: "synara-bridge-lifetime-" },
        {
          host: "127.0.0.1",
        },
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const sessionsLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const authLayer = Layer.effect(
    ServerAuth,
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      return {
        authenticateWebSocketUpgrade: (request: AuthRequest) =>
          sessions
            .verifyWebSocketToken(request.url?.searchParams.get("wsToken") ?? "")
            .pipe(
              Effect.mapError(
                (cause) => new AuthError({ message: "Unauthorized", status: 401, cause }),
              ),
            ),
      } as unknown as ServerAuthShape;
    }),
  ).pipe(Layer.provide(sessionsLayer));
  try {
    // Keep the durable session database alive for the complete callback, not
    // merely while creating the HTTP server that will consult it later.
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          configLayer,
          sessionsLayer,
          authLayer,
          Layer.succeed(HostConnectionRegistryService, registry),
          RemoteSessionRegistryLive,
          NodeServices.layer,
        ),
        scope,
      ),
    );
    const { sessions, port } = await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const sessions = yield* SessionCredentialService;
          const server = yield* makeBoundedNodeHttpServer(() => http.createServer(), {
            host: "127.0.0.1",
            port: 0,
          });
          yield* server.serve(yield* HttpRouter.toHttpEffect(hostConnectionRouteLayer));
          if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP");
          return { sessions, port: server.address.port };
        }).pipe(Effect.provide(context)),
        scope,
      ),
    );
    await run({
      sessions,
      openBridge: async (sessionId) => {
        const connection = once(host, "connection", { signal: AbortSignal.timeout(2_000) });
        const outgoing = new WebSocket(`ws://127.0.0.1:${hostAddress.port}`);
        sockets.add(outgoing);
        await once(outgoing, "open", { signal: AbortSignal.timeout(2_000) });
        const [remote] = (await connection) as [WebSocket];
        const received: string[] = [];
        remote.on("message", (data) => {
          received.push(data.toString());
          remote.send(data);
        });
        const attachmentId = registry.add({
          hostId: "host",
          hostName: "Fixture Mini",
          session: {
            socket: outgoing,
            environmentId: "fixture-environment",
            credential: "synthetic-server-only",
            credentialExpiresAtSeconds: Date.now() / 1_000 + 3_600,
            transport: "cloudflare",
            race: { outcome: "unreachable", attempts: [] },
            compatibility: {
              protocolEpoch: controllerProtocol.protocolEpoch,
              negotiatedRevision: controllerProtocol.maxRevision,
              serverBuild: "fixture",
              serverInstanceId: "fixture-host",
              capabilities: [],
            },
          },
        });
        const query = new URLSearchParams({
          [REMOTE_ATTACHMENT_QUERY]: attachmentId,
          [WS_COMPATIBILITY_QUERY.serverInstanceId]: "fixture-host",
        });
        if (sessionId) {
          const ticket = await Effect.runPromise(sessions.issueWebSocketToken(sessionId));
          query.set("wsToken", ticket.token);
        } else {
          query.set("token", "fixture-startup");
        }
        const local = new WebSocket(`ws://127.0.0.1:${port}/ws/remote/host/ws?${query}`);
        sockets.add(local);
        await once(local, "open", { signal: AbortSignal.timeout(2_000) });
        return { local, remote, received };
      },
    });
  } finally {
    registry.closeAll();
    for (const socket of sockets) socket.terminate();
    for (const socket of host.clients) socket.terminate();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
}

async function echoBridge(socket: WebSocket, message: string): Promise<string> {
  const reply = once(socket, "message", { signal: AbortSignal.timeout(2_000) });
  socket.send(message);
  return (await reply)[0].toString();
}

describe("remote bridge session lifetime", () => {
  it("refuses excess owner bridges with HTTP 429 without disrupting admitted bridges", async () => {
    await withLiveRemoteBridge(async ({ sessions, openBridge }) => {
      const owner = await Effect.runPromise(sessions.issue({ role: "owner" }));
      const first = await openBridge(owner.sessionId);
      for (let count = 1; count < MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION; count++) {
        await openBridge(owner.sessionId);
      }
      await expect(openBridge(owner.sessionId)).rejects.toThrow("Unexpected server response: 429");
      await expect(echoBridge(first.local, "still-admitted")).resolves.toBe("still-admitted");
    });
  });

  it.each(["revocation", "expiry"] as const)(
    "closes both relay peers on owner session %s while preserving the trusted local bridge",
    async (ending) => {
      await withLiveRemoteBridge(async ({ sessions, openBridge }) => {
        const owner = await Effect.runPromise(
          sessions.issue({
            role: "owner",
            ...(ending === "expiry" ? { ttl: Duration.seconds(3) } : {}),
          }),
        );
        const bridge = await openBridge(owner.sessionId);
        const trustedLocal = await openBridge();
        await expect(echoBridge(bridge.local, "before")).resolves.toBe("before");
        const closed = Promise.all([
          once(bridge.local, "close", { signal: AbortSignal.timeout(5_000) }),
          once(bridge.remote, "close", { signal: AbortSignal.timeout(5_000) }),
        ]);
        if (ending === "revocation") {
          await expect(Effect.runPromise(sessions.revoke(owner.sessionId))).resolves.toBe(true);
        }
        await closed;
        expect(bridge.local.readyState).toBe(WebSocket.CLOSED);
        expect(bridge.remote.readyState).toBe(WebSocket.CLOSED);
        await expect(
          new Promise<void>((resolve, reject) => {
            bridge.local.send("after", (error) => (error ? reject(error) : resolve()));
          }),
        ).rejects.toThrow();
        expect(bridge.received).toEqual(["before"]);
        await expect(echoBridge(trustedLocal.local, "still-local")).resolves.toBe("still-local");
        trustedLocal.local.close();
      });
    },
  );
});
