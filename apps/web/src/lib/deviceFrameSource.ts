import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
  type DeviceFrame,
} from "@synara/shared/deviceFrame";
import type { DeviceUdid } from "@synara/contracts";

import { makeSocketUrl } from "../wsTransport";

export interface DeviceFrameSourceHandlers {
  readonly onFrame: (frame: DeviceFrame) => void;
  /**
   * The socket dropped. The pane resets its decoder because the next connection
   * starts a new stream generation with its own parameter sets.
   */
  readonly onReset: (reason: DeviceFrameSourceResetReason) => void;
}

export type DeviceFrameSourceResetReason = "closed" | "error" | "decode-failed";

// resync rebuilds the VideoToolbox encoder — one request in flight; further requests inside the window are dropped not queued since the in-flight resync delivers the parameter sets+IDR
export const DEVICE_FRAME_RESYNC_COOLDOWN_MS = 1_000;

export interface DeviceFrameSource {
  readonly requestResync: () => boolean;
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

export interface WebSocketLike {
  binaryType: string;
  readonly readyState?: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error" | "open",
    listener: (event: never) => void,
  ) => void;
}

// frames are lossy, high-rate, useless when late — the opposite of the RPC socket; a dedicated binary WebSocket so a burst never delays RPC/events and a slow consumer drops video instead of stalling the control plane. Subscription is the URL (no handshake); keyed on device so two threads watching one simulator share the encoder output
export function deviceFrameSocketUrl(input: {
  readonly udid: DeviceUdid;
  readonly explicitUrl?: string | null;
}): string {
  const url = new URL(makeSocketUrl(input.explicitUrl ?? null, DEVICE_FRAME_WS_PATH));
  url.searchParams.set(DEVICE_FRAME_WS_UDID_PARAM, input.udid);
  return url.toString();
}

/**
 * Normalizes a binary WebSocket payload to bytes. Blob delivery is async and
 * would reorder frames against ArrayBuffer delivery, so the socket is pinned to
 * `arraybuffer` and a Blob here means a misconfigured socket rather than a
 * frame worth rescuing.
 */
function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function createDeviceFrameSource(options: DeviceFrameSourceOptions): DeviceFrameSource {
  const url = deviceFrameSocketUrl({
    udid: options.udid,
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
  });
  const socket = (options.createSocket ?? defaultCreateSocket)(url);
  socket.binaryType = "arraybuffer";

  const now = options.now ?? (() => Date.now());
  const cooldownMs = options.resyncCooldownMs ?? DEVICE_FRAME_RESYNC_COOLDOWN_MS;
  let closed = false;
  let open = false;
  let lastResyncAt: number | null = null;
  // a gap can be detected before the socket opens (first frames of a fresh connection) — remember the intent and send on open or the canvas waits for the next natural IDR
  let resyncPending = false;

  const reset = (reason: DeviceFrameSourceResetReason) => {
    if (closed) return;
    options.handlers.onReset(reason);
  };

  const sendResync = (): boolean => {
    if (closed) return false;
    try {
      socket.send(JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE }));
      return true;
    } catch {
      // A socket that dropped between the readyState check and the send; the close handler already resets the decoder.
      return false;
    }
  };

  socket.addEventListener("open", (() => {
    open = true;
    if (!resyncPending) return;
    resyncPending = false;
    sendResync();
  }) as (event: never) => void);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    if (closed) return;
    const bytes = frameBytes(event.data);
    // Text on this socket is a protocol violation, not a frame; ignoring it keeps a stray server log line from tearing down a healthy stream.
    if (!bytes) return;

    const result = decodeDeviceFrame(bytes);
    if (!result.ok) {
      // a malformed envelope means the sides disagree on the wire format — resetting the decoder is the only safe response; payload after a bad header can't be trusted
      reset("decode-failed");
      return;
    }
    options.handlers.onFrame(result.frame);
  }) as (event: never) => void);

  socket.addEventListener("close", (() => reset("closed")) as (event: never) => void);
  socket.addEventListener("error", (() => reset("error")) as (event: never) => void);

  return {
    requestResync: () => {
      if (closed) return false;
      const at = now();
      if (lastResyncAt !== null && at - lastResyncAt < cooldownMs) {
        return false;
      }
      lastResyncAt = at;
      if (!open) {
        resyncPending = true;
        return false;
      }
      return sendResync();
    },
    close: () => {
      if (closed) return;
      closed = true;
      resyncPending = false;
      try {
        socket.close();
      } catch {
        // A socket that never opened throws on close in some browsers; the listener guard above already makes further callbacks inert.
      }
    },
  };
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
