// FILE: useOptimisticTabSelection.ts
// Purpose: Paint a pressed tab as selected at once and run the (expensive) switch after
//          that frame paints, for tab rows whose switch renders a whole surface.
// Layer: UI hooks
// Exports: useOptimisticTabSelection

import { useEffect, useRef, useState } from "react";

import { scheduleAfterNextPaint } from "../components/chat/deferredChatMount";

/**
 * `shownKey` is the tab to draw as selected: the pressed one while its switch is pending,
 * otherwise `activeKey`. The override is scoped to the key it was pressed from, so any
 * change of `activeKey` (to the target or elsewhere) ends it without an effect; a switch
 * that leaves `activeKey` where it was (a guarded navigation) hands the highlight back
 * once `activate` settles.
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
  useEffect(() => () => cancelPendingRef.current?.(), []);

  const shownKey = pending?.from === activeKey && hasTab(pending.to) ? pending.to : activeKey;

  const cancel = () => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
    setPending(null);
  };

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
      void activate(key).finally(() => {
        setPending((current) => (current?.to === key ? null : current));
      });
    });
  };

  return { shownKey, select, cancel };
}
