// FILE: useStableCallback.ts
// Purpose: Give an event handler one identity for the life of its component while it
//          always runs the latest closure.
// Layer: UI hooks
// Exports: useStableCallback

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * For handlers passed to children that should not re-render (or re-subscribe) just because
 * the handler closed over state that changes all the time, such as a streaming thread.
 *
 * Only for callbacks run from events (clicks, keys, timers). The latest closure is stored in
 * a layout effect, so a child that calls the result during render or from its own layout
 * effect in the same commit would still see the previous one.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
