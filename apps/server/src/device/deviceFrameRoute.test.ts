import http from "node:http";
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_TOUCH_MESSAGE,
  DEVICE_FRAME_WS_PATH,
} from "@synara/shared/deviceFrame";
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
import { DeviceService, type DeviceServiceShape } from "./Services/DeviceService";
import {
  decodeDeviceFrameClientMessage,
  decodeResyncRequest,
  makeDeviceFrameSink,
  makeDeviceFrameRouteLayer,
} from "./deviceFrameRoute.ts";

describe("frame socket client messages", () => {
  it("recognizes a resync request in either text or binary framing", () => {
    const message = JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE });

    expect(decodeResyncRequest(message)).toBe("resync");
    expect(decodeResyncRequest(new TextEncoder().encode(message))).toBe("resync");
  });

  it("ignores anything that is not a resync request rather than erroring", () => {
    // A stray log line or a future message type must never kill a stream.
    expect(decodeResyncRequest("hello")).toBeNull();
    expect(decodeResyncRequest("{ not json")).toBeNull();
    expect(decodeResyncRequest(JSON.stringify({ type: "something.else" }))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(["resync"]))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(null))).toBeNull();
  });

  it("refuses an oversized message without parsing it", () => {
    const oversized = JSON.stringify({
      type: DEVICE_FRAME_RESYNC_MESSAGE,
      padding: "x".repeat(4_096),
    });

    expect(decodeResyncRequest(oversized)).toBeNull();
  });

  it("decodes valid live touch events and ignores out-of-bounds or malformed ones", () => {
    expect(
      decodeDeviceFrameClientMessage(
        JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "down", x: 120, y: 340 }),
      ),
    ).toEqual({ kind: "touch", phase: "down", x: 120, y: 340 });
    expect(
      decodeDeviceFrameClientMessage(
        new TextEncoder().encode(
          JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "move", x: 125.5, y: 310 }),
        ),
      ),
    ).toEqual({ kind: "touch", phase: "move", x: 125.5, y: 310 });
    expect(
      decodeDeviceFrameClientMessage(
        JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "up", x: 125.5, y: 310 }),
      ),
    ).toEqual({ kind: "touch", phase: "up", x: 125.5, y: 310 });

    expect(
      decodeDeviceFrameClientMessage(
        JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "hover", x: 10, y: 10 }),
      ),
    ).toBeNull();
    expect(
      decodeDeviceFrameClientMessage(
        JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "down", x: -1, y: 10 }),
      ),
    ).toBeNull();
    expect(
      decodeDeviceFrameClientMessage(
        JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "down", x: 25_000, y: 10 }),
      ),
    ).toBeNull();
  });
});

describe("frame socket sink", () => {
  it("counts bytes handed to the socket until the write settles", async () => {
    let settle: (() => void) | undefined;
    const sink = makeDeviceFrameSink({
      send: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      isOpen: () => true,
    });

    sink.send(new Uint8Array(500));

    // The transport reads this to decide whether the client is keeping up.
    expect(sink.bufferedAmount()).toBe(500);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("clears the backlog even when a write fails", async () => {
    const sink = makeDeviceFrameSink({
      send: () => Promise.reject(new Error("socket gone")),
      isOpen: () => true,
    });

    sink.send(new Uint8Array(64));
    await Promise.resolve();
    await Promise.resolve();

    // A rejected write must not leave phantom bytes that permanently mark the
    // subscriber as slow.
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("reports a closed connection so the transport drops the subscriber", () => {
    let open = true;
    const sink = makeDeviceFrameSink({ send: () => undefined, isOpen: () => open });

    expect(sink.isOpen()).toBe(true);
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});

describe("device frame connection lifetime", () => {
  it.each(["default", "lease", "revoke"] as const)(
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
                ServerConfig.layerTest(process.cwd(), { prefix: "synara-device-frame-auth-" }),
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
      const touched: Array<{ readonly phase: string; readonly x: number; readonly y: number }> = [];
      const downDelivered = Promise.withResolvers<void>();
      const geometry = { pointWidth: 402, pointHeight: 874, scale: 3 };
      const manager = {
        subscribeFrames: (udid: string, subscriber: FrameSink) => {
          expect(udid).toBe("test-device");
          subscriptions += 1;
          sink = subscriber;
          return unsubscribe;
        },
        frameGeometry: () => geometry,
        requestKeyframe: async () => {},
        touch: async (
          udid: string,
          input: { readonly phase: string; readonly x: number; readonly y: number },
        ) => {
          expect(udid).toBe("test-device");
          touched.push(input);
          if (input.phase === "down") await downDelivered.promise;
          if (input.phase === "move") throw new Error("native HID message contains private data");
        },
      } as unknown as DeviceServiceShape["manager"];
      const runAuthorizedConnection: NonNullable<
        Parameters<typeof makeDeviceFrameRouteLayer>[0]["runAuthorizedConnection"]
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
      const route = makeDeviceFrameRouteLayer({
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
              sessions.issue({ role: "owner", accessOrigin: null, ttl: Duration.minutes(5) }),
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
              Effect.provideService(DeviceService, { supported: true, manager }),
              Effect.provide(NodeServices.layer),
            ),
            scope,
          ),
        );
        const address = (server as http.Server | undefined)?.address();
        if (!address || typeof address === "string") throw new Error("Frame server did not bind");
        const streamUrl = `ws://127.0.0.1:${address.port}${DEVICE_FRAME_WS_PATH}?udid=test-device`;
        client = new WebSocket(streamUrl, socketOptions);
        await once(client, "open", { signal: AbortSignal.timeout(2_000) });
        await vi.waitFor(() => expect(sink).toBeDefined());
        const activeSink = sink!;
        const messages: Array<[data: Buffer, binary: boolean]> = [];
        client.on("message", (data, binary) => messages.push([data as Buffer, binary]));
        activeSink.send(Uint8Array.of(1, 2, 3));
        await vi.waitFor(() => expect(messages).toHaveLength(2));
        expect(messages[0]).toEqual([
          Buffer.from(JSON.stringify({ type: "device.frame.geometry", geometry })),
          false,
        ]);
        expect(messages[1]).toEqual([Buffer.from([1, 2, 3]), true]);
        client.send(
          JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "down", x: 50, y: 90 }),
        );
        await vi.waitFor(() => expect(touched).toContainEqual({ phase: "down", x: 50, y: 90 }));

        if (mode === "revoke") {
          const sessionClosed = once(client, "close", { signal: AbortSignal.timeout(6_000) });
          expect(await Effect.runPromise(sessions!.revoke(issued!.sessionId))).toBe(true);
          await sessionClosed;
          downDelivered.resolve();
          await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
          expect(activeSink.isOpen()).toBe(false);
          expect(touched).toEqual([
            { phase: "down", x: 50, y: 90 },
            { phase: "up", x: 50, y: 90 },
          ]);
          expect(registry.canAdmitRemoteSession()).toBe(true);
          expect(subscriptions).toBe(1);
          return;
        }

        const closed = wrapped
          ? once(client, "close", { signal: AbortSignal.timeout(2_000) })
          : undefined;
        downDelivered.resolve();
        if (mode === "default") {
          const failedInput = once(client, "message", { signal: AbortSignal.timeout(2_000) });
          client.send(
            JSON.stringify({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase: "move", x: 52, y: 92 }),
          );
          expect(await failedInput).toEqual([
            Buffer.from(JSON.stringify({ type: "device.frame.touch-error" })),
            false,
          ]);
          expect(touched).toEqual([
            { phase: "down", x: 50, y: 90 },
            { phase: "move", x: 52, y: 92 },
            { phase: "up", x: 50, y: 90 },
          ]);
        }
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
          const recoveredMessages: Buffer[] = [];
          client.on("message", (data) => recoveredMessages.push(data as Buffer));
          sink!.send(Uint8Array.of(6, 7));
          await vi.waitFor(() => expect(recoveredMessages[1]).toEqual(Buffer.from([6, 7])));
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
        downDelivered.resolve();
        releaseGuard();
        refused?.terminate();
        client?.terminate();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await authRuntime?.dispose();
      }
    },
  );
});
