// FILE: ComposerVoiceButton.tsx
// Purpose: Renders the composer mic control for recording and transcribing a voice note.
// Layer: Chat composer presentation
// Depends on: shared button styling and caller-owned voice recording state callbacks.

import { memo } from "react";
import { IoMicOutline } from "react-icons/io5";

import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";

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
    <button
      type="button"
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors duration-150 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-400 dark:hover:text-zinc-100 sm:h-8 sm:w-8",
      )}
      disabled={props.disabled || props.isTranscribing}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {props.isTranscribing ? (
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <IoMicOutline aria-hidden="true" className="size-[18px]" />
      )}
    </button>
  );
});
