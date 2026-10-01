// FILE: useOptimisticTabSelection.ts
// Purpose: Paint a pressed tab as selected at once and run the (expensive) switch after
//          that frame paints, for tab rows whose switch renders a whole surface.
// Layer: UI hooks
// Exports: useOptimisticTabSelection

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { scheduleAfterNextPaint } from "../components/chat/deferredChatMount";
import { useStableCallback } from "./useStableCallback";

/**
 * `shownKey` is the tab to draw as selected: the pressed one while its switch is pending,
 * otherwise `activeKey`. The override is scoped to the key it was pressed from, so any
 * committed change of `activeKey` cancels a queued switch and clears its override. A
 * switch that leaves `activeKey` where it was (a guarded navigation) hands the
 * highlight back once `activate` settles.
 */
export function useOptimisticTabSelection<Key extends string>(input: {
  activeKey: Key;
  // Whether a key still has a tab to highlight (it may close while its switch is pending).
  hasTab: (key: Key) => boolean;
  activate: (key: Key) => Promise<unknown>;
}): { shownKey: Key; select: (key: Key) => void; cancel: () => void } {
  const { activeKey, hasTab, activate } = input;
  const [pending, setPending] = useState<{ from: Key; to: Key } | null>(null);
  const cancelPendingRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
    setPending(null);
  }, []);

  // A committed navigation supersedes the queued press, including navigation
  // away and back before its fallback fires. Stable deps preserve its own press render.
  useLayoutEffect(() => {
    if (cancelPendingRef.current) cancel();
    return () => cancelPendingRef.current?.();
  }, [activeKey, cancel]);

  const shownKey = pending?.from === activeKey && hasTab(pending.to) ? pending.to : activeKey;

  const activatePending = useStableCallback((from: Key, key: Key) => {
    if (activeKey !== from || !hasTab(key)) {
      cancel();
      return;
    }
    void activate(key).finally(() => {
      setPending((current) => (current?.from === from && current.to === key ? null : current));
    });
  });

  const select = (key: Key) => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
    if (key === activeKey) {
      setPending(null);
      return;
    }
    setPending({ from: activeKey, to: key });
    cancelPendingRef.current = scheduleAfterNextPaint(window, () => {
      cancelPendingRef.current = null;
      activatePending(activeKey, key);
    });
  };

  return { shownKey, select, cancel };
}
