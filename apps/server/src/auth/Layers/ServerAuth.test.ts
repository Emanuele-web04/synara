import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthControlPlaneLive } from "./AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import { SessionCredentialServiceLive } from "./SessionCredentialService";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService";
import { AuthError, ServerAuth, type AuthRequest } from "../Services/ServerAuth";

const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(ServerSecretStoreLive),
);
const authControlPlaneLayer = AuthControlPlaneLive.pipe(
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
);
const testLayer = ServerAuthLive.pipe(
  Layer.provide(ServerAuthPolicyLive),
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
  Layer.provide(authControlPlaneLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "dpcode-auth-server-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

function makeCookieRequest(sessionToken: string): AuthRequest {
  return {
    headers: {},
    cookies: {
      t3_session: sessionToken,
    },
  };
}

const runServerAuthTest = (effect: Effect.Effect<void, AuthError, ServerAuth>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

describe("ServerAuthLive", () => {
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
});
