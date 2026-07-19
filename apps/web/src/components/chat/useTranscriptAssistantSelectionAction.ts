// FILE: useTranscriptAssistantSelectionAction.ts
// Purpose: Own the assistant highlight -> floating action -> composer insertion flow for transcript selections.
// Layer: Chat transcript interaction controller

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import {
  useEffect,
  useRef,
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
  // Pending action keyed to its thread: a thread switch or disable derives
  // straight back to null with no state-resetting effects. The setter reads
  // the current thread from a ref so empty-deps callbacks never go stale.
  const [pendingActionState, setPendingActionState] = useState<{
    threadId: typeof threadId;
    action: PendingTranscriptSelectionAction;
  } | null>(null);
  const pendingActionThreadIdRef = useRef(threadId);
  useEffect(() => {
    pendingActionThreadIdRef.current = threadId;
  }, [threadId]);
  const pendingTranscriptSelectionAction =
    enabled && pendingActionState !== null && pendingActionState.threadId === threadId
      ? pendingActionState.action
      : null;
  const setPendingTranscriptSelectionAction = (action: PendingTranscriptSelectionAction | null) =>
    setPendingActionState(
      action === null ? null : { threadId: pendingActionThreadIdRef.current, action },
    );

  const dismissTranscriptSelectionAction = () => {
    setPendingTranscriptSelectionAction(null);
  };

  const onMessagesClickCapture: MouseEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesClickCaptureBase(event);
  };

  const onMessagesPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesPointerDownBase(event);
  };

  const onMessagesPointerUp: PointerEventHandler<HTMLDivElement> = (event) => {
    onMessagesPointerUpBase(event);
  };

  const onMessagesPointerCancel: PointerEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesPointerCancelBase(event);
  };

  const onMessagesScroll = () => {
    dismissTranscriptSelectionAction();
    onMessagesScrollBase();
  };

  const onMessagesWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesWheelBase(event);
  };

  const onMessagesTouchStart: TouchEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesTouchStartBase(event);
  };

  const onMessagesTouchMove: TouchEventHandler<HTMLDivElement> = (event) => {
    dismissTranscriptSelectionAction();
    onMessagesTouchMoveBase(event);
  };

  const onMessagesTouchEnd: TouchEventHandler<HTMLDivElement> = (event) => {
    onMessagesTouchEndBase(event);
  };

  const onMessagesMouseUp: MouseEventHandler<HTMLDivElement> = (event) => {
    const container = event.currentTarget;
    const clientX = event.clientX;
    const clientY = event.clientY;
    window.requestAnimationFrame(() => {
      if (!enabled || !container) {
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
  };

  const commitTranscriptAssistantSelection = () => {
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
  };

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
