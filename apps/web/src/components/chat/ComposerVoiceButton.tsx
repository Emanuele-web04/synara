// FILE: ComposerVoiceButton.tsx
// Purpose: Renders the composer mic control for recording and transcribing a voice note.
// Layer: Chat composer presentation
// Depends on: shared button styling and caller-owned voice recording state callbacks.

import { memo } from "react";

import { Loader2Icon, MicIcon } from "~/lib/icons";
import { Button } from "../ui/button";

export const ComposerVoiceButton = memo(function ComposerVoiceButton(props: {
  disabled?: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  durationLabel: string;
  onClick: () => void;
}) {
  const label = props.isTranscribing
    ? "Transcribing voice note"
    : props.isRecording
      ? `Stop voice note (${props.durationLabel})`
      : "Record voice note";

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="shrink-0 rounded-md text-muted-foreground/70 hover:text-foreground/80"
      disabled={props.disabled || props.isTranscribing}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {props.isTranscribing ? (
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <MicIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
});
