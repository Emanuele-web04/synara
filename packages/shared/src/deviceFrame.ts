import {
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  DEVICE_FRAME_VERSION,
  type DeviceFrameDecodeErrorReason,
  type DeviceFrameHeader,
} from "@synara/contracts";

import { makeFrameCodec } from "./frameCodec";

/** Encoded device frames use a dedicated, uncompressed WebSocket connection. */
export const DEVICE_FRAME_WS_PATH = "/ws/device-frames";
export const DEVICE_FRAME_WS_UDID_PARAM = "udid";
export const DEVICE_FRAME_RESYNC_MESSAGE = "device.frame.resync";

export interface DeviceFrame {
  readonly header: DeviceFrameHeader;
  readonly payload: Uint8Array;
}

export type DeviceFrameDecodeResult =
  | { readonly ok: true; readonly frame: DeviceFrame }
  | { readonly ok: false; readonly reason: DeviceFrameDecodeErrorReason };

export class DeviceFrameEncodeError extends Error {}

const codec = makeFrameCodec({
  magic: DEVICE_FRAME_MAGIC,
  version: DEVICE_FRAME_VERSION,
  streamIdKey: "deviceId",
  frameLabel: "Device",
  maxStreamIdBytes: DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  decodeReasons: {
    truncatedStreamId: "truncated-device-id",
    invalidStreamId: "invalid-device-id",
  },
  encodeError: DeviceFrameEncodeError,
});

/** Serializes a device frame through the shared envelope; the wire format is unchanged. */
export const encodeDeviceFrame = (frame: DeviceFrame): Uint8Array => codec.encode(frame);

/** Parses a binary device-frame message without copying its payload. */
export const decodeDeviceFrame = (bytes: Uint8Array): DeviceFrameDecodeResult =>
  codec.decode(bytes) as DeviceFrameDecodeResult;
