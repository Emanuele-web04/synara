// FILE: deviceFrameSource.ts
// Purpose: Deliver encoded device video frames from the server to a pane's decoder.
// Layer: Web transport helper
// Exports: DeviceFrameSource contract and the pane-facing factory, both thin
// wrappers over the shared binaryFrameSource mechanism.
// Depends on: @synara/shared/deviceFrame for the binary envelope

import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_TOUCH_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
  type DeviceFrame,
  type DeviceFrameTouchPhase,
} from "@synara/shared/deviceFrame";
import { DeviceFrameServerMessage, type DeviceUdid } from "@synara/contracts";
import { Schema } from "effect";

import {
  binaryFrameSocketUrl,
  createBinaryFrameSource,
  type FrameSourceResetReason,
  type WebSocketLike,
} from "./binaryFrameSource";

export interface DeviceFrameSourceHandlers {
  readonly onFrame: (frame: DeviceFrame) => void;
  readonly onReset: (reason: DeviceFrameSourceResetReason) => void;
  readonly onControl?: (message: DeviceFrameServerMessage) => void;
}

export type DeviceFrameSourceResetReason = FrameSourceResetReason;

/**
 * Debounce window for keyframe resync requests. With in-place `stream.keyframe`
 * IDR generation on the helper, recovery takes milliseconds, while a short
 * cooldown still prevents bursts of dropped frames from flooding the server.
 */
export const DEVICE_FRAME_RESYNC_COOLDOWN_MS = 300;

export interface DeviceFrameSource {
  readonly requestResync: () => boolean;
  /** Send a live touch event over the uncompressed frame socket when open. */
  readonly sendTouch: (phase: DeviceFrameTouchPhase, x: number, y: number) => boolean;
  readonly close: () => void;
}

export interface DeviceFrameSourceOptions {
  readonly udid: DeviceUdid;
  readonly handlers: DeviceFrameSourceHandlers;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly explicitUrl?: string | null;
  readonly now?: () => number;
  readonly resyncCooldownMs?: number;
}

export type { WebSocketLike };

export function deviceFrameSocketUrl(input: {
  readonly udid: DeviceUdid;
  readonly explicitUrl?: string | null;
}): string {
  return binaryFrameSocketUrl({
    streamId: input.udid,
    streamIdParam: DEVICE_FRAME_WS_UDID_PARAM,
    wsPath: DEVICE_FRAME_WS_PATH,
    ...(input.explicitUrl !== undefined ? { explicitUrl: input.explicitUrl } : {}),
  });
}

const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceFrameServerMessage));

export function createDeviceFrameSource(options: DeviceFrameSourceOptions): DeviceFrameSource {
  let active: { readonly x: number; readonly y: number } | null = null;
  const base = createBinaryFrameSource({
    streamId: options.udid,
    streamIdParam: DEVICE_FRAME_WS_UDID_PARAM,
    wsPath: DEVICE_FRAME_WS_PATH,
    resyncMessage: DEVICE_FRAME_RESYNC_MESSAGE,
    handlers: {
      onFrame: options.handlers.onFrame,
      onReset: (reason) => {
        if (reason === "closed") active = null;
        options.handlers.onReset(reason);
      },
      onText: (text) => {
        const decoded = decodeControl(text);
        if (decoded._tag === "Some") options.handlers.onControl?.(decoded.value);
      },
    },
    decode: decodeDeviceFrame,
    ...(options.createSocket !== undefined ? { createSocket: options.createSocket } : {}),
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    resyncCooldownMs: options.resyncCooldownMs ?? DEVICE_FRAME_RESYNC_COOLDOWN_MS,
  });
  const sendTouch: DeviceFrameSource["sendTouch"] = (phase, x, y) => {
    // A pointer held across reconnect belongs to the old socket.
    if (phase !== "down" && active === null) return false;
    if (!base.sendJson({ type: DEVICE_FRAME_TOUCH_MESSAGE, phase, x, y })) return false;
    active = phase === "up" ? null : { x, y };
    return true;
  };
  return {
    requestResync: base.requestResync,
    sendTouch,
    close: () => {
      // Effect cleanup closes the source before the pane can handle pointer-up.
      if (active !== null) sendTouch("up", active.x, active.y);
      base.close();
    },
  };
}
