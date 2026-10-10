// FILE: useOptimisticTabSelection.ts
// Purpose: Paint a clicked tab as selected at once and run the (expensive) switch after
//          that frame paints, for tab rows whose switch renders a whole surface.
// Layer: UI hooks
// Exports: useOptimisticTabSelection

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { scheduleAfterNextPaint } from "../components/chat/deferredChatMount";
import { useStableCallback } from "./useStableCallback";

/**
 * `shownKey` is the tab to draw as selected: the clicked one while its switch is pending,
 * otherwise `activeKey`. The override is scoped to the key it was clicked from, so any
 * committed change of `activeKey` cancels a queued switch and clears its override. A
 * switch that leaves `activeKey` where it was (a guarded navigation) hands the
 * highlight back once `activate` settles. A newer click during activation is handed
 * straight to the router so the earlier commit cannot discard its intent.
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
  const activationRef = useRef<Promise<unknown> | null>(null);

  const cancel = useCallback(() => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
    setPending(null);
  }, []);

  // A committed navigation supersedes the queued click, including navigation
  // away and back before its fallback fires. Stable deps preserve its own click render.
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
    const activation = activate(key);
    activationRef.current = activation;
    void activation.finally(() => {
      if (activationRef.current !== activation) return;
      activationRef.current = null;
      setPending((current) => (current?.from === from && current.to === key ? null : current));
    });
  });

  const select = (key: Key) => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
    // Give the router the latest click before an earlier navigation can commit
    // and cancel a newer after-paint callback. The router owns navigation cancellation.
    if (activationRef.current) {
      setPending({ from: activeKey, to: key });
      activatePending(activeKey, key);
      return;
    }
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
