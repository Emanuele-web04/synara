// FILE: useComputerPreviewTap.ts
// Purpose: Draws the desktop app's native frame tap into a canvas.
// Layer: Web computer surface hook
// Depends on: window.desktopBridge computerPreview channel (Electron only)
//
// The tap is the preferred frame source for the in-chat preview: the desktop
// host captures the driven window itself and pushes JPEGs over IPC, so frames
// never touch the computer WebSocket or the server. A plain browser has no
// channel; the hook stays inert there and the stills stream remains the only
// source. The caller picks one drawer at a time via `enabled` and `active`.

import type { ThreadId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { useComputerStateStore } from "../../computerStateStore";

/**
 * Silence longer than this ends tap ownership of the canvas: the popover
 * falls back to the stills stream until fresh tap frames arrive again.
 */
export const COMPUTER_PREVIEW_TAP_QUIET_MS = 1_000;

export interface ComputerPreviewTapFrameSize {
  readonly width: number;
  readonly height: number;
}

function isImageBitmapAvailable(): boolean {
  return typeof Blob === "function" && typeof globalThis.createImageBitmap === "function";
}

export function useComputerPreviewTap(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly threadId?: ThreadId | undefined;
  readonly enabled: boolean;
}): { readonly active: boolean; readonly frameSize: ComputerPreviewTapFrameSize | null } {
  const { canvasRef, enabled, threadId } = input;
  const [active, setActive] = useState(false);
  const [frameSize, setFrameSize] = useState<ComputerPreviewTapFrameSize | null>(null);
  const generationRef = useRef(0);
  // The tap is host-wide, so in a split with two live leaves both cards would
  // otherwise draw the same frame. Only the driving thread draws, using the
  // same arm-identity rule as the preview popover: the lease owner, or an
  // agent mid-call that was not refused for another owner's lease. No thread
  // state (or no thread) means a single surface, which keeps drawing.
  const isDrivingThread = useComputerStateStore((store) => {
    if (threadId === undefined) return true;
    const threadState = store.threadStatesByThreadId[threadId];
    if (!threadState) return true;
    // These frames carry no task id. Independent background tasks must use
    // their observation stills until the native tap can attribute each frame.
    if (threadState.sharedPreviewUnavailable) return false;
    return (
      threadState.controlOwnerThreadId === threadId ||
      (threadState.agentActive && !threadState.controlledByOtherThread)
    );
  });
  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const onFrame = window.desktopBridge?.computerPreview?.onFrame;
    if (
      !enabled ||
      !pageVisible ||
      !isDrivingThread ||
      typeof onFrame !== "function" ||
      !isImageBitmapAvailable()
    ) {
      setActive(false);
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    let disposed = false;
    let decoding = false;
    let lastSeq: number | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const noteDecoded = () => {
      setActive(true);
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (!isCurrent() || disposed) return;
        setActive(false);
      }, COMPUTER_PREVIEW_TAP_QUIET_MS);
    };

    const decodeFrame = async (jpeg: Uint8Array): Promise<void> => {
      if (!isCurrent() || disposed) return;
      decoding = true;
      let bitmap: ImageBitmap | null = null;
      try {
        // IPC bytes are never shared memory, so the same Blob part narrowing
        // the stills decoder uses applies here.
        const payload = jpeg as Uint8Array<ArrayBuffer>;
        bitmap = await globalThis.createImageBitmap(new Blob([payload], { type: "image/jpeg" }));
        if (!isCurrent() || disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        // The canvas element carries object-contain, so drawing at native size
        // leaves letterboxing to CSS exactly like the stills stream.
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
        // Live dimensions for the card's aspect: kept through the quiet window
        // below, since the canvas keeps showing the stale frame by design.
        // Identity is preserved when nothing changed so a frame does not
        // re-render the card for no visible difference.
        const { width, height } = bitmap;
        setFrameSize((previous) =>
          previous?.width === width && previous.height === height ? previous : { width, height },
        );
        noteDecoded();
      } catch {
        // A corrupt JPEG drops like a stale frame; the next seq still draws.
      } finally {
        bitmap?.close();
        decoding = false;
      }
    };

    const unsubscribe = onFrame((frame) => {
      if (!isCurrent() || disposed) return;
      if (typeof frame.seq !== "number" || !Number.isFinite(frame.seq)) return;
      // seq is monotonic per host process: a stale or repeated frame is never
      // worth a decode, and while one decode runs the next frame drops rather
      // than queues so the preview can never fall behind the live desktop.
      if (lastSeq !== null && frame.seq <= lastSeq) return;
      lastSeq = frame.seq;
      if (decoding) return;
      void decodeFrame(frame.jpeg);
    });

    return () => {
      disposed = true;
      generationRef.current += 1;
      if (quietTimer !== null) clearTimeout(quietTimer);
      unsubscribe();
      // The canvas keeps its last decoded frame: a stills frame or the next
      // tap frame paints over it, so wiping here would flash a blank viewport
      // in between. The size still resets — the frame-source pick reads
      // `frameSize !== null` as "the tap has a frame worth holding", and on
      // teardown it does not.
      setFrameSize(null);
    };
    // The tap stream is host-wide rather than per thread; threadId keys the
    // subscription so a card remounted for another thread restarts sequence
    // tracking instead of inheriting stale seq state. isDrivingThread re-keys
    // it the same way when ownership moves between split leaves.
  }, [canvasRef, enabled, pageVisible, threadId, isDrivingThread]);

  return { active, frameSize };
}
