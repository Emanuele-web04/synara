// FILE: useWorkingIndicator.ts
// Purpose: Presentation state for the transcript working indicator: the
//          "Working for" origin latch and the delayed "Starting <provider>…" label.
// Layer: Web hook
// Exports: useLatchedActiveWorkStartedAt, useStartingProviderName, STARTING_PROVIDER_LABEL_DELAY_MS

import { ThreadId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { nextLatchedActiveWorkStart, type LatchedWorkStart } from "../ChatView.logic";

/**
 * Latches the first non-null work-start time for a continuous isWorking span so
 * the "Working for Xs" counter starts at dispatch and never jumps back to 0s
 * when the real turn's startedAt arrives. Resets when the thread goes idle or
 * changes. The ref is a render-time memo cache (same pattern as useStableValue):
 * a discarded render can only store an equal value, and keeping that pattern in
 * this hook leaves callers compiler-eligible.
 */
export function useLatchedActiveWorkStartedAt(input: {
  isWorking: boolean;
  threadId: ThreadId | null;
  candidate: string | null;
}): string | null {
  const latchRef = useRef<LatchedWorkStart>({ threadId: null, startedAt: null });
  latchRef.current = nextLatchedActiveWorkStart({
    previous: latchRef.current,
    isWorking: input.isWorking,
    threadId: input.threadId,
    candidate: input.candidate,
  });
  return latchRef.current.startedAt;
}

/** Cold session starts get a "Starting <provider>…" label only after this delay. */
export const STARTING_PROVIDER_LABEL_DELAY_MS = 1_200;

/**
 * Returns the provider name for the "Starting <provider>…" shimmer once the
 * session has been continuously connecting for the delay. Latched through the
 * connecting → ready gap so the label holds until the turn is running (or the
 * working span ends); it never flips to blank or another label in between.
 */
export function useStartingProviderName(input: {
  isWorking: boolean;
  isConnecting: boolean;
  isRunning: boolean;
  providerName: string;
  threadId?: ThreadId | null;
}): string | null {
  const [showStarting, setShowStarting] = useState(false);
  // Thread switches discard the delayed label like the sibling latch does —
  // a "Starting" armed on the previous thread must not leak into this one.
  const [latchedThreadId, setLatchedThreadId] = useState(input.threadId);
  if (latchedThreadId !== input.threadId) {
    setLatchedThreadId(input.threadId);
    setShowStarting(false);
  }
  const connecting = input.isWorking && input.isConnecting;
  const finished = !input.isWorking || input.isRunning;
  useEffect(() => {
    if (finished) {
      setShowStarting(false);
      return;
    }
    if (!connecting) {
      return;
    }
    const timeout = window.setTimeout(
      () => setShowStarting(true),
      STARTING_PROVIDER_LABEL_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
    // threadId re-arms the delay per thread: a timer armed on the previous
    // thread must not flip the label on after the switch.
  }, [connecting, finished, input.threadId]);
  return showStarting && !finished ? input.providerName : null;
}
