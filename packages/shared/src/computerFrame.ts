import { decodeFrameEnvelope, encodeFrameEnvelope, FrameEncodeError } from "./frameTransport";
import {
  COMPUTER_FRAME_MAGIC,
  COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
  COMPUTER_FRAME_VERSION,
  type ComputerFrameDecodeErrorReason,
  type ComputerFrameHeader,
  type ComputerFrameMimeType,
} from "@synara/contracts";

export const COMPUTER_FRAME_WS_PATH = "/ws/computer-frames";
export const COMPUTER_FRAME_WS_COMPUTER_ID_PARAM = "computerId";
export const COMPUTER_FRAME_RESYNC_MESSAGE = "computer.frame.resync";

export interface ComputerFrame {
  readonly header: ComputerFrameHeader;
  readonly payload: Uint8Array;
}

export type ComputerFrameDecodeResult =
  | { readonly ok: true; readonly frame: ComputerFrame }
  | { readonly ok: false; readonly reason: ComputerFrameDecodeErrorReason };

export class ComputerFrameEncodeError extends Error {}

/** What a frame that names no format is: every frame before JPEG previews existed. */
export const DEFAULT_COMPUTER_FRAME_MIME_TYPE: ComputerFrameMimeType = "image/png";

/**
 * Wire format codes, indexed by the envelope's format bits. Append only: a
 * code's meaning is fixed once any client can receive it.
 */
const COMPUTER_FRAME_FORMATS: readonly ComputerFrameMimeType[] = ["image/png", "image/jpeg"];

/** The image type a frame's payload holds, for the `Blob` the client decodes. */
export const computerFrameMimeType = (header: ComputerFrameHeader): ComputerFrameMimeType =>
  header.mimeType ?? DEFAULT_COMPUTER_FRAME_MIME_TYPE;

const COMPUTER_FRAME_CODEC = {
  magic: COMPUTER_FRAME_MAGIC,
  version: COMPUTER_FRAME_VERSION,
  streamIdLabel: "computerId",
  frameLabel: "Computer",
  maxStreamIdBytes: COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
} as const;

export const encodeComputerFrame = (frame: ComputerFrame): Uint8Array => {
  try {
    return encodeFrameEnvelope(COMPUTER_FRAME_CODEC, {
      header: {
        streamId: frame.header.computerId,
        sequence: frame.header.sequence,
        timestampMs: frame.header.timestampMs,
        keyframe: frame.header.keyframe,
        codecConfig: frame.header.codecConfig,
        format: COMPUTER_FRAME_FORMATS.indexOf(computerFrameMimeType(frame.header)),
      },
      payload: frame.payload,
    });
  } catch (error) {
    if (error instanceof FrameEncodeError) {
      throw new ComputerFrameEncodeError(error.message);
    }
    throw error;
  }
};

export const decodeComputerFrame = (bytes: Uint8Array): ComputerFrameDecodeResult => {
  const result = decodeFrameEnvelope(COMPUTER_FRAME_CODEC, bytes);
  if (!result.ok) {
    return { ok: false, reason: mapDecodeReason(result.reason) };
  }
  const mimeType = COMPUTER_FRAME_FORMATS[result.frame.header.format ?? 0];
  if (mimeType === undefined) return { ok: false, reason: "unsupported-format" };
  return {
    ok: true,
    frame: {
      header: {
        computerId: result.frame.header.streamId,
        sequence: result.frame.header.sequence,
        timestampMs: result.frame.header.timestampMs,
        keyframe: result.frame.header.keyframe,
        codecConfig: result.frame.header.codecConfig,
        mimeType,
      },
      payload: result.frame.payload,
    },
  };
};

function mapDecodeReason(
  reason:
    | "too-short"
    | "bad-magic"
    | "unsupported-version"
    | "truncated-stream-id"
    | "invalid-stream-id",
): ComputerFrameDecodeErrorReason {
  return reason === "truncated-stream-id"
    ? "truncated-computer-id"
    : reason === "invalid-stream-id"
      ? "invalid-computer-id"
      : reason;
}
