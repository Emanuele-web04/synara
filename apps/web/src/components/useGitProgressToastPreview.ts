// FILE: useGitProgressToastPreview.ts
// Purpose: Keep a looping git progress toast visible for local toast styling work.
// Layer: UI helpers
// Exports: useGitProgressToastPreview

import { useEffect, useRef } from "react";

import { toastManager } from "./ui/toast";

const PREVIEW_STAGES = [
  "Generating commit message...",
  "Committing...",
  "Pushing...",
] as const;

const STAGE_DURATION_MS = 4_000;
const TICK_MS = 1_000;

const PREVIEW_TOAST_DATA = {
  allowCrossThreadVisibility: true,
} as const;

type PreviewToastId = ReturnType<typeof toastManager.add>;

function formatElapsedDescription(startedAtMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

export function useGitProgressToastPreview(enabled: boolean): void {
  const toastIdRef = useRef<PreviewToastId | null>(null);
  const stageIndexRef = useRef(0);
  const phaseStartedAtMsRef = useRef<number | null>(null);
  const stageStartedAtMsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      stageIndexRef.current = 0;
      phaseStartedAtMsRef.current = null;
      stageStartedAtMsRef.current = null;
      return;
    }

    const now = Date.now();
    phaseStartedAtMsRef.current = now;
    stageStartedAtMsRef.current = now;
    stageIndexRef.current = 0;

    const initialTitle = PREVIEW_STAGES[0];
    toastIdRef.current = toastManager.add({
      type: "loading",
      title: initialTitle,
      description: formatElapsedDescription(now),
      timeout: 0,
      data: PREVIEW_TOAST_DATA,
    });

    const updateToast = () => {
      const toastId = toastIdRef.current;
      const phaseStartedAtMs = phaseStartedAtMsRef.current;
      if (!toastId || phaseStartedAtMs === null) {
        return;
      }

      toastManager.update(toastId, {
        type: "loading",
        title: PREVIEW_STAGES[stageIndexRef.current] ?? initialTitle,
        description: formatElapsedDescription(phaseStartedAtMs),
        timeout: 0,
        data: PREVIEW_TOAST_DATA,
      });
    };

    const tickIntervalId = window.setInterval(updateToast, TICK_MS);

    const stageIntervalId = window.setInterval(() => {
      const stageStartedAtMs = stageStartedAtMsRef.current;
      if (stageStartedAtMs === null) {
        return;
      }
      if (Date.now() - stageStartedAtMs < STAGE_DURATION_MS) {
        return;
      }

      stageIndexRef.current = (stageIndexRef.current + 1) % PREVIEW_STAGES.length;
      stageStartedAtMsRef.current = Date.now();
      updateToast();
    }, TICK_MS);

    return () => {
      window.clearInterval(tickIntervalId);
      window.clearInterval(stageIntervalId);
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      stageIndexRef.current = 0;
      phaseStartedAtMsRef.current = null;
      stageStartedAtMsRef.current = null;
    };
  }, [enabled]);
}
