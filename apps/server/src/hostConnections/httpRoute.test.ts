// FILE: httpRoute.test.ts
// Purpose: Verifies remote negotiation failure contracts at the local HTTP boundary.
// Layer: Host connection route integration tests

import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  RemoteConnectionUnavailable,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WsCompatibilityError,
} from "@synara/contracts";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../accountAuth";
import {
  AuthError,
  ServerAuth,
  type AuthRequest,
  type ServerAuthShape,
} from "../auth/Services/ServerAuth";
import { ServerConfig } from "../config";
import { makeBoundedNodeHttpServer } from "../nodeHttpServer";
import { controllerProtocol } from "./dialer";
import { RemoteHostTrustError } from "./failure";
import { hostConnectionRouteLayer } from "./httpRoute";
import { HostConnectionRegistry, HostConnectionRegistryService } from "./registry";

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
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(
                process.cwd(),
                { prefix: "synara-remote-negotiate-" },
                {
                  host: "127.0.0.1",
                },
              ),
              Layer.succeed(ServerAuth, auth),
              Layer.succeed(HostConnectionRegistryService, registry),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
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
