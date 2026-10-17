// FILE: TranscriptSelectionActionLayer.tsx
// Purpose: Renders the transcript selection floating action from controller state.
// Layer: Chat transcript interaction UI

import type { ThreadEnvironmentMode } from "@synara/contracts";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { toastManager } from "../ui/toast";
import type { TranscriptAssistantSelection } from "./chatSelectionActions";
import { SelectionNewChatComposer } from "./SelectionNewChatComposer";

import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";

interface TranscriptSelectionActionLayerProps {
  action: PendingTranscriptSelectionAction | null;
  defaultEnvMode: ThreadEnvironmentMode;
  canUseWorktree: boolean;
  canAddToSide: boolean;
  onDismiss: () => void;
  canAddToChat: (selection: TranscriptAssistantSelection) => boolean;
  onAddToChat: (selection: TranscriptAssistantSelection, comment: string) => void;
  onAddToSide: (selection: TranscriptAssistantSelection) => Promise<void>;
  onNewChat: (
    selection: TranscriptAssistantSelection,
    prompt: string,
    envMode: ThreadEnvironmentMode,
    intent: "send" | "compose",
  ) => Promise<void>;
}

export function TranscriptSelectionActionLayer(props: TranscriptSelectionActionLayerProps) {
  const [composerAction, setComposerAction] = useState<{
    action: PendingTranscriptSelectionAction;
    variant: "new-chat" | "comment";
  } | null>(null);
  const [sideBusy, setSideBusy] = useState(false);
  const sideInFlightRef = useRef(false);

  if (composerAction) {
    const { selection } = composerAction.action;
    return createPortal(
      composerAction.variant === "comment" ? (
        <SelectionNewChatComposer
          variant="comment"
          action={composerAction.action}
          onAddComment={(comment) => props.onAddToChat(selection, comment)}
          onClose={() => setComposerAction(null)}
        />
      ) : (
        <SelectionNewChatComposer
          variant="new-chat"
          action={composerAction.action}
          defaultEnvMode={props.defaultEnvMode}
          canUseWorktree={props.canUseWorktree}
          onSend={(prompt, envMode) => props.onNewChat(selection, prompt, envMode, "send")}
          onOpenInChat={(prompt, envMode) => props.onNewChat(selection, prompt, envMode, "compose")}
          onClose={() => setComposerAction(null)}
        />
      ),
      document.body,
    );
  }
  const action = props.action;
  if (!action) return null;

  const openComposer = (variant: "new-chat" | "comment") => {
    setComposerAction({ action, variant });
    props.onDismiss();
    window.getSelection()?.removeAllRanges();
  };

  return createPortal(
    <TranscriptSelectionAction
      left={action.left}
      top={action.top}
      placement={action.placement}
      onAddToChat={() => {
        if (props.canAddToChat(action.selection)) {
          openComposer("comment");
          return;
        }
        props.onDismiss();
        window.getSelection()?.removeAllRanges();
      }}
      disabled={sideBusy}
      sideDisabled={!props.canAddToSide}
      onAddToSide={() => {
        if (sideInFlightRef.current) return;
        sideInFlightRef.current = true;
        setSideBusy(true);
        void props
          .onAddToSide(action.selection)
          .then(() => {
            props.onDismiss();
            window.getSelection()?.removeAllRanges();
          })
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Could not add selection to Side",
              description: error instanceof Error ? error.message : "Try again.",
            });
          })
          .finally(() => {
            sideInFlightRef.current = false;
            setSideBusy(false);
          });
      }}
      onAddToNewChat={() => openComposer("new-chat")}
    />,
    document.body,
  );
}
