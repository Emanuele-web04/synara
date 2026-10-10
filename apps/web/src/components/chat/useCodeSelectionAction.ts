import { useEffect, useState, type MouseEventHandler } from "react";

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

// caller attaches onContainerMouseUp and renders TranscriptSelectionAction while pendingAction is set; readSelection inspects the live selection scoped to the container
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
  const [pendingActionState, setPendingAction] = useState<PendingCodeSelectionAction<T> | null>(
    null,
  );
  // derived: disabling clears the visible action in the same render with no state-resetting effect
  const pendingAction = enabled ? pendingActionState : null;

  const onContainerMouseUp: MouseEventHandler<HTMLElement> = (event) => {
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
  };

  const commit = () => {
    if (!pendingAction) {
      return;
    }
    onCommit(pendingAction.payload);
    setPendingAction(null);
    window.getSelection()?.removeAllRanges();
  };

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
