/**
 * Binary frame envelope codec: a fixed header plus an opaque payload.
 *
 * Isomorphic on purpose. The browser decodes the same envelope the server
 * encodes, so this module stays free of Node built-ins; the fan-out, sink and
 * resync machinery that needs `Buffer` lives in `./frameTransport`.
 */
export const FRAME_HEADER_FIXED_BYTES = 17;
export const FRAME_MAX_STREAM_ID_BYTES = 255;
export const FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;

export type FrameDecodeErrorReason =
  | "too-short"
  | "bad-magic"
  | "unsupported-version"
  | "truncated-stream-id"
  | "invalid-stream-id";

export interface FrameHeader {
  readonly streamId: string;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

export interface FrameEnvelope {
  readonly header: FrameHeader;
  readonly payload: Uint8Array;
}

export interface FrameCodecConfig {
  readonly magic: number;
  readonly version: number;
  readonly streamIdLabel: string;
  readonly frameLabel: string;
  readonly maxStreamIdBytes?: number;
}

export type FrameDecodeResult =
  | { readonly ok: true; readonly frame: FrameEnvelope }
  | { readonly ok: false; readonly reason: FrameDecodeErrorReason };

export class FrameEncodeError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const encodeFrameEnvelope = (config: FrameCodecConfig, frame: FrameEnvelope): Uint8Array => {
  const maxStreamIdBytes = config.maxStreamIdBytes ?? FRAME_MAX_STREAM_ID_BYTES;
  const streamIdBytes = textEncoder.encode(frame.header.streamId);
  if (streamIdBytes.byteLength === 0) {
    throw new FrameEncodeError(
      `${config.frameLabel} frame header requires a non-empty ${config.streamIdLabel}`,
    );
  }
  if (streamIdBytes.byteLength > maxStreamIdBytes) {
    throw new FrameEncodeError(
      `${config.frameLabel} frame ${config.streamIdLabel} exceeds ${maxStreamIdBytes} UTF-8 bytes`,
    );
  }

  const buffer = new ArrayBuffer(
    FRAME_HEADER_FIXED_BYTES + streamIdBytes.byteLength + frame.payload.byteLength,
  );
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let flags = 0;
  if (frame.header.keyframe) flags |= FRAME_FLAG_KEYFRAME;
  if (frame.header.codecConfig) flags |= FRAME_FLAG_CODEC_CONFIG;

  view.setUint16(0, config.magic, true);
  view.setUint8(2, config.version);
  view.setUint8(3, flags);
  view.setUint32(4, frame.header.sequence >>> 0, true);
  view.setFloat64(8, frame.header.timestampMs, true);
  view.setUint8(16, streamIdBytes.byteLength);
  bytes.set(streamIdBytes, FRAME_HEADER_FIXED_BYTES);
  bytes.set(frame.payload, FRAME_HEADER_FIXED_BYTES + streamIdBytes.byteLength);

  return bytes;
};

export const decodeFrameEnvelope = (
  config: FrameCodecConfig,
  bytes: Uint8Array,
): FrameDecodeResult => {
  if (bytes.byteLength < FRAME_HEADER_FIXED_BYTES) {
    return { ok: false, reason: "too-short" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== config.magic) {
    return { ok: false, reason: "bad-magic" };
  }
  if (view.getUint8(2) !== config.version) {
    return { ok: false, reason: "unsupported-version" };
  }

  const flags = view.getUint8(3);
  const streamIdLength = view.getUint8(16);
  const payloadOffset = FRAME_HEADER_FIXED_BYTES + streamIdLength;
  if (streamIdLength === 0 || bytes.byteLength < payloadOffset) {
    return { ok: false, reason: "truncated-stream-id" };
  }

  let streamId: string;
  try {
    streamId = textDecoder.decode(bytes.subarray(FRAME_HEADER_FIXED_BYTES, payloadOffset));
  } catch {
    return { ok: false, reason: "invalid-stream-id" };
  }

  return {
    ok: true,
    frame: {
      header: {
        streamId,
        sequence: view.getUint32(4, true),
        timestampMs: view.getFloat64(8, true),
        keyframe: (flags & FRAME_FLAG_KEYFRAME) !== 0,
        codecConfig: (flags & FRAME_FLAG_CODEC_CONFIG) !== 0,
      },
      payload: bytes.subarray(payloadOffset),
    },
  };
};
