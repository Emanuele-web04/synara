// FILE: useRafThrottledCallback.ts
// Purpose: Coalesce high-frequency event callbacks to one invocation per frame.
// Layer: Web hook

import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a stable callback that records the latest arguments and invokes the
 * wrapped callback at most once per animation frame. Native controls like
 * `<input type="color">` fire input events faster than the display refreshes
 * while dragging; running a React state update for every event makes the drag
 * feel laggy. Only the newest arguments are delivered — intermediate values
 * are dropped by design.
 */
export function useRafThrottledCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
): (...args: Args) => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const frameRef = useRef<number | null>(null);
  const pendingArgsRef = useRef<Args | null>(null);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingArgsRef.current = null;
    },
    [],
  );

  return useCallback((...args: Args) => {
    pendingArgsRef.current = args;
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const latestArgs = pendingArgsRef.current;
      pendingArgsRef.current = null;
      if (latestArgs) {
        callbackRef.current(...latestArgs);
      }
    });
  }, []);
}
