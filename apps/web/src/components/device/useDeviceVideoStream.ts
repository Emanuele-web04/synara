// FILE: useDeviceVideoStream.ts
// Purpose: Drive a WebCodecs H.264 decoder from the device frame socket into a canvas.
// Layer: Device pane runtime hook
// Exports: useDeviceVideoStream
// Depends on: DevicePanel.logic frame gate, deviceFrameSource transport,
//             useBinaryFrameStreamLifecycle
//
// Everything the Computer pane's image stream also does — status, the
// generation guard, the reconnect backoff, teardown — lives in the shared
// lifecycle hook. What is here is the part that is actually about H.264: the
// codec string, the parameter sets, and the decoder itself.

import type { DeviceUdid } from "@synara/contracts";
import type { DeviceFrame } from "@synara/shared/deviceFrame";

import {
  useBinaryFrameStreamLifecycle,
  type BinaryFrameStreamControls,
  type BinaryFrameStreamDecoder,
  type BinaryFrameStreamDimensions,
  type BinaryFrameStreamStatus,
} from "~/hooks/useBinaryFrameStreamLifecycle";
import {
  createDeviceFrameGateState,
  stepDeviceFrameGate,
  type DeviceFrameGateState,
} from "../DevicePanel.logic";
import {
  createDeviceFrameSource,
  type DeviceFrameSourceResetReason,
} from "~/lib/deviceFrameSource";

export type DeviceVideoDimensions = BinaryFrameStreamDimensions;
export type DeviceVideoStatus = BinaryFrameStreamStatus;

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * The avc1 codec string is derived from the SPS the server sends in its
 * codec-config frame: profile_idc / constraint flags / level_idc are bytes 1-3
 * of the parameter set. Hardcoding a codec string would break the moment the
 * helper picks a different profile for a larger screen.
 */
function avcCodecStringFromConfig(payload: Uint8Array): string | null {
  // Skip a 4- or 3-byte Annex-B start code to reach the NAL header.
  for (let offset = 0; offset + 4 < payload.byteLength; offset += 1) {
    const isLongStart =
      payload[offset] === 0 &&
      payload[offset + 1] === 0 &&
      payload[offset + 2] === 0 &&
      payload[offset + 3] === 1;
    const isShortStart =
      payload[offset] === 0 && payload[offset + 1] === 0 && payload[offset + 2] === 1;
    if (!isLongStart && !isShortStart) continue;

    const nalOffset = offset + (isLongStart ? 4 : 3);
    const nalHeader = payload[nalOffset];
    if (nalHeader === undefined) continue;
    // NAL unit type 7 is the sequence parameter set.
    if ((nalHeader & 0x1f) !== 7) continue;

    const profile = payload[nalOffset + 1];
    const constraints = payload[nalOffset + 2];
    const level = payload[nalOffset + 3];
    if (profile === undefined || constraints === undefined || level === undefined) return null;
    return `avc1.${hexByte(profile)}${hexByte(constraints)}${hexByte(level)}`;
  }
  return null;
}

function isWebCodecsAvailable(): boolean {
  return (
    typeof globalThis.VideoDecoder === "function" &&
    typeof globalThis.EncodedVideoChunk === "function"
  );
}

function deviceResetMessage(reason: DeviceFrameSourceResetReason): string {
  return reason === "decode-failed"
    ? "The simulator stream sent a frame Synara could not read."
    : "The simulator stream disconnected.";
}

/** The H.264 side of the stream: the decoder, its parameter sets, and the paint. */
function createDeviceVideoDecoder(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly udid: DeviceUdid;
  readonly controls: BinaryFrameStreamControls;
}): BinaryFrameStreamDecoder<DeviceFrame> {
  const { canvasRef, udid, controls } = input;
  let gate: DeviceFrameGateState = createDeviceFrameGateState();
  let decoder: VideoDecoder | null = null;
  // The codec-config frame carries SPS/PPS only, with no slice data, so it
  // cannot itself be decoded as a key chunk — WebCodecs rejects it with "a key
  // frame is required after configure()". Hold the parameter sets and prepend
  // them to the next keyframe, which is how in-band Annex-B parameter sets are
  // meant to reach the decoder.
  let pendingParameterSets: Uint8Array | null = null;

  const paint = (videoFrame: VideoFrame) => {
    try {
      const canvas = canvasRef.current;
      if (!canvas || !controls.isCurrent()) return;
      const width = videoFrame.displayWidth;
      const height = videoFrame.displayHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        controls.setDimensions({ width, height });
      }
      const context = canvas.getContext("2d");
      context?.drawImage(videoFrame, 0, 0);
      controls.setStatus({ kind: "streaming" });
    } finally {
      // VideoFrame holds a GPU buffer; failing to close it stalls the decoder
      // within a few frames.
      videoFrame.close();
    }
  };

  const teardownDecoder = () => {
    // Parameter sets belong to the decoder being torn down; carrying them into
    // the next one would prepend a stale SPS/PPS to its first keyframe.
    pendingParameterSets = null;
    if (!decoder) return;
    const current = decoder;
    decoder = null;
    try {
      if (current.state !== "closed") current.close();
    } catch {
      // Closing an already-errored decoder throws; nothing left to release.
    }
  };

  const reset = () => {
    teardownDecoder();
    gate = createDeviceFrameGateState();
  };

  const failStream = (message: string) => {
    if (!controls.isCurrent()) return;
    reset();
    controls.setStatus({ kind: "error", message });
  };

  const configureDecoder = (frame: DeviceFrame) => {
    const codec = avcCodecStringFromConfig(frame.payload);
    if (!codec) {
      failStream("The simulator stream sent parameters Synara could not read.");
      return;
    }
    teardownDecoder();
    const next = new VideoDecoder({
      output: (videoFrame) => {
        if (!controls.isCurrent()) {
          videoFrame.close();
          return;
        }
        paint(videoFrame);
      },
      error: (error) => {
        // A decoder error is recoverable: asking the server to rebuild the
        // capture session yields fresh parameter sets and an IDR, which
        // reconfigures this decoder rather than waiting out the encoder's
        // next natural keyframe (up to two seconds away).
        failStream(error instanceof Error ? error.message : "The video decoder failed.");
        controls.requestResync();
      },
    });
    try {
      // No `description`: omitting it selects Annex-B, matching what the
      // helper writes out of VideoToolbox. Supplying one would switch the
      // decoder to length-prefixed AVCC samples and every frame would fail.
      next.configure({ codec, optimizeForLatency: true });
    } catch (error) {
      failStream(
        error instanceof Error ? error.message : "The video decoder could not be configured.",
      );
      return;
    }
    decoder = next;
    // Carried, not decoded: the next keyframe is sent with these bytes in
    // front of it so the decoder sees SPS/PPS and an IDR in one chunk.
    pendingParameterSets = frame.payload.slice();
  };

  const submit = (frame: DeviceFrame, keyframe: boolean) => {
    if (!decoder || decoder.state !== "configured") return;
    let data = frame.payload;
    if (keyframe && pendingParameterSets) {
      const combined = new Uint8Array(pendingParameterSets.byteLength + data.byteLength);
      combined.set(pendingParameterSets, 0);
      combined.set(data, pendingParameterSets.byteLength);
      data = combined;
      pendingParameterSets = null;
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: Math.round(frame.header.timestampMs * 1000),
          data,
        }),
      );
    } catch (error) {
      failStream(error instanceof Error ? error.message : "A video frame could not be decoded.");
      controls.requestResync();
    }
  };

  return {
    onFrame: (frame) => {
      const step = stepDeviceFrameGate(gate, frame.header, udid);
      gate = step.state;
      if (step.requestKeyframe) controls.requestResync();

      switch (step.action.kind) {
        case "configure":
          configureDecoder(frame);
          return;
        case "decode":
          submit(frame, step.action.keyframe);
          return;
        default:
          return;
      }
    },
    reset,
  };
}

export function useDeviceVideoStream(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Null unsubscribes and tears the decoder down. */
  readonly udid: DeviceUdid | null;
  readonly enabled: boolean;
}): { readonly status: DeviceVideoStatus; readonly dimensions: DeviceVideoDimensions | null } {
  const { canvasRef, udid, enabled } = input;
  return useBinaryFrameStreamLifecycle<DeviceFrame, DeviceFrameSourceResetReason, DeviceUdid>({
    enabled,
    streamKey: udid,
    isSupported: isWebCodecsAvailable,
    openSource: (device, handlers) => createDeviceFrameSource({ udid: device, handlers }),
    createDecoder: (device, controls) =>
      createDeviceVideoDecoder({ canvasRef, udid: device, controls }),
    resetMessage: deviceResetMessage,
  });
}
