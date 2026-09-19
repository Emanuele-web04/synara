import {
  COMPUTER_FRAME_MAGIC,
  COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
  COMPUTER_FRAME_VERSION,
  type ComputerFrameDecodeErrorReason,
  type ComputerFrameHeader,
} from "@synara/contracts";

import { makeFrameCodec } from "./frameCodec";

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

const codec = makeFrameCodec({
  magic: COMPUTER_FRAME_MAGIC,
  version: COMPUTER_FRAME_VERSION,
  streamIdKey: "computerId",
  frameLabel: "Computer",
  maxStreamIdBytes: COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
  decodeReasons: {
    truncatedStreamId: "truncated-computer-id",
    invalidStreamId: "invalid-computer-id",
  },
  encodeError: ComputerFrameEncodeError,
});

export const encodeComputerFrame = (frame: ComputerFrame): Uint8Array => codec.encode(frame);

export const decodeComputerFrame = (bytes: Uint8Array): ComputerFrameDecodeResult =>
  codec.decode(bytes) as ComputerFrameDecodeResult;
