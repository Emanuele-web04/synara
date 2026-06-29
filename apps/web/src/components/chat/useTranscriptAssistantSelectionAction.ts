// FILE: useTranscriptAssistantSelectionAction.ts
// Purpose: Own the assistant highlight -> floating action -> composer insertion flow for transcript selections.
// Layer: Chat transcript interaction controller

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { toastManager } from "../ui/toast";
import { type ComposerAssistantSelectionAttachment } from "../../composerDraftStore";
import {
  createAssistantSelectionAttachment,
  getAssistantSelectionValidationError,
} from "../../lib/assistantSelections";
import {
  readTranscriptAssistantSelection,
  resolveTranscriptSelectionActionLayout,
  type TranscriptAssistantSelection,
} from "./chatSelectionActions";

export interface PendingTranscriptSelectionAction {
  selection: TranscriptAssistantSelection;
  left: number;
  top: number;
  placement: "top" | "bottom";
}

interface UseTranscriptAssistantSelectionActionOptions {
  threadId: string;
  enabled: boolean;
  transcriptContainerRef: RefObject<HTMLDivElement | null>;
  composerImagesRef: MutableRefObject<ReadonlyArray<unknown>>;
  composerFilesRef: MutableRefObject<ReadonlyArray<unknown>>;
  composerAssistantSelectionsRef: MutableRefObject<
    ReadonlyArray<ComposerAssistantSelectionAttachment>
  >;
  addComposerAssistantSelectionToDraft: (
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
  canReferenceAssistantSelection?: (selection: TranscriptAssistantSelection) => boolean;
  scheduleComposerFocus: () => void;
  onMessagesClickCaptureBase: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerDownBase: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUpBase: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerCancelBase: PointerEventHandler<HTMLDivElement>;
  onMessagesScrollBase: () => void;
  onMessagesWheelBase: WheelEventHandler<HTMLDivElement>;
  onMessagesTouchStartBase: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMoveBase: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchEndBase: TouchEventHandler<HTMLDivElement>;
}

export function useTranscriptAssistantSelectionAction(
  options: UseTranscriptAssistantSelectionActionOptions,
) {
  const {
    threadId,
    enabled,
    transcriptContainerRef,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection,
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesWheelBase,
    onMessagesTouchStartBase,
    onMessagesTouchMoveBase,
    onMessagesTouchEndBase,
  } = options;
  const [pendingTranscriptSelectionAction, setPendingTranscriptSelectionAction] =
    useState<PendingTranscriptSelectionAction | null>(null);
  const selectionFocusReturnRef = useRef<HTMLElement | null>(null);

  const dismissTranscriptSelectionAction = useCallback((restoreFocus = false) => {
    setPendingTranscriptSelectionAction(null);
    if (restoreFocus) {
      const focusReturnElement = selectionFocusReturnRef.current;
      if (focusReturnElement?.isConnected) {
        focusReturnElement.focus({ preventScroll: true });
      }
    }
  }, []);

  const revealTranscriptSelectionAction = useCallback(
    (container: HTMLElement, pointer: { x: number; y: number } | null) => {
      if (!enabled) {
        setPendingTranscriptSelectionAction(null);
        return;
      }

      const selectionState = readTranscriptAssistantSelection({ container });
      if (
        !selectionState ||
        (canReferenceAssistantSelection &&
          !canReferenceAssistantSelection(selectionState.selection))
      ) {
        setPendingTranscriptSelectionAction(null);
        return;
      }

      const selectionRect = selectionState.selectionRect;
      const fallbackPointer =
        selectionRect !== null
          ? {
              x: selectionRect.left + selectionRect.width / 2,
              y: selectionRect.bottom,
            }
          : {
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            };
      const layout = resolveTranscriptSelectionActionLayout({
        selectionRect,
        pointer: pointer ?? fallbackPointer,
      });
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        !activeElement.closest("[data-transcript-selection-action='true']")
      ) {
        selectionFocusReturnRef.current = activeElement;
      }
      setPendingTranscriptSelectionAction({
        selection: selectionState.selection,
        left: layout.left,
        top: layout.top,
        placement: layout.placement,
      });
    },
    [canReferenceAssistantSelection, enabled],
  );

  const onMessagesClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesClickCaptureBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesClickCaptureBase],
  );

  const onMessagesPointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesPointerDownBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesPointerDownBase],
  );

  const onMessagesPointerUp = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      onMessagesPointerUpBase(event);
    },
    [onMessagesPointerUpBase],
  );

  const onMessagesPointerCancel = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesPointerCancelBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesPointerCancelBase],
  );

  const onMessagesScroll = useCallback(() => {
    dismissTranscriptSelectionAction();
    onMessagesScrollBase();
  }, [dismissTranscriptSelectionAction, onMessagesScrollBase]);

  const onMessagesWheel = useCallback<WheelEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesWheelBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesWheelBase],
  );

  const onMessagesTouchStart = useCallback<TouchEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesTouchStartBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesTouchStartBase],
  );

  const onMessagesTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>(
    (event) => {
      dismissTranscriptSelectionAction();
      onMessagesTouchMoveBase(event);
    },
    [dismissTranscriptSelectionAction, onMessagesTouchMoveBase],
  );

  const onMessagesTouchEnd = useCallback<TouchEventHandler<HTMLDivElement>>(
    (event) => {
      onMessagesTouchEndBase(event);
    },
    [onMessagesTouchEndBase],
  );

  const onMessagesMouseUp = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      const container = event.currentTarget;
      const clientX = event.clientX;
      const clientY = event.clientY;
      window.requestAnimationFrame(() => {
        revealTranscriptSelectionAction(container, { x: clientX, y: clientY });
      });
    },
    [revealTranscriptSelectionAction],
  );

  const commitTranscriptAssistantSelection = useCallback(() => {
    const pendingSelection = pendingTranscriptSelectionAction;
    if (!pendingSelection) {
      return;
    }

    if (
      canReferenceAssistantSelection &&
      !canReferenceAssistantSelection(pendingSelection.selection)
    ) {
      setPendingTranscriptSelectionAction(null);
      window.getSelection()?.removeAllRanges();
      return;
    }

    if (
      composerImagesRef.current.length +
        composerFilesRef.current.length +
        composerAssistantSelectionsRef.current.length >=
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setPendingTranscriptSelectionAction(null);
      toastManager.add({
        type: "warning",
        title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
      });
      return;
    }

    const nextSelection = createAssistantSelectionAttachment(pendingSelection.selection);
    if (!nextSelection) {
      setPendingTranscriptSelectionAction(null);
      if (getAssistantSelectionValidationError(pendingSelection.selection) === "too-long") {
        toastManager.add({
          type: "warning",
          title: "Selections can be up to 4,000 characters.",
        });
      }
      return;
    }

    const inserted = addComposerAssistantSelectionToDraft(nextSelection);
    setPendingTranscriptSelectionAction(null);
    if (inserted) {
      window.getSelection()?.removeAllRanges();
      scheduleComposerFocus();
    }
  }, [
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection,
    composerAssistantSelectionsRef,
    composerFilesRef,
    composerImagesRef,
    pendingTranscriptSelectionAction,
    scheduleComposerFocus,
  ]);

  useEffect(() => {
    setPendingTranscriptSelectionAction(null);
  }, [threadId]);

  useEffect(() => {
    if (!enabled) {
      setPendingTranscriptSelectionAction(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let frameId: number | null = null;
    const handleSelectionChange = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const container = transcriptContainerRef.current;
        if (!container) {
          setPendingTranscriptSelectionAction(null);
          return;
        }
        revealTranscriptSelectionAction(container, null);
      });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [enabled, revealTranscriptSelectionAction, transcriptContainerRef]);

  useEffect(() => {
    if (!pendingTranscriptSelectionAction) {
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
      setPendingTranscriptSelectionAction(null);
    };
    const handleWindowChange = () => {
      setPendingTranscriptSelectionAction(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      dismissTranscriptSelectionAction(true);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleWindowChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleWindowChange);
    };
  }, [dismissTranscriptSelectionAction, pendingTranscriptSelectionAction]);

  return {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  };
}
