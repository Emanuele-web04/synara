// Purpose: Defer the chat's secondary chrome (toolbars/banners) by one frame on
//   thread switches so the transcript paints first, then mark it ready.
// Layer: web / chat layout hook.
// Exports: useDeferredSecondaryChrome.
import { useEffect, useState } from "react";

import type { ThreadId } from "@t3tools/contracts";

export function useDeferredSecondaryChrome(options: {
  readonly secondaryChromeThreadId: ThreadId;
  readonly shouldDeferSecondaryChrome: boolean;
}): boolean {
  const { secondaryChromeThreadId, shouldDeferSecondaryChrome } = options;
  const [secondaryChromeState, setSecondaryChromeState] = useState(() => ({
    threadId: secondaryChromeThreadId,
    ready: true,
  }));

  useEffect(() => {
    if (!shouldDeferSecondaryChrome) {
      setSecondaryChromeState((current) =>
        current.threadId === secondaryChromeThreadId && current.ready
          ? current
          : { threadId: secondaryChromeThreadId, ready: true },
      );
      return;
    }

    setSecondaryChromeState({
      threadId: secondaryChromeThreadId,
      ready: false,
    });
    const frame = window.requestAnimationFrame(() => {
      setSecondaryChromeState({
        threadId: secondaryChromeThreadId,
        ready: true,
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [secondaryChromeThreadId, shouldDeferSecondaryChrome]);

  return (
    !shouldDeferSecondaryChrome ||
    (secondaryChromeState.threadId === secondaryChromeThreadId && secondaryChromeState.ready)
  );
}
