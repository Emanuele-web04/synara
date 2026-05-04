import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import {
  SessionCredentialService,
  type SessionCredentialError,
  type VerifiedSession,
} from "../Services/SessionCredentialService";
import { SessionCredentialServiceLive } from "./SessionCredentialService";

const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "dpcode-auth-session-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const runSessionTest = (
  effect: Effect.Effect<void, SessionCredentialError | VerifiedSession, SessionCredentialService>,
) => effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

describe("SessionCredentialServiceLive", () => {
  it("issues and verifies signed browser session tokens", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          subject: "desktop-bootstrap",
          role: "owner",
          client: {
            label: "Desktop app",
            deviceType: "desktop",
            os: "macOS",
            browser: "Electron",
            ipAddress: "127.0.0.1",
          },
        });
        const verified = yield* sessions.verify(issued.token);

        expect(verified.method).toBe("browser-session-cookie");
        expect(verified.subject).toBe("desktop-bootstrap");
        expect(verified.role).toBe("owner");
        expect(verified.client.label).toBe("Desktop app");
        expect(verified.client.browser).toBe("Electron");
      }),
    );
  });

  it("rejects malformed session tokens", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

        expect(error.message).toContain("Malformed session token");
      }),
    );
  });

  it("issues and verifies websocket tokens for active sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const verified = yield* sessions.verifyWebSocketToken(websocket.token);

        expect(verified.sessionId).toBe(issued.sessionId);
        expect(verified.method).toBe("bearer-session-token");
      }),
    );
  });

  it("lists active sessions and tracks connectivity", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          subject: "client",
          client: { label: "Client", deviceType: "desktop" },
        });

        yield* sessions.markConnected(issued.sessionId);
        const connected = yield* sessions.listActive();
        yield* sessions.markDisconnected(issued.sessionId);
        const disconnected = yield* sessions.listActive();

        expect(connected[0]?.connected).toBe(true);
        expect(connected[0]?.lastConnectedAt).not.toBeNull();
        expect(disconnected[0]?.connected).toBe(false);
      }),
    );
  });

  it("rejects websocket tokens once the parent session has expired", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error.message).toContain("expired");
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });
});
