// FILE: useNowMs.ts
// Purpose: Shared lightweight wall-clock tick for live elapsed labels.
// Layer: Web hook
// Exports: useNowMs

import { useEffect, useState } from "react";

export function useNowMs(enabled: boolean, intervalMs = 1_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);

  return nowMs;
}
