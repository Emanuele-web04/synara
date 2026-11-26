import { useTranslation } from "~/i18n";
// FILE: ComposerVoiceButton.tsx
// Purpose: Renders the composer mic control for recording and transcribing a voice note.
// Layer: Chat composer presentation
// Depends on: shared button styling and caller-owned voice recording state callbacks.

import { Loader2Icon, MicIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_ACTION_CIRCLE_CLASS_NAME } from "./composerPickerStyles";

export const ComposerVoiceButton = function ComposerVoiceButton(props: {
  /** `circle`: filled circle beside a prominent send button (chat composers). */
  appearance?: "circle" | "ghost";
  disabled?: boolean;
  isRecording: boolean;
  isStarting?: boolean;
  isTranscribing: boolean;
  durationLabel: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  const isBusy = props.isTranscribing || props.isStarting === true;
  const circle = props.appearance === "circle";
  const label = props.isTranscribing
    ? t("chat:composer_transcribingVoice")
    : props.isStarting
      ? t("chat:startingMicrophone")
      : props.isRecording
        ? t("chat:stopVoiceNote", { value0: props.durationLabel })
        : t("chat:recordVoiceNote");

  return (
    <Button
      size="icon-sm"
      variant={circle ? "circle" : "ghost"}
      className={circle ? COMPOSER_ACTION_CIRCLE_CLASS_NAME : "shrink-0 rounded-md"}
      disabled={props.disabled || isBusy}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {isBusy ? (
        <Loader2Icon
          aria-hidden="true"
          className={cn("animate-spin text-primary", circle ? "size-3.5" : "size-4")}
        />
      ) : (
        <MicIcon
          aria-hidden="true"
          className={cn("text-primary", circle ? "size-3.5" : "size-4")}
        />
      )}
    </Button>
  );
};
