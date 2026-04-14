// FILE: ComposerVoiceButton.tsx
// Purpose: Renders the composer mic control for recording and transcribing a voice note.
// Layer: Chat composer presentation
// Depends on: shared button styling and caller-owned voice recording state callbacks.

import { memo } from "react";

import { Loader2Icon, MicIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export const ComposerVoiceButton = memo(function ComposerVoiceButton(props: {
  compact: boolean;
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
      size="sm"
      variant="ghost"
      className={cn(
        "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80",
        props.isRecording && "text-red-500 hover:text-red-500",
      )}
      disabled={props.disabled || props.isTranscribing}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {props.isTranscribing ? (
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      ) : props.isRecording ? (
        <StopIcon aria-hidden="true" className="size-4" />
      ) : (
        <MicIcon aria-hidden="true" className="size-4" />
      )}
      {!props.compact && (
        <span className="ml-1.5 text-xs font-medium">
          {props.isTranscribing
            ? "Transcribing"
            : props.isRecording
              ? props.durationLabel
              : "Voice"}
        </span>
      )}
    </Button>
  );
});
