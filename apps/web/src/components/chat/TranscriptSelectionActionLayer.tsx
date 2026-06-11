// FILE: TranscriptSelectionActionLayer.tsx
// Purpose: Renders the transcript selection floating action from controller state.
// Layer: Chat transcript interaction UI

import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";

interface TranscriptSelectionActionLayerProps {
  action: PendingTranscriptSelectionAction | null;
  onHighlight?: (() => void) | undefined;
  onUnderline?: (() => void) | undefined;
  onAddToChat: () => void;
}

export function TranscriptSelectionActionLayer(props: TranscriptSelectionActionLayerProps) {
  if (!props.action) {
    return null;
  }

  return (
    <TranscriptSelectionAction
      left={props.action.left}
      top={props.action.top}
      placement={props.action.placement}
      onHighlight={props.onHighlight}
      onUnderline={props.onUnderline}
      onAddToChat={props.onAddToChat}
    />
  );
}
