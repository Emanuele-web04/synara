// FILE: useBinaryFrameStreamLifecycle.ts
// Purpose: The lifecycle every binary frame stream shares — status, generation guard,
//          reconnect backoff, and teardown — with the decoding left to the caller.
// Layer: Web stream hook
// Exports: useBinaryFrameStreamLifecycle and its status/controls types
// Depends on: a frame source (`lib/binaryFrameSource` consumers)
//
// The Computer pane decodes PNG frames through `createImageBitmap` and the
// device pane decodes H.264 through WebCodecs, but everything around that was
// the same code twice: the same five status kinds, the same generation counter
// so a late async callback cannot paint over a newer stream, the same
// single-use frame source that has to be reopened on a server restart with the
// same 500 ms doubling backoff capped at five seconds, and the same teardown.
// Two copies of a reconnect policy is two policies as soon as one is touched.
//
// What stays with the caller is what actually differs: what a frame means, what
// "supported" means in this browser, and what to say when the stream fails.

import { useEffect, useRef, useState } from "react";

/**
 * Ceiling on the frame-socket reconnect backoff.
 *
 * Long enough that a server that stays down is not hammered, short enough that
 * a restart is picked up without the user reopening the pane.
 */
export const FRAME_RECONNECT_MAX_DELAY_MS = 5_000;

const FRAME_RECONNECT_BASE_DELAY_MS = 500;

/** The reset reason every frame source uses for "the socket just closed". */
const FRAME_SOURCE_CLOSED_REASON = "closed";

export type BinaryFrameStreamStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "error"; readonly message: string };

export interface BinaryFrameStreamDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Keeps the previous status object when nothing about it actually changed. A
 * decoded frame reports "streaming" at stream rate, and a fresh object every
 * time would re-render the whole pane once per frame for no visible difference.
 */
export function mergeBinaryFrameStreamStatus(
  previous: BinaryFrameStreamStatus,
  next: BinaryFrameStreamStatus,
): BinaryFrameStreamStatus {
  if (previous.kind !== next.kind) return next;
  if (previous.kind === "error" && next.kind === "error" && previous.message !== next.message) {
    return next;
  }
  return previous;
}

/** The part of a frame source this hook drives. */
export interface BinaryFrameStreamSource {
  readonly close: () => void;
  readonly requestResync: () => unknown;
}

/** What a decoder may do to the surrounding stream. */
export interface BinaryFrameStreamControls {
  /**
   * Whether this run is still the current one. Every async continuation has to
   * ask before it paints: a decode that started under the previous stream can
   * finish after the next one has already drawn a frame.
   */
  readonly isCurrent: () => boolean;
  readonly setStatus: (next: BinaryFrameStreamStatus) => void;
  readonly setDimensions: (next: BinaryFrameStreamDimensions) => void;
  /** Ask the server to rebuild the capture session and send a fresh keyframe. */
  readonly requestResync: () => void;
}

export interface BinaryFrameStreamDecoder<TFrame> {
  readonly onFrame: (frame: TFrame) => void;
  /**
   * Drops decoder state: called before a reconnect, on any reset, and on
   * teardown. Whatever a decoder carries between frames — a parameter set, a
   * sequence gate, a queued frame — belongs to the connection that delivered
   * it.
   */
  readonly reset: () => void;
}

export interface BinaryFrameStreamHandlers<TFrame, TReset extends string> {
  readonly onFrame: (frame: TFrame) => void;
  readonly onReset: (reason: TReset) => void;
}

export interface BinaryFrameStreamInput<TFrame, TReset extends string, TKey extends string> {
  readonly enabled: boolean;
  /**
   * What is being streamed. Null is off, and a change restarts the stream — so
   * it has to be the identity of the source, not a fresh object per render.
   * Handed back to `openSource` and `createDecoder` already narrowed, which is
   * how they get it without a cast.
   */
  readonly streamKey: TKey | null;
  /**
   * Close the socket while the tab is hidden. Worth it for a stream nobody can
   * see that costs the server real work to produce.
   */
  readonly pauseWhileHidden?: boolean;
  /** Whether this browser can decode this stream at all. */
  readonly isSupported: () => boolean;
  readonly openSource: (
    streamKey: TKey,
    handlers: BinaryFrameStreamHandlers<TFrame, TReset>,
  ) => BinaryFrameStreamSource;
  readonly createDecoder: (
    streamKey: TKey,
    controls: BinaryFrameStreamControls,
  ) => BinaryFrameStreamDecoder<TFrame>;
  /** What to say about a reset the hook does not reconnect from. */
  readonly resetMessage: (reason: TReset) => string;
  /** Ran when the stream stops for good — no key, disabled, or hidden. */
  readonly onIdle?: () => void;
}

export interface BinaryFrameStreamResult {
  readonly status: BinaryFrameStreamStatus;
  readonly dimensions: BinaryFrameStreamDimensions | null;
}

export function useBinaryFrameStreamLifecycle<TFrame, TReset extends string, TKey extends string>(
  input: BinaryFrameStreamInput<TFrame, TReset, TKey>,
): BinaryFrameStreamResult {
  const { enabled, streamKey, pauseWhileHidden = false } = input;
  const [status, setStatus] = useState<BinaryFrameStreamStatus>({ kind: "idle" });
  const [dimensions, setDimensions] = useState<BinaryFrameStreamDimensions | null>(null);
  // Guards every async callback: a decoder output or socket message from a
  // torn-down stream must not paint over the current one.
  const generationRef = useRef(0);
  // The callbacks are rebuilt every render by every caller. Reading them
  // through a ref keeps the stream from being torn down and reopened on an
  // unrelated re-render, which on a live pane happens several times a second.
  const latestRef = useRef(input);
  latestRef.current = input;

  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (!pauseWhileHidden) return;
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, [pauseWhileHidden]);

  useEffect(() => {
    if (!enabled || streamKey === null || (pauseWhileHidden && !pageVisible)) {
      setStatus({ kind: "idle" });
      setDimensions(null);
      latestRef.current.onIdle?.();
      return;
    }
    if (!latestRef.current.isSupported()) {
      setStatus({ kind: "unsupported" });
      return;
    }

    const generation = ++generationRef.current;
    let disposed = false;
    const isCurrent = () => !disposed && generationRef.current === generation;

    let source: BinaryFrameStreamSource | null = null;
    let decoder: BinaryFrameStreamDecoder<TFrame> | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const controls: BinaryFrameStreamControls = {
      isCurrent,
      setStatus: (next) => {
        if (!isCurrent()) return;
        setStatus((previous) => mergeBinaryFrameStreamStatus(previous, next));
      },
      setDimensions: (next) => {
        if (isCurrent()) setDimensions(next);
      },
      requestResync: () => {
        source?.requestResync();
      },
    };

    const openSource = () =>
      latestRef.current.openSource(streamKey, { onFrame: handleFrame, onReset: handleReset });

    function handleFrame(frame: TFrame): void {
      // Any delivered frame proves the socket is healthy, so the next drop
      // starts its backoff from the beginning rather than from a long delay.
      reconnectAttempts = 0;
      if (!isCurrent()) return;
      decoder?.onFrame(frame);
    }

    function handleReset(reason: TReset): void {
      if (!isCurrent()) return;
      decoder?.reset();
      if (reason === FRAME_SOURCE_CLOSED_REASON) {
        controls.setStatus({ kind: "connecting" });
        // A frame source is single-use, so a socket that closes under a still
        // mounted pane (a server restart, a network blip) leaves nothing to
        // reconnect it and the pane spins forever. Open a fresh one, backing
        // off so a server that is down does not become a reconnect loop.
        reconnectAttempts += 1;
        const delay = Math.min(
          FRAME_RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
          FRAME_RECONNECT_MAX_DELAY_MS,
        );
        reconnectTimer = setTimeout(() => {
          if (!isCurrent()) return;
          source?.close();
          source = openSource();
        }, delay);
        return;
      }
      controls.setStatus({ kind: "error", message: latestRef.current.resetMessage(reason) });
    }

    decoder = latestRef.current.createDecoder(streamKey, controls);
    setStatus({ kind: "connecting" });
    source = openSource();

    return () => {
      disposed = true;
      generationRef.current += 1;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
      decoder?.reset();
    };
  }, [enabled, pageVisible, pauseWhileHidden, streamKey]);

  return { status, dimensions };
}
