/**
 * Device frame WebSocket route.
 *
 * Encoded video gets its own upgrade path rather than sharing the JSON RPC
 * socket. Two reasons, both about not hurting the rest of the app:
 *
 * - Send-queue isolation. On one socket a video backlog sits ahead of RPC
 *   responses in the same queue; on its own connection it cannot.
 * - Compression. The RPC path negotiates per-message deflate; H.264 is already
 *   compressed, so running it through zlib would burn CPU for nothing. This
 *   path lands on the uncompressed WebSocket server (see
 *   `upgradePathAllowsCompression`).
 *
 * Backpressure lives in `DeviceFrameTransport`; this module only adapts an
 * Effect `Socket` into the transport's sink, tracking in-flight bytes itself
 * because the Effect socket exposes no `bufferedAmount`.
 *
 * @module device/deviceFrameRoute
 */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_TOUCH_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  type DeviceFrameTouchPhase,
} from "@synara/shared/deviceFrame";
import { makeFrameSink, type FrameByteStream, type FrameSink } from "@synara/shared/frameTransport";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { frameSocketByteStream } from "../frameSocketByteStream.ts";

import { DeviceService } from "./Services/DeviceService.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";

/** Client control messages on the frame socket are tiny JSON envelopes. */
const MAX_CLIENT_MESSAGE_BYTES = 1_024;
/** Mirrors DeviceCoordinate upper bound in `@synara/contracts`. */
const MAX_TOUCH_COORDINATE = 20_000;

export type DeviceFrameClientMessage =
  | { readonly kind: "resync" }
  | {
      readonly kind: "touch";
      readonly phase: DeviceFrameTouchPhase;
      readonly x: number;
      readonly y: number;
    };

function isTouchPhase(value: unknown): value is DeviceFrameTouchPhase {
  return value === "down" || value === "move" || value === "up";
}

function isValidCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TOUCH_COORDINATE
  );
}

/**
 * Parse a client message on the frame socket (keyframe resync or live touch).
 * Returns null for anything unrecognized or out of bounds, which the caller
 * ignores rather than treating as a protocol error.
 */
export function decodeDeviceFrameClientMessage(
  message: string | Uint8Array,
): DeviceFrameClientMessage | null {
  const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
  if (text.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type === DEVICE_FRAME_RESYNC_MESSAGE) {
    return { kind: "resync" };
  }
  if (
    record.type === DEVICE_FRAME_TOUCH_MESSAGE &&
    isTouchPhase(record.phase) &&
    isValidCoordinate(record.x) &&
    isValidCoordinate(record.y)
  ) {
    return { kind: "touch", phase: record.phase, x: record.x, y: record.y };
  }
  return null;
}

/**
 * Parse a client resync request on the frame socket. Returns "resync", or
 * null for anything else.
 */
export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  const decoded = decodeDeviceFrameClientMessage(message);
  return decoded?.kind === "resync" ? "resync" : null;
}

export interface DeviceFrameSocketWriter {
  readonly write: (bytes: Uint8Array) => void;
  readonly sink: FrameSink;
}

/**
 * Wrap a raw write function as a transport sink, accounting for bytes handed
 * to the socket but not yet acknowledged as flushed. The transport reads that
 * number to decide whether the client is keeping up.
 */
export function makeDeviceFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
  readonly byteStream?: FrameByteStream | undefined;
}): DeviceFrameSink {
  return makeFrameSink(options);
}

/**
 * Mount `GET /ws/device-frames?udid=...`. Requests without a device, or on a
 * host with no device engine, are refused before the upgrade.
 */
export function makeDeviceFrameRouteLayer<R = never, E = never>(options: {
  /**
   * Same admission decision as the RPC upgrade. Passed in rather than imported
   * so this module does not depend on the auth stack, and so tests can mount
   * the route without one.
   */
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
  /** Owns authorization and cancellation for the complete upgraded stream. */
  readonly runAuthorizedConnection?: <E2, R2>(
    request: HttpServerRequest.HttpServerRequest,
    connection: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E | E2, R | R2>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        DEVICE_FRAME_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const deviceService = yield* Effect.serviceOption(DeviceService);
          if (deviceService._tag === "None" || !deviceService.value.supported) {
            return HttpServerResponse.text("Device streaming is unavailable", { status: 404 });
          }
          const url = HttpServerRequest.toURL(request);
          const udid = url?.searchParams.get(DEVICE_FRAME_WS_UDID_PARAM)?.trim();
          if (!udid) {
            return HttpServerResponse.text("Missing udid", { status: 400 });
          }
          if (!(yield* options.authorizeUpgrade(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }

          const connection = Effect.gen(function* () {
            // Read before the upgrade hands the socket to the WebSocket layer.
            const byteStream = frameSocketByteStream(request);
            const socket = yield* request.upgrade;
            const writer = yield* socket.writer;
            let open = true;
            const sink = makeDeviceFrameSink({
              send: (bytes) => Effect.runPromise(writer(bytes)).catch(() => undefined),
              isOpen: () => open,
              byteStream,
            });
            const unsubscribe = deviceService.value.manager.subscribeFrames(udid, sink);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                open = false;
                unsubscribe();
              }),
            );
            // Client messages on the uncompressed frame socket carry keyframe
            // resyncs and low-latency live touch events (`down` / `move` / `up`),
            // keeping both off the compressed JSON-RPC socket. Anything
            // unrecognized is ignored so a stray message never kills a stream.
            yield* socket.run((message) => {
              const decoded = decodeDeviceFrameClientMessage(message);
              if (decoded === null) return;
              if (decoded.kind === "resync") {
                Effect.runFork(
                  Effect.promise(() =>
                    deviceService.value.manager.requestKeyframe(udid).catch(() => undefined),
                  ),
                );
                return;
              }
              void deviceService.value.manager
                .touch(udid, { phase: decoded.phase, x: decoded.x, y: decoded.y })
                .catch(() => undefined);
            });
            return HttpServerResponse.empty();
          });
          return yield* options.runAuthorizedConnection
            ? options.runAuthorizedConnection(request, connection)
            : connection;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("device frame socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
