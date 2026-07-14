import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Duration, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import {
  SessionCapacityError,
  SessionCredentialService,
  type SessionCredentialError,
} from "../Services/SessionCredentialService";
import {
  MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
  MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION,
  SessionCredentialServiceLive,
} from "./SessionCredentialService";

const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-auth-session-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const runSessionTest = <A, E>(effect: Effect.Effect<A, E, SessionCredentialService>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

const makeBlockingConnection = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const effect = Effect.acquireUseRelease(
    Deferred.succeed(started, undefined),
    () => Effect.never,
    () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
  );
  return { started, closed, effect } as const;
});

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

  it("consumes websocket tickets exactly once under concurrent verification", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const attempts = yield* Effect.forEach(
          Array.from({ length: 12 }),
          () => sessions.verifyWebSocketToken(websocket.token).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );

        expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt._tag === "Failure")).toHaveLength(11);
      }),
    );
  });

  it("bounds outstanding websocket tickets per session and frees consumed capacity", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const tickets = yield* Effect.forEach(
          Array.from({ length: MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION }),
          () => sessions.issueWebSocketToken(issued.sessionId),
        );

        const capacityError = yield* Effect.flip(
          sessions.issueWebSocketToken(issued.sessionId),
        );
        expect(capacityError).toBeInstanceOf(SessionCapacityError);
        if (capacityError instanceof SessionCapacityError) {
          expect(capacityError.scope).toBe("websocket-tickets");
          expect(capacityError.active).toBe(MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION);
        }

        yield* sessions.verifyWebSocketToken(tickets[0]!.token);
        yield* sessions.issueWebSocketToken(issued.sessionId);
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
        const connection = yield* makeBlockingConnection;

        const fiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(issued.sessionId, connection.effect),
        );
        yield* Deferred.await(connection.started);
        const connected = yield* sessions.listActive();
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(connection.closed);
        const disconnected = yield* sessions.listActive();

        expect(connected[0]?.connected).toBe(true);
        expect(connected[0]?.lastConnectedAt).not.toBeNull();
        expect(disconnected[0]?.connected).toBe(false);
      }),
    );
  });

  it("atomically caps session connections and preserves capacity isolation", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const saturatedSession = yield* sessions.issue({ subject: "saturated" });
        const independentSession = yield* sessions.issue({ subject: "independent" });
        const startedCount = yield* Ref.make(0);
        const connectionEffect = Effect.acquireUseRelease(
          Ref.update(startedCount, (count) => count + 1),
          () => Effect.never,
          () => Effect.void,
        );
        const attempts = yield* Effect.forEach(
          Array.from({ length: MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION + 4 }),
          () =>
            Effect.forkChild(
              sessions.runAuthenticatedConnection(saturatedSession.sessionId, connectionEffect),
            ),
        );

        yield* Effect.sleep(Duration.millis(50));
        expect(yield* Ref.get(startedCount)).toBe(MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION);
        const completed = attempts.map((fiber) => fiber.pollUnsafe());
        const rejected = completed.filter(
          (result) => result?._tag === "Failure",
        );
        expect(rejected).toHaveLength(4);

        const independent = yield* makeBlockingConnection;
        const independentFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(independentSession.sessionId, independent.effect),
        );
        yield* Deferred.await(independent.started);
        expect(yield* Deferred.isDone(independent.closed)).toBe(false);

        yield* Effect.forEach(attempts, Fiber.interrupt, { discard: true });
        yield* Fiber.interrupt(independentFiber);
      }),
    );
  });

  it("interrupts every connection for a revoked session without affecting other sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const revokedSession = yield* sessions.issue({ subject: "revoked-client" });
        const survivingSession = yield* sessions.issue({ subject: "surviving-client" });
        const first = yield* makeBlockingConnection;
        const second = yield* makeBlockingConnection;
        const survivor = yield* makeBlockingConnection;

        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, first.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, second.effect),
        );
        const survivorFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(survivingSession.sessionId, survivor.effect),
        );
        yield* Deferred.await(first.started);
        yield* Deferred.await(second.started);
        yield* Deferred.await(survivor.started);

        expect(yield* sessions.revoke(revokedSession.sessionId)).toBe(true);
        expect(yield* Deferred.isDone(first.closed)).toBe(true);
        expect(yield* Deferred.isDone(second.closed)).toBe(true);
        yield* Deferred.await(first.closed);
        yield* Deferred.await(second.closed);

        expect(yield* Deferred.isDone(survivor.closed)).toBe(false);
        expect(
          (yield* sessions.listActive()).find(
            (item) => item.sessionId === survivingSession.sessionId,
          )?.connected,
        ).toBe(true);

        yield* Fiber.interrupt(survivorFiber);
      }),
    );
  });

  it("rejects connection registration after revocation", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        yield* sessions.revoke(issued.sessionId);

        const error = yield* Effect.flip(
          sessions.runAuthenticatedConnection(issued.sessionId, Effect.void),
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as SessionCredentialError).message).toContain("revoked");
      }),
    );
  });

  it("interrupts revoked connections before revoke-all-except returns", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const currentSession = yield* sessions.issue({ subject: "current-client" });
        const firstRevokedSession = yield* sessions.issue({ subject: "first-revoked-client" });
        const secondRevokedSession = yield* sessions.issue({ subject: "second-revoked-client" });
        const current = yield* makeBlockingConnection;
        const firstRevoked = yield* makeBlockingConnection;
        const secondRevoked = yield* makeBlockingConnection;

        const currentFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(currentSession.sessionId, current.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(firstRevokedSession.sessionId, firstRevoked.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(
            secondRevokedSession.sessionId,
            secondRevoked.effect,
          ),
        );
        yield* Deferred.await(current.started);
        yield* Deferred.await(firstRevoked.started);
        yield* Deferred.await(secondRevoked.started);

        expect(yield* sessions.revokeAllExcept(currentSession.sessionId)).toBe(2);
        expect(yield* Deferred.isDone(firstRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(secondRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(current.closed)).toBe(false);

        yield* Fiber.interrupt(currentFiber);
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
      expect(error.message).toContain("Invalid websocket token");
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });

  it("interrupts an established connection when its session expires", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
      const connection = yield* makeBlockingConnection;

      yield* Effect.forkChild(
        sessions.runAuthenticatedConnection(issued.sessionId, connection.effect),
      );
      yield* Deferred.await(connection.started);
      yield* TestClock.adjust(Duration.seconds(2));
      yield* Deferred.await(connection.closed);

      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });
});
