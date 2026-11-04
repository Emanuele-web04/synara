import http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config";
import {
  RemoteSessionRegistry,
  RemoteSessionRegistryService,
} from "../../remoteSessions/sessionRegistry";
import { SessionCredentialService } from "../Services/SessionCredentialService";
import { authEffectRouteLayer, projectFaviconEffectRouteLayer } from "../../http";
import { ProjectFaviconResolver } from "../../project/Services/ProjectFaviconResolver";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthControlPlaneLive } from "./AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import { SessionCredentialServiceLive } from "./SessionCredentialService";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService";
import { AuthError, ServerAuth, type AuthRequest } from "../Services/ServerAuth";
import { authenticateRpcWebSocketUpgrade } from "../../wsRpc";

const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(ServerSecretStoreLive),
);
const authControlPlaneLayer = AuthControlPlaneLive.pipe(
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
);
const makeTestLayer = (
  remoteSessions: RemoteSessionRegistry,
  config: Partial<ServerConfigShape> = {},
) =>
  ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provideMerge(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
    Layer.provideMerge(Layer.succeed(RemoteSessionRegistryService, remoteSessions)),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        {
          prefix: "synara-auth-server-test-",
        },
        config,
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

function makeCookieRequest(sessionToken: string, cookieName = "synara_session"): AuthRequest {
  return {
    headers: {},
    cookies: {
      [cookieName]: sessionToken,
    },
  };
}

const runServerAuthTest = <E>(
  effect: Effect.Effect<
    void,
    E,
    ServerAuth | SessionCredentialService | RemoteSessionRegistryService | ServerConfig
  >,
  options: { remoteSessions?: RemoteSessionRegistry; config?: Partial<ServerConfigShape> } = {},
) =>
  effect.pipe(
    Effect.provide(
      makeTestLayer(options.remoteSessions ?? new RemoteSessionRegistry(), options.config),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

describe("ServerAuthLive", () => {
  it.each(["remote", null] as const)(
    "gates verified %s credentials across HTTP and websocket admission",
    async (accessOrigin) => {
      const remoteSessions = new RemoteSessionRegistry();
      remoteSessions.setRemoteBillingEnforced(true);
      let admitted = false;
      remoteSessions.registerAdmissionGuard({ available: () => admitted });
      await runServerAuthTest(
        Effect.gen(function* () {
          const serverAuth = yield* ServerAuth;
          const sessions = yield* SessionCredentialService;
          const identity = {
            role: "owner" as const,
            subject: "owner-bootstrap",
            accessOrigin,
            client: { ...requestMetadata, ipAddress: "127.0.0.1" },
          };
          const cookie = yield* sessions.issue({ ...identity, method: "browser-session-cookie" });
          const bearer = yield* sessions.issue({ ...identity, method: "bearer-session-token" });
          const bearerRequest = {
            headers: { authorization: `Bearer ${bearer.token}` },
            cookies: {},
          };
          const ticket = yield* sessions.issueWebSocketToken(cookie.sessionId);
          for (const authentication of [
            serverAuth.authenticateHttpRequest(makeCookieRequest(cookie.token)),
            serverAuth.authenticateHttpRequest(bearerRequest),
            serverAuth.authenticateWebSocketUpgrade(bearerRequest),
            serverAuth.authenticateWebSocketUpgrade({
              headers: {},
              cookies: {},
              url: new URL(`ws://127.0.0.1/?wsToken=${ticket.token}`),
            }),
          ]) {
            expect((yield* authentication.pipe(Effect.flip, Effect.orDie)).status).toBe(503);
          }
          expect(
            (yield* serverAuth
              .authenticateHttpRequest({
                headers: { authorization: "Bearer invalid" },
                cookies: {},
              })
              .pipe(Effect.flip, Effect.orDie)).status,
          ).toBe(401);

          admitted = true;
          expect(
            (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(cookie.token))).sessionId,
          ).toBe(cookie.sessionId);
          expect((yield* serverAuth.authenticateHttpRequest(bearerRequest)).sessionId).toBe(
            bearer.sessionId,
          );
          expect((yield* serverAuth.authenticateWebSocketUpgrade(bearerRequest)).accessOrigin).toBe(
            accessOrigin,
          );
          const freshTicket = yield* sessions.issueWebSocketToken(cookie.sessionId);
          expect(
            (yield* serverAuth.authenticateWebSocketUpgrade({
              headers: {},
              cookies: {},
              url: new URL(`ws://127.0.0.1/?wsToken=${freshTicket.token}`),
            })).sessionId,
          ).toBe(cookie.sessionId);

          admitted = false;
          expect(
            (yield* serverAuth
              .authenticateHttpRequest(bearerRequest)
              .pipe(Effect.flip, Effect.orDie)).status,
          ).toBe(503);
          remoteSessions.setRemoteBillingEnforced(false);
          expect((yield* serverAuth.authenticateHttpRequest(bearerRequest)).sessionId).toBe(
            bearer.sessionId,
          );
        }),
        { remoteSessions },
      );
    },
  );

  it("mints positive local cookie and bearer sessions only from the private desktop startup secret", async () => {
    const remoteSessions = new RemoteSessionRegistry();
    remoteSessions.setRemoteBillingEnforced(true);
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const cookie = yield* serverAuth.exchangeBootstrapCredential(
          "private-desktop-startup-secret",
          requestMetadata,
        );
        const bearer = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          "private-desktop-startup-secret",
          requestMetadata,
        );
        const cookieSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(cookie.sessionToken, sessions.cookieName),
        );
        expect(cookieSession.accessOrigin).toBe("local");
        expect(cookieSession.subject).toBe("desktop-bootstrap");
        const bearerRequest = {
          headers: { authorization: `Bearer ${bearer.sessionToken}` },
          cookies: {},
        };
        expect((yield* serverAuth.authenticateHttpRequest(bearerRequest)).accessOrigin).toBe(
          "local",
        );
        expect((yield* serverAuth.authenticateWebSocketUpgrade(bearerRequest)).accessOrigin).toBe(
          "local",
        );
        const ticket = yield* serverAuth.issueWebSocketToken(cookieSession);
        expect(
          (yield* serverAuth.authenticateWebSocketUpgrade({
            headers: {},
            cookies: {},
            url: new URL(`ws://127.0.0.1/?wsToken=${ticket.token}`),
          })).accessOrigin,
        ).toBe("local");

        const pairing = yield* serverAuth.issuePairingCredential({ role: "owner" });
        const paired = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          pairing.credential,
          { ...requestMetadata, ipAddress: "127.0.0.1" },
        );
        expect((yield* sessions.verify(paired.sessionToken)).accessOrigin).toBe("remote");
        expect(
          (yield* serverAuth
            .authenticateHttpRequest({
              headers: { authorization: `Bearer ${paired.sessionToken}` },
              cookies: {},
            })
            .pipe(Effect.flip, Effect.orDie)).status,
        ).toBe(503);
      }),
      {
        remoteSessions,
        config: { mode: "desktop", host: "127.0.0.1", authToken: "private-desktop-startup-secret" },
      },
    );
  });

  it("preserves real HTTP identity while paid lease changes gate resources and local bootstrap stays free", async () => {
    const remoteSessions = new RemoteSessionRegistry();
    remoteSessions.setRemoteBillingEnforced(true);
    let leaseExpiresAt = 0;
    remoteSessions.registerAdmissionGuard({ available: () => Date.now() < leaseExpiresAt });
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const config = yield* ServerConfig;
        const unknown = yield* sessions.issue({
          method: "bearer-session-token",
          role: "owner",
          accessOrigin: null,
        });
        const local = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          "private-desktop-startup-secret",
          requestMetadata,
        );
        const server = yield* NodeHttpServer.make(() => http.createServer(), {
          port: 0,
          host: "127.0.0.1",
        });
        const app = yield* HttpRouter.toHttpEffect(
          Layer.mergeAll(authEffectRouteLayer, projectFaviconEffectRouteLayer),
        );
        yield* server.serve(app);
        if (server.address._tag !== "TcpAddress")
          throw new Error("Expected a loopback HTTP listener");
        const url = `http://127.0.0.1:${server.address.port}/api/project-favicon?cwd=${encodeURIComponent(config.cwd)}`;
        const getResource = (token: string, target = url) =>
          Effect.promise(async () => {
            const response = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
            return {
              status: response.status,
              contentType: response.headers.get("content-type"),
              body: await response.text(),
            };
          });
        const sessionUrl = new URL("/api/auth/session", url).href;
        const identity = yield* getResource(unknown.token, sessionUrl);
        expect(identity.status).toBe(200);
        expect(JSON.parse(identity.body)).toMatchObject({ authenticated: true, role: "owner" });
        expect(JSON.parse((yield* getResource("invalid", sessionUrl)).body)).toMatchObject({
          authenticated: false,
        });
        expect((yield* getResource(unknown.token)).status).toBe(503);
        leaseExpiresAt = Date.now() + 60_000;
        const admitted = yield* getResource(unknown.token);
        expect(admitted.status).toBe(200);
        expect(admitted.contentType).toContain("image/svg+xml");
        leaseExpiresAt = Date.now() - 1;
        expect((yield* getResource(unknown.token)).status).toBe(503);
        expect(JSON.parse((yield* getResource(unknown.token, sessionUrl)).body)).toMatchObject({
          authenticated: true,
        });
        expect((yield* getResource(local.sessionToken)).status).toBe(200);
      }).pipe(
        Effect.provideService(ProjectFaviconResolver, { resolvePath: () => Effect.succeed(null) }),
        Effect.provide(NodeHttpServer.layerHttpServices),
        Effect.scoped,
      ),
      {
        remoteSessions,
        config: { mode: "desktop", host: "127.0.0.1", authToken: "private-desktop-startup-secret" },
      },
    );
  });

  it.each([
    { mode: "web" as const, host: "127.0.0.1" },
    { mode: "desktop" as const, host: "0.0.0.0" },
    {
      mode: "desktop" as const,
      host: "127.0.0.1",
      publicUrl: new URL("https://remote.example.test"),
    },
  ])(
    "does not turn the startup token into local bootstrap authority for $mode at $host",
    async (config) => {
      await runServerAuthTest(
        Effect.gen(function* () {
          const serverAuth = yield* ServerAuth;
          for (const exchange of [
            serverAuth
              .exchangeBootstrapCredential("private-desktop-startup-secret", requestMetadata)
              .pipe(Effect.asVoid),
            serverAuth
              .exchangeBootstrapCredentialForBearerSession(
                "private-desktop-startup-secret",
                requestMetadata,
              )
              .pipe(Effect.asVoid),
          ]) {
            expect((yield* exchange.pipe(Effect.flip, Effect.orDie)).status).toBe(401);
          }
        }),
        { config: { ...config, authToken: "private-desktop-startup-secret" } },
      );
    },
  );

  it("maps invalid bootstrap credential failures to 401", () => {
    const error = toBootstrapExchangeAuthError(
      new BootstrapCredentialError({
        message: "Unknown bootstrap credential.",
        status: 401,
      }),
    );

    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid bootstrap credential.");
  });

  it("maps unexpected bootstrap failures to 500", () => {
    const error = toBootstrapExchangeAuthError(
      new BootstrapCredentialError({
        message: "Failed to consume bootstrap credential.",
        status: 500,
        cause: new Error("sqlite is unavailable"),
      }),
    );

    expect(error.status).toBe(500);
    expect(error.message).toBe("Failed to validate bootstrap credential.");
  });

  it("issues client pairing credentials by default", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingCredential = yield* serverAuth.issuePairingCredential();
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairingCredential.credential,
          requestMetadata,
        );
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );

        expect(verified.sessionId.length).toBeGreaterThan(0);
        expect(verified.role).toBe("client");
        expect(verified.accessOrigin).toBe("remote");
        expect(verified.subject).toBe("one-time-token");
      }),
    );
  });

  it("issues startup pairing URLs that bootstrap owner sessions", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
        const listedPairingLinks = yield* serverAuth.listPairingLinks();

        expect(token).toBeTruthy();
        expect(
          listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
        ).toBe(false);

        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          token ?? "",
          requestMetadata,
        );
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );

        expect(verified.role).toBe("owner");
        expect(verified.subject).toBe("owner-bootstrap");
        expect(verified.accessOrigin).toBe("remote");
      }),
    );
  });

  it("lists client sessions with the current owner marked", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const ownerPairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const ownerToken =
          new URLSearchParams(new URL(ownerPairingUrl).hash.slice(1)).get("token") ?? "";
        const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
          ownerToken,
          requestMetadata,
        );
        const ownerSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(ownerExchange.sessionToken),
        );

        const pairingCredential = yield* serverAuth.issuePairingCredential({ label: "CI phone" });
        const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(clientExchange.sessionToken),
        );
        const clients = yield* serverAuth.listClientSessions(ownerSession.sessionId);

        expect(clients).toHaveLength(2);
        expect(clients.find((entry) => entry.sessionId === ownerSession.sessionId)?.current).toBe(
          true,
        );
        expect(clients.find((entry) => entry.sessionId === clientSession.sessionId)?.current).toBe(
          false,
        );
        expect(
          clients.find((entry) => entry.sessionId === clientSession.sessionId)?.client.label,
        ).toBe("CI phone");
      }),
    );
  });

  it("authenticates websocket upgrade tokens issued for a session", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const bootstrapToken =
          new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token") ?? "";
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          bootstrapToken,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        const websocketToken = yield* serverAuth.issueWebSocketToken(session);
        const upgraded = yield* serverAuth.authenticateWebSocketUpgrade({
          headers: {},
          cookies: {},
          url: new URL(`ws://127.0.0.1:3773/?wsToken=${websocketToken.token}`),
        });

        expect(upgraded.sessionId).toBe(session.sessionId);
        expect(upgraded.role).toBe("owner");
      }),
    );
  });

  it("prefers an explicit bearer credential and reports its request provenance", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const cookieCredential = yield* serverAuth.issuePairingCredential();
        const cookieSession = yield* serverAuth.exchangeBootstrapCredential(
          cookieCredential.credential,
          requestMetadata,
        );
        const bearerCredential = yield* serverAuth.issuePairingCredential();
        const bearerSession = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          bearerCredential.credential,
          requestMetadata,
        );

        const authenticated = yield* serverAuth.authenticateHttpRequest({
          headers: { authorization: `Bearer ${bearerSession.sessionToken}` },
          cookies: { synara_session: cookieSession.sessionToken },
        });

        expect(authenticated.credentialSource).toBe("bearer");
        expect(authenticated.sessionId).not.toBe(
          (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(cookieSession.sessionToken)))
            .sessionId,
        );
      }),
    );
  });

  it("logs out the current session, invalidates its websocket ticket, and preserves others", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const currentCredential = yield* serverAuth.issuePairingCredential();
        const currentExchange = yield* serverAuth.exchangeBootstrapCredential(
          currentCredential.credential,
          requestMetadata,
        );
        const currentSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(currentExchange.sessionToken),
        );
        const websocketToken = yield* serverAuth.issueWebSocketToken(currentSession);

        const otherCredential = yield* serverAuth.issuePairingCredential();
        const otherExchange = yield* serverAuth.exchangeBootstrapCredential(
          otherCredential.credential,
          requestMetadata,
        );

        expect(yield* serverAuth.logoutSession(currentSession.sessionId)).toBe(true);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateHttpRequest(makeCookieRequest(currentExchange.sessionToken)),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateWebSocketUpgrade({
              headers: {},
              cookies: {},
              url: new URL(`ws://127.0.0.1:3773/?wsToken=${websocketToken.token}`),
            }),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(otherExchange.sessionToken)))
            .credentialSource,
        ).toBe("cookie");
      }),
    );
  });

  it("keeps an explicit paired client ticket restricted on an accountless loopback server", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const remoteSessions = yield* RemoteSessionRegistryService;
        const pairing = yield* serverAuth.issuePairingCredential({ role: "client" });
        const token = pairing.credential;
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(token, requestMetadata);
        const client = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        const ticket = yield* serverAuth.issueWebSocketToken(client);
        const authenticated = yield* authenticateRpcWebSocketUpgrade({
          config: { host: "127.0.0.1", authToken: undefined, publicUrl: undefined },
          legacyToken: null,
          request: {
            headers: {},
            cookies: {},
            url: new URL(`http://127.0.0.1/ws?wsToken=${encodeURIComponent(ticket.token)}`),
          },
          serverAuth,
          remoteSessions,
        });
        expect(authenticated?.role).toBe("client");
        expect(authenticated?.sessionId).toBe(client.sessionId);
      }),
    );
  });

  it("bootstraps a remote owner session without accepting the legacy websocket token", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const remoteSessions = yield* RemoteSessionRegistryService;
        const config = {
          host: "0.0.0.0",
          authToken: "remote-startup-secret",
          publicUrl: undefined,
        } as const;

        const legacyError = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            headers: {},
            cookies: {},
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
          remoteSessions,
        }).pipe(Effect.flip, Effect.orDie);
        expect(legacyError.status).toBe(401);

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://192.168.1.50:3773");
        const bootstrapToken =
          new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token") ?? "";
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          bootstrapToken,
          requestMetadata,
        );
        const upgraded = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            ...makeCookieRequest(exchanged.sessionToken),
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
          remoteSessions,
        });

        expect(upgraded?.role).toBe("owner");
        expect(upgraded?.subject).toBe("owner-bootstrap");
      }),
    );
  });
});
