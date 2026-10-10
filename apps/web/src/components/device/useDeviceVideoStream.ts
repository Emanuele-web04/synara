import type { DeviceUdid } from "@synara/contracts";
import type { DeviceFrame } from "@synara/shared/deviceFrame";
import { useEffect, useRef, useState } from "react";

import {
  createDeviceFrameGateState,
  stepDeviceFrameGate,
  type DeviceFrameGateState,
} from "../DevicePanel.logic";
import {
  createDeviceFrameSource,
  type DeviceFrameSource,
  type DeviceFrameSourceResetReason,
} from "~/lib/deviceFrameSource";

/**
 * Ceiling on the frame-socket reconnect backoff.
 *
 * Long enough that a server that stays down is not hammered, short enough that
 * a restart is picked up without the user reopening the pane.
 */
const FRAME_RECONNECT_MAX_DELAY_MS = 5_000;

export interface DeviceVideoDimensions {
  readonly width: number;
  readonly height: number;
}

export type DeviceVideoStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "error"; readonly message: string };

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

export function useDeviceVideoStream(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Null unsubscribes and tears the decoder down. */
  readonly udid: DeviceUdid | null;
  readonly enabled: boolean;
}): { readonly status: DeviceVideoStatus; readonly dimensions: DeviceVideoDimensions | null } {
  const { canvasRef, udid, enabled } = input;
  const [status, setStatus] = useState<DeviceVideoStatus>({ kind: "idle" });
  const [dimensions, setDimensions] = useState<DeviceVideoDimensions | null>(null);

  // generation guards every async callback: output or socket messages from a torn-down stream must not paint over the current one
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || udid === null) {
      setStatus({ kind: "idle" });
      setDimensions(null);
      return;
    }
    if (!isWebCodecsAvailable()) {
      setStatus({ kind: "unsupported" });
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;

    let gate: DeviceFrameGateState = createDeviceFrameGateState();
    let decoder: VideoDecoder | null = null;
    let source: DeviceFrameSource | null = null;
    let disposed = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const openFrameSource = () =>
      createDeviceFrameSource({
        udid,
        handlers: { onFrame: handleFrame, onReset: handleReset },
      });
    // the codec-config frame carries SPS/PPS with no slice data and can't decode as a key chunk — hold the parameter sets and prepend to the next keyframe
    let pendingParameterSets: Uint8Array | null = null;

    setStatus({ kind: "connecting" });

    const paint = (videoFrame: VideoFrame) => {
      try {
        const canvas = canvasRef.current;
        if (!canvas || !isCurrent()) return;
        const width = videoFrame.displayWidth;
        const height = videoFrame.displayHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          setDimensions({ width, height });
        }
        const context = canvas.getContext("2d");
        context?.drawImage(videoFrame, 0, 0);
        setStatus((previous) => (previous.kind === "streaming" ? previous : { kind: "streaming" }));
      } finally {
        // VideoFrame holds a GPU buffer; failing to close it stalls the decoder within a few frames
        videoFrame.close();
      }
    };

    const teardownDecoder = () => {
      // parameter sets belong to the decoder being torn down — carrying them over would prepend a stale SPS/PPS to the next decoder's first keyframe
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

    const failStream = (message: string) => {
      if (!isCurrent() || disposed) return;
      teardownDecoder();
      gate = createDeviceFrameGateState();
      setStatus({ kind: "error", message });
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
          if (!isCurrent() || disposed) {
            videoFrame.close();
            return;
          }
          paint(videoFrame);
        },
        error: (error) => {
          // a decoder error is recoverable: asking the server to rebuild the capture session yields fresh parameter sets + IDR rather than waiting out the encoder's next natural keyframe (~2s)
          failStream(error instanceof Error ? error.message : "The video decoder failed.");
          source?.requestResync();
        },
      });
      try {
        // no `description`: omitting it selects Annex-B matching what the helper writes out of VideoToolbox; supplying one would switch to length-prefixed AVCC and every frame would fail
        next.configure({ codec, optimizeForLatency: true });
      } catch (error) {
        failStream(
          error instanceof Error ? error.message : "The video decoder could not be configured.",
        );
        return;
      }
      decoder = next;
      // carried, not decoded: the next keyframe is sent with these bytes in front so the decoder sees SPS/PPS + IDR in one chunk
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
        source?.requestResync();
      }
    };

    const handleFrame = (frame: DeviceFrame) => {
      // any delivered frame proves the socket healthy — the next drop starts its backoff from the beginning
      reconnectAttempts = 0;
      if (!isCurrent() || disposed) return;
      const step = stepDeviceFrameGate(gate, frame.header, udid);
      gate = step.state;
      if (step.requestKeyframe) source?.requestResync();

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
    };

    const handleReset = (reason: DeviceFrameSourceResetReason) => {
      if (!isCurrent() || disposed) return;
      teardownDecoder();
      gate = createDeviceFrameGateState();
      if (reason === "closed") {
        setStatus({ kind: "connecting" });
        // a frame source is single-use: a socket that closes under a mounted pane leaves nothing to reconnect — open a fresh one, backing off so a down server doesn't become a reconnect loop
        reconnectAttempts += 1;
        const delay = Math.min(500 * 2 ** (reconnectAttempts - 1), FRAME_RECONNECT_MAX_DELAY_MS);
        reconnectTimer = setTimeout(() => {
          if (disposed || !isCurrent()) return;
          source?.close();
          source = openFrameSource();
        }, delay);
        return;
      }
      setStatus({
        kind: "error",
        message:
          reason === "decode-failed"
            ? "The simulator stream sent a frame Synara could not read."
            : "The simulator stream disconnected.",
      });
    };

    source = openFrameSource();

    return () => {
      disposed = true;
      generationRef.current += 1;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
      teardownDecoder();
    };
  }, [canvasRef, udid, enabled]);

  return { status, dimensions };
}
