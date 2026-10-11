// FILE: ComposerVoiceButton.tsx
// Purpose: Renders the composer mic control for recording and transcribing a voice note.
// Layer: Chat composer presentation
// Depends on: shared button styling and caller-owned voice recording state callbacks.

import { Loader2Icon, MicIcon } from "~/lib/icons";
import { Button } from "../ui/button";

export const ComposerVoiceButton = function ComposerVoiceButton(props: {
  disabled?: boolean;
  isRecording: boolean;
  isStarting?: boolean;
  isTranscribing: boolean;
  durationLabel: string;
  onClick: () => void;
}) {
  const isBusy = props.isTranscribing || props.isStarting === true;
  const label = props.isTranscribing
    ? "Transcribing voice note"
    : props.isStarting
      ? "Starting microphone"
      : props.isRecording
        ? `Stop voice note (${props.durationLabel})`
        : "Record voice note";

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="shrink-0 rounded-md"
      disabled={props.disabled || isBusy}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {isBusy ? (
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin text-primary" />
      ) : (
        <MicIcon aria-hidden="true" className="size-4 text-primary" />
      )}
    </Button>
  );
};
