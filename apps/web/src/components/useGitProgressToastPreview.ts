// FILE: useGitProgressToastPreview.ts
// Purpose: Keep looping toast previews visible for local toast styling work.
// Layer: UI helpers
// Exports: useGitProgressToastPreview

import { useEffect, useRef } from "react";

import { toastManager } from "./ui/toast";

type ToastType = "loading" | "success" | "error" | "info" | "warning";

interface PreviewStage {
  type: ToastType;
  title: string;
  description?: string;
  copyText?: string;
  hasAction?: boolean;
}

const PREVIEW_STAGES: PreviewStage[] = [
  { type: "loading", title: "Generating commit message..." },
  { type: "loading", title: "Pushing..." },
  { type: "success", title: "Committed to codex/redesign" },
  { type: "success", title: "Pushed 3a1f2c to main" },
  {
    type: "success",
    title: "Chat completed",
    description: "Fix auth flow — updated 3 files",
    hasAction: true,
  },
  {
    type: "warning",
    title: "Awaiting input",
    description: "Refactor DB layer — needs confirmation",
    hasAction: true,
  },
  {
    type: "error",
    title: "Action failed",
    description: "fatal: unable to access upstream remote",
    copyText: "fatal: unable to access upstream remote",
  },
  { type: "info", title: "Already up to date", description: "main is already synchronized." },
  { type: "warning", title: "Branch is behind upstream" },
];

const STAGE_DURATION_MS = 3_000;

const PREVIEW_TOAST_DATA = {
  allowCrossThreadVisibility: true,
} as const;

type PreviewToastId = ReturnType<typeof toastManager.add>;

export function useGitProgressToastPreview(enabled: boolean): void {
  const toastIdRef = useRef<PreviewToastId | null>(null);
  const stageIndexRef = useRef(0);
  const stageStartedAtMsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      stageIndexRef.current = 0;
      stageStartedAtMsRef.current = null;
      return;
    }

    const applyStage = (stage: PreviewStage) => {
      const data = {
        ...PREVIEW_TOAST_DATA,
        ...(stage.copyText ? { copyText: stage.copyText } : {}),
      };
      const actionProps = stage.hasAction ? { children: "Open", onClick: () => {} } : undefined;

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, {
          type: stage.type,
          title: stage.title,
          description: stage.description,
          timeout: 0,
          data,
          actionProps,
        });
      } else {
        toastIdRef.current = toastManager.add({
          type: stage.type,
          title: stage.title,
          description: stage.description,
          timeout: 0,
          data,
          actionProps,
        });
      }
    };

    stageStartedAtMsRef.current = Date.now();
    stageIndexRef.current = 0;
    applyStage(PREVIEW_STAGES[0]!);

    const intervalId = window.setInterval(() => {
      const stageStartedAtMs = stageStartedAtMsRef.current;
      if (stageStartedAtMs === null) return;
      if (Date.now() - stageStartedAtMs < STAGE_DURATION_MS) return;

      stageIndexRef.current = (stageIndexRef.current + 1) % PREVIEW_STAGES.length;
      stageStartedAtMsRef.current = Date.now();

      const nextStage = PREVIEW_STAGES[stageIndexRef.current]!;
      const prevStage =
        PREVIEW_STAGES[
          (stageIndexRef.current - 1 + PREVIEW_STAGES.length) % PREVIEW_STAGES.length
        ]!;
      const layoutChanged =
        Boolean(nextStage.copyText) !== Boolean(prevStage.copyText) ||
        Boolean(nextStage.hasAction) !== Boolean(prevStage.hasAction);

      if (layoutChanged && toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }

      applyStage(nextStage);
    }, 500);

    return () => {
      window.clearInterval(intervalId);
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      stageIndexRef.current = 0;
      stageStartedAtMsRef.current = null;
    };
  }, [enabled]);
}
