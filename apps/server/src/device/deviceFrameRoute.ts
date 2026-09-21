/** video gets its own upgrade path: on one socket a video backlog sits ahead of RPC responses, and the RPC path negotiates per-message deflate which would burn CPU on already-compressed H.264; backpressure lives in the transport — this module only adapts an Effect Socket into the sink, tracking in-flight bytes because the socket exposes no bufferedAmount */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
} from "@synara/shared/deviceFrame";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { DeviceService } from "./Services/DeviceService.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";

/** a resync request is a few dozen bytes; anything larger is not one */
const MAX_CLIENT_MESSAGE_BYTES = 1_024;

/** returns the request kind or null for anything unrecognized — ignored rather than a protocol error */
export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
  if (text.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === DEVICE_FRAME_RESYNC_MESSAGE
      ? "resync"
      : null;
  } catch {
    return null;
  }
}

export interface DeviceFrameSocketWriter {
  readonly write: (bytes: Uint8Array) => void;
  readonly sink: DeviceFrameSink;
}

/** tracks bytes handed to the socket but not yet flushed — the transport reads it to decide whether the client is keeping up */
export function makeDeviceFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): DeviceFrameSink {
  let inFlightBytes = 0;
  return {
    send: (bytes) => {
      inFlightBytes += bytes.byteLength;
      const settle = () => {
        inFlightBytes = Math.max(0, inFlightBytes - bytes.byteLength);
      };
      const result = options.send(bytes);
      if (result instanceof Promise) result.then(settle, settle);
      else settle();
    },
    bufferedAmount: () => inFlightBytes,
    isOpen: options.isOpen,
  };
}

/** requests without a device, or on a host with no engine, are refused before the upgrade */
export function makeDeviceFrameRouteLayer<R = never>(options: {
  /** passed in rather than imported — this module doesn't depend on the auth stack and tests can mount the route without one */
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
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

          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          const sink = makeDeviceFrameSink({
            send: (bytes) => Effect.runPromise(writer(bytes)).catch(() => undefined),
            isOpen: () => open,
          });
          const unsubscribe = deviceService.value.manager.subscribeFrames(udid, sink);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              unsubscribe();
            }),
          );
          // the only client message is a resync request — a property of this stream, and a frozen canvas shouldn't depend on a second socket being healthy
          // anything unrecognized is ignored — a stray message must not kill a stream
          yield* socket.run((message) => {
            if (decodeResyncRequest(message) === null) return;
            Effect.runFork(
              Effect.promise(() =>
                deviceService.value.manager.requestKeyframe(udid).catch(() => undefined),
              ),
            );
          });
          return HttpServerResponse.empty();
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
