// FILE: useCodeSelectionAction.ts
// Purpose: Generic highlight -> floating "Add to chat" flow for read-only code
//          surfaces (file preview, diff view), mirroring the transcript behavior.
// Layer: Chat selection interaction controller

import { useCallback, useEffect, useState, type MouseEventHandler } from "react";

import {
  getActiveSelectionRect,
  resolveTranscriptSelectionActionLayout,
} from "./chatSelectionActions";

export interface PendingCodeSelectionAction<T> {
  payload: T;
  left: number;
  top: number;
  placement: "top" | "bottom";
}

// Caller attaches `onContainerMouseUp` to the selectable surface and renders
// `TranscriptSelectionAction` while `pendingAction` is set. `readSelection`
// inspects the live window selection scoped to the container and returns the
// commit payload (or null when the selection is not actionable).
export function useCodeSelectionAction<T>(options: {
  enabled: boolean;
  readSelection: (container: HTMLElement) => T | null;
  onCommit: (payload: T) => void;
}): {
  pendingAction: PendingCodeSelectionAction<T> | null;
  onContainerMouseUp: MouseEventHandler<HTMLElement>;
  commit: () => void;
} {
  const { enabled, onCommit, readSelection } = options;
  const [pendingAction, setPendingAction] = useState<PendingCodeSelectionAction<T> | null>(null);

  const onContainerMouseUp = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      const container = event.currentTarget;
      const pointer = { x: event.clientX, y: event.clientY };
      // Wait a frame so the browser finalizes the selection before reading it.
      window.requestAnimationFrame(() => {
        if (!enabled || !container.isConnected) {
          setPendingAction(null);
          return;
        }
        const payload = readSelection(container);
        if (payload === null) {
          setPendingAction(null);
          return;
        }
        const layout = resolveTranscriptSelectionActionLayout({
          selectionRect: getActiveSelectionRect(),
          pointer,
        });
        setPendingAction({ payload, ...layout });
      });
    },
    [enabled, readSelection],
  );

  const commit = useCallback(() => {
    if (!pendingAction) {
      return;
    }
    onCommit(pendingAction.payload);
    setPendingAction(null);
    window.getSelection()?.removeAllRanges();
  }, [onCommit, pendingAction]);

  useEffect(() => {
    if (!enabled) {
      setPendingAction(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!pendingAction) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-transcript-selection-action='true']")
      ) {
        return;
      }
      setPendingAction(null);
    };
    const handleWindowChange = () => {
      setPendingAction(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    document.addEventListener("selectionchange", handleWindowChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
      document.removeEventListener("selectionchange", handleWindowChange);
    };
  }, [pendingAction]);

  return { pendingAction, onContainerMouseUp, commit };
}
