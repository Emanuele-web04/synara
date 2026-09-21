import { useEffect, useState } from "react";
import { startVisibleInterval } from "../lib/visibleInterval";

export function useNowMs(enabled: boolean, intervalMs = 1_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return startVisibleInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
  }, [enabled, intervalMs]);

  return nowMs;
}
