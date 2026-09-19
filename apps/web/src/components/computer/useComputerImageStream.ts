// FILE: useComputerImageStream.ts
// Purpose: Decode the desktop's PNG frame stream into a canvas.
// Layer: Computer pane runtime hook
// Exports: useComputerImageStream and its status/dimension types
// Depends on: ComputerPanel.logic frame gate, computerFrameSource transport,
//             useBinaryFrameStreamLifecycle
//
// Everything the device pane's video stream also does — status, the generation
// guard, the reconnect backoff, teardown — lives in the shared lifecycle hook.
// What is here is the part that is actually about desktop frames: the sequence
// gate, one-frame backpressure, and the bitmap decode.

import type { ComputerId } from "@synara/contracts";
import type { ComputerFrame } from "@synara/shared/computerFrame";

import {
  useBinaryFrameStreamLifecycle,
  mergeBinaryFrameStreamStatus,
  type BinaryFrameStreamControls,
  type BinaryFrameStreamDecoder,
  type BinaryFrameStreamDimensions,
  type BinaryFrameStreamStatus,
} from "~/hooks/useBinaryFrameStreamLifecycle";
import {
  createComputerFrameGateState,
  stepComputerFrameGate,
  type ComputerFrameGateState,
} from "../ComputerPanel.logic";
import {
  createComputerFrameSource,
  type ComputerFrameSourceResetReason,
} from "~/lib/computerFrameSource";

export type ComputerImageDimensions = BinaryFrameStreamDimensions;
export type ComputerImageStreamStatus = BinaryFrameStreamStatus;
export const mergeComputerImageStreamStatus = mergeBinaryFrameStreamStatus;

function isImageBitmapAvailable(): boolean {
  return typeof Blob === "function" && typeof globalThis.createImageBitmap === "function";
}

function computerResetMessage(reason: ComputerFrameSourceResetReason): string {
  return reason === "decode-failed"
    ? "The computer stream sent a frame Synara could not read."
    : "The computer stream disconnected.";
}

/**
 * The desktop side of the stream: which frames are worth decoding, and the
 * decode itself.
 *
 * Only one decode runs at a time. `createImageBitmap` on a multi-megabyte
 * screenshot is slower than the stream can deliver, so frames that arrive
 * mid-decode collapse onto a single pending slot — the newest wins, because a
 * screenshot the desktop has already superseded is worth nothing.
 */
function createComputerFrameDecoder(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly computerId: ComputerId;
  readonly controls: BinaryFrameStreamControls;
}): BinaryFrameStreamDecoder<ComputerFrame> {
  const { canvasRef, computerId, controls } = input;
  let gate: ComputerFrameGateState = createComputerFrameGateState();
  let decoding = false;
  let pendingFrame: ComputerFrame | null = null;

  const decodeFrame = async (frame: ComputerFrame): Promise<void> => {
    if (!controls.isCurrent()) return;
    decoding = true;
    let bitmap: ImageBitmap | null = null;
    try {
      // The payload is a view over that message's own buffer, and the Blob
      // constructor copies the bytes it is given, so this is the only copy a
      // multi-megabyte frame needs. The cast narrows the decoder's
      // `ArrayBufferLike` to what `Blob` accepts: this buffer came from a
      // WebSocket message, which is never shared memory.
      const payload = frame.payload as Uint8Array<ArrayBuffer>;
      bitmap = await globalThis.createImageBitmap(new Blob([payload], { type: "image/png" }));
      if (!controls.isCurrent()) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        controls.setDimensions({ width: bitmap.width, height: bitmap.height });
      }
      context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
      controls.setStatus({ kind: "streaming" });
    } catch (error) {
      controls.setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The computer frame could not be decoded.",
      });
      controls.requestResync();
    } finally {
      bitmap?.close();
      decoding = false;
      if (pendingFrame !== null && controls.isCurrent()) {
        const next = pendingFrame;
        pendingFrame = null;
        void decodeFrame(next);
      }
    }
  };

  return {
    onFrame: (frame) => {
      const step = stepComputerFrameGate(gate, frame.header, computerId);
      gate = step.state;
      if (step.requestResync) controls.requestResync();
      if (step.action !== "decode") return;
      if (decoding) {
        pendingFrame = frame;
        return;
      }
      void decodeFrame(frame);
    },
    reset: () => {
      gate = createComputerFrameGateState();
      pendingFrame = null;
    },
  };
}

export function useComputerImageStream(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly computerId: ComputerId | null;
  readonly enabled: boolean;
}): {
  readonly status: ComputerImageStreamStatus;
  readonly dimensions: ComputerImageDimensions | null;
} {
  const { canvasRef, computerId, enabled } = input;
  return useBinaryFrameStreamLifecycle<ComputerFrame, ComputerFrameSourceResetReason, ComputerId>({
    enabled,
    streamKey: computerId,
    // A desktop nobody is looking at is a screenshot the server is taking and
    // encoding for nothing.
    pauseWhileHidden: true,
    isSupported: isImageBitmapAvailable,
    openSource: (id, handlers) => createComputerFrameSource({ computerId: id, handlers }),
    createDecoder: (id, controls) =>
      createComputerFrameDecoder({ canvasRef, computerId: id, controls }),
    resetMessage: computerResetMessage,
    onIdle: () => {
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    },
  });
}
