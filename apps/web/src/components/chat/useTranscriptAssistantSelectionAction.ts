// FILE: useTranscriptAssistantSelectionAction.ts
// Purpose: Own the assistant highlight -> floating action -> composer insertion flow for transcript selections.
// Layer: Chat transcript interaction controller

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useState,
  type MutableRefObject,
  type MouseEventHandler,
  type PointerEventHandler,
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
  composerImagesRef: MutableRefObject<ReadonlyArray<unknown>>;
  composerAssistantSelectionsRef: MutableRefObject<
    ReadonlyArray<ComposerAssistantSelectionAttachment>
  >;
  addComposerAssistantSelectionToDraft: (
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
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
    composerImagesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
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

  const dismissTranscriptSelectionAction = useCallback(() => {
    setPendingTranscriptSelectionAction(null);
  }, []);

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
        if (!enabled || !container) {
          setPendingTranscriptSelectionAction(null);
          return;
        }

        const selectionState = readTranscriptAssistantSelection({ container });
        if (!selectionState) {
          setPendingTranscriptSelectionAction(null);
          return;
        }

        if (
          composerImagesRef.current.length + composerAssistantSelectionsRef.current.length >=
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          setPendingTranscriptSelectionAction(null);
          toastManager.add({
            type: "warning",
            title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
          });
          return;
        }

        const layout = resolveTranscriptSelectionActionLayout({
          selectionRect: selectionState.selectionRect,
          pointer: { x: clientX, y: clientY },
        });
        setPendingTranscriptSelectionAction({
          selection: selectionState.selection,
          left: layout.left,
          top: layout.top,
          placement: layout.placement,
        });
      });
    },
    [enabled, composerImagesRef, composerAssistantSelectionsRef],
  );

  const commitTranscriptAssistantSelection = useCallback(() => {
    const pendingSelection = pendingTranscriptSelectionAction;
    if (!pendingSelection) {
      return;
    }

    if (
      composerImagesRef.current.length + composerAssistantSelectionsRef.current.length >=
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
    composerAssistantSelectionsRef,
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

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    document.addEventListener("selectionchange", handleWindowChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      document.removeEventListener("selectionchange", handleWindowChange);
    };
  }, [pendingTranscriptSelectionAction]);

  return {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
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
