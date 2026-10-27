import http from "node:http";
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  COMPUTER_FRAME_RESYNC_MESSAGE,
  COMPUTER_FRAME_WS_PATH,
} from "@synara/shared/computerFrame";
import type { FrameSink } from "@synara/shared/frameTransport";

import { makeBoundedNodeHttpServer } from "../nodeHttpServer";
import { authErrorResponse } from "../auth/effectHttp";
import { AuthError } from "../auth/Services/ServerAuth";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import {
  SessionCapacityError,
  SessionCredentialError,
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { runWithRemoteAdmission } from "../auth/remoteAccess";
import { RemoteSessionRegistry } from "../remoteSessions/sessionRegistry";
import { ComputerService, type ComputerServiceShape } from "./Services/ComputerService";
import {
  decodeResyncRequest,
  makeComputerFrameSink,
  makeComputerFrameRouteLayer,
} from "./computerFrameRoute.ts";

describe("computer frame socket messages", () => {
  it("recognizes text and binary resync messages", () => {
    const message = JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE });
    expect(decodeResyncRequest(message)).toBe("resync");
    expect(decodeResyncRequest(new TextEncoder().encode(message))).toBe("resync");
  });

  it("ignores malformed, unrelated, and oversized messages", () => {
    expect(decodeResyncRequest("not json")).toBeNull();
    expect(decodeResyncRequest(JSON.stringify({ type: "other" }))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(["resync"]))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(null))).toBeNull();
    expect(
      decodeResyncRequest(
        JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE, x: "x".repeat(2_000) }),
      ),
    ).toBeNull();
  });
});

describe("computer frame socket sink", () => {
  it("accounts for bytes until a write settles", async () => {
    let settle: (() => void) | undefined;
    const sink = makeComputerFrameSink({
      send: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      isOpen: () => true,
    });
    sink.send(new Uint8Array(128));
    expect(sink.bufferedAmount()).toBe(128);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("clears the backlog when a write fails", async () => {
    const sink = makeComputerFrameSink({
      send: () => Promise.reject(new Error("socket gone")),
      isOpen: () => true,
    });
    sink.send(new Uint8Array(64));
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });
});

describe("computer frame connection lifetime", () => {
  it.each(["default", "lease", "expiry"] as const)(
    "owns the real frame stream through %s authorization",
    async (mode) => {
      const wrapped = mode !== "default";
      const scope = await Effect.runPromise(Scope.make("sequential"));
      const authRuntime = wrapped
        ? ManagedRuntime.make(
            SessionCredentialServiceLive.pipe(
              Layer.provide(SqlitePersistenceMemory),
              Layer.provide(ServerSecretStoreLive),
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "synara-computer-frame-auth-" }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          )
        : undefined;
      let sessions: SessionCredentialServiceShape | undefined;
      const registry = new RemoteSessionRegistry();
      registry.setRemoteBillingEnforced(wrapped);
      let available = true;
      const releaseGuard = registry.registerAdmissionGuard({ available: () => available });
      const unsubscribe = vi.fn();
      let sink: FrameSink | undefined;
      let subscriptions = 0;
      const manager = {
        computerId: "test-computer",
        subscribeFrames: (subscriber: FrameSink) => {
          subscriptions += 1;
          sink = subscriber;
          return unsubscribe;
        },
        requestKeyframe: async () => {},
      } as unknown as ComputerServiceShape["manager"];
      const runAuthorizedConnection: NonNullable<
        Parameters<typeof makeComputerFrameRouteLayer>[0]["runAuthorizedConnection"]
      > = (request, connection) => {
        const sessionService = sessions;
        if (!sessionService)
          return Effect.succeed(
            HttpServerResponse.text("Authentication unavailable", { status: 401 }),
          );
        const header = request.headers.authorization;
        const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        return Effect.gen(function* () {
          const authenticated = yield* sessionService.verify(token);
          return yield* runWithRemoteAdmission(
            registry,
            authenticated,
            sessionService.runAuthenticatedConnection(authenticated.sessionId, connection),
          );
        }).pipe(
          Effect.catch((error) =>
            error instanceof AuthError
              ? Effect.succeed(authErrorResponse(error))
              : error instanceof SessionCapacityError
                ? Effect.succeed(HttpServerResponse.text(error.message, { status: 429 }))
                : error instanceof SessionCredentialError
                  ? Effect.succeed(HttpServerResponse.text(error.message, { status: 401 }))
                  : Effect.fail(error),
          ),
        );
      };
      const route = makeComputerFrameRouteLayer({
        authorizeUpgrade: () => Effect.succeed(true),
        ...(wrapped ? { runAuthorizedConnection } : {}),
      });
      let server: http.Server | undefined;
      let client: WebSocket | undefined;
      let refused: WebSocket | undefined;
      try {
        if (authRuntime)
          sessions = await authRuntime.runPromise(
            Effect.gen(function* () {
              return yield* SessionCredentialService;
            }),
          );
        const issued = sessions
          ? await Effect.runPromise(
              sessions.issue({
                role: "owner",
                accessOrigin: null,
                ttl: mode === "expiry" ? Duration.seconds(2) : Duration.minutes(5),
              }),
            )
          : undefined;
        const socketOptions = issued
          ? { headers: { authorization: `Bearer ${issued.token}` } }
          : undefined;
        await Effect.runPromise(
          Scope.provide(
            Effect.gen(function* () {
              const httpServer = yield* makeBoundedNodeHttpServer(
                () => (server = http.createServer()),
                { port: 0, host: "127.0.0.1" },
              );
              const app = yield* HttpRouter.toHttpEffect(route);
              yield* httpServer.serve(app);
            }).pipe(
              Effect.provideService(ComputerService, {
                supported: true,
                availability: { kind: "available", backend: "fake" },
                manager,
              }),
              Effect.provide(NodeServices.layer),
            ),
            scope,
          ),
        );
        const address = (server as http.Server | undefined)?.address();
        if (!address || typeof address === "string") throw new Error("Frame server did not bind");
        const streamUrl = `ws://127.0.0.1:${address.port}${COMPUTER_FRAME_WS_PATH}?computerId=test-computer`;
        client = new WebSocket(streamUrl, socketOptions);
        await once(client, "open", { signal: AbortSignal.timeout(2_000) });
        await vi.waitFor(() => expect(sink).toBeDefined());
        const activeSink = sink!;
        const frame = once(client, "message", { signal: AbortSignal.timeout(2_000) });
        activeSink.send(Uint8Array.of(1, 2, 3));
        expect((await frame)[0]).toEqual(Buffer.from([1, 2, 3]));

        if (mode === "expiry") {
          const sessionClosed = once(client, "close", { signal: AbortSignal.timeout(6_000) });
          await sessionClosed;
          await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
          expect(activeSink.isOpen()).toBe(false);
          expect(registry.canAdmitRemoteSession()).toBe(true);
          expect(subscriptions).toBe(1);
          return;
        }

        const closed = wrapped
          ? once(client, "close", { signal: AbortSignal.timeout(2_000) })
          : undefined;
        available = false;
        registry.closeAll("Remote authorization unavailable");
        if (closed) {
          await closed;
          await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
          expect(activeSink.isOpen()).toBe(false);

          refused = new WebSocket(streamUrl, socketOptions);
          const opened = vi.fn();
          refused.on("open", opened);
          refused.on("error", () => {});
          const rejection = await once(refused, "unexpected-response", {
            signal: AbortSignal.timeout(2_000),
          });
          const response = rejection[1] as http.IncomingMessage;
          response.resume();
          expect(response.statusCode).toBe(503);
          expect(opened).not.toHaveBeenCalled();
          expect(subscriptions).toBe(1);
          refused.terminate();

          available = true;
          client = new WebSocket(streamUrl, socketOptions);
          await once(client, "open", { signal: AbortSignal.timeout(2_000) });
          await vi.waitFor(() => expect(subscriptions).toBe(2));
          const recoveredFrame = once(client, "message", { signal: AbortSignal.timeout(2_000) });
          sink!.send(Uint8Array.of(6, 7));
          expect((await recoveredFrame)[0]).toEqual(Buffer.from([6, 7]));
          const recoveredClosed = once(client, "close", { signal: AbortSignal.timeout(2_000) });
          client.close();
          await recoveredClosed;
        } else {
          const nextFrame = once(client, "message", { signal: AbortSignal.timeout(2_000) });
          activeSink.send(Uint8Array.of(4, 5));
          expect((await nextFrame)[0]).toEqual(Buffer.from([4, 5]));
          const clientClosed = once(client, "close", { signal: AbortSignal.timeout(2_000) });
          client.close();
          await clientClosed;
        }
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(wrapped ? 2 : 1));
        expect(activeSink.isOpen()).toBe(false);
        expect(sink!.isOpen()).toBe(false);
      } finally {
        releaseGuard();
        refused?.terminate();
        client?.terminate();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await authRuntime?.dispose();
      }
    },
  );
});
