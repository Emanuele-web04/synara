// Purpose: Floating composer that lets the user attach a note to a transcript
//   quote before it lands as an assistant-selection chip in the main composer draft.

import { ThreadId } from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { XIcon } from "~/lib/icons";
import { appendVoiceTranscriptToPrompt } from "../ChatView.logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";
import { cn } from "~/lib/utils";
import {
  useComposerVoiceController,
  type UseComposerVoiceControllerOptions,
} from "./useComposerVoiceController";
import type { PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";

export type SelectionCommentComposerVoice = Omit<
  UseComposerVoiceControllerOptions,
  "onTranscriptReady"
>;

// Hooks always run, so the voice controller still mounts when no provider context
// was supplied; the mic control only renders when real options were passed in.
const DISABLED_VOICE_OPTIONS: SelectionCommentComposerVoice = {
  activeProject: undefined,
  activeThreadId: null,
  threadId: ThreadId.makeUnsafe("selection-comment-composer"),
  selectedProvider: "codex",
  activeProviderStatus: null,
  pendingUserInputCount: 0,
  refreshVoiceStatus: async () => null,
};

interface SelectionCommentComposerProps {
  action: PendingTranscriptSelectionAction;
  voice?: SelectionCommentComposerVoice | undefined;
  onSubmit: (comment: string) => void;
  onClose: () => void;
}

export function SelectionCommentComposer({
  action,
  voice,
  onSubmit,
  onClose,
}: SelectionCommentComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const submittingRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerPromptEditorHandle>(null);
  const selections = [
    {
      type: "assistant-selection" as const,
      id: action.selection.assistantMessageId,
      ...action.selection,
    },
  ];
  const {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  } = useComposerVoiceController({
    ...(voice ?? DISABLED_VOICE_OPTIONS),
    onTranscriptReady: (transcript) => {
      const nextPrompt = appendVoiceTranscriptToPrompt(
        inputRef.current?.readSnapshot().value ?? prompt,
        transcript,
      );
      if (!nextPrompt) {
        return;
      }
      setPrompt(nextPrompt);
      setCursor(nextPrompt.length);
    },
  });
  const cancelVoiceRecordingRef = useRef(cancelComposerVoiceRecording);
  useLayoutEffect(() => {
    cancelVoiceRecordingRef.current = cancelComposerVoiceRecording;
  });
  const voiceBusy = isVoiceRecording || isVoiceTranscribing;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const position = () => {
      const { width, height } = surface.getBoundingClientRect();
      const top =
        action.placement === "top"
          ? action.top + TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX - height
          : action.top;
      surface.style.left = `${Math.max(8, Math.min(action.left, window.innerWidth - width - 8))}px`;
      surface.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    };
    position();
    inputRef.current?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(surface);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [action]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !submittingRef.current &&
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target)
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(
    () => () => {
      cancelVoiceRecordingRef.current();
    },
    [],
  );

  const submit = () => {
    if (submittingRef.current || voiceBusy) return;
    submittingRef.current = true;
    onSubmit(inputRef.current?.readSnapshot().value ?? prompt);
    onClose();
  };

  return (
    <div
      ref={surfaceRef}
      data-transcript-selection-action="true"
      role="dialog"
      aria-label="Comment on selection"
      className="fixed z-50 w-[320px] max-w-[calc(100vw-16px)] text-foreground"
      // No overflow on this wrapper: a scroll box is square and would clip the rounded
      // surface's shadow into hard corners. The editor caps and scrolls its own height.
      style={{ left: action.left, top: action.top }}
    >
      <div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
        <div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
          <DisclosureRegion open>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className={cn(COMPOSER_EDITOR_PADDING_CLASS_NAME, "px-2.5 pt-2 pb-1")}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <AssistantSelectionsSummaryChip selections={selections} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Close note composer"
                    onClick={onClose}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
                <ComposerPromptEditor
                  ref={inputRef}
                  value={prompt}
                  cursor={cursor}
                  terminalContexts={[]}
                  disabled={isVoiceTranscribing}
                  ariaLabel="Note for selection"
                  className="min-h-[1lh]"
                  placeholder="Add a note about this selection…"
                  onRemoveTerminalContext={() => {}}
                  onPaste={() => {}}
                  onChange={(value, nextCursor) => {
                    setPrompt(value);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                    submit();
                    return true;
                  }}
                />
              </div>
              <div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-2")}>
                {voice !== undefined && voiceBusy ? (
                  <ComposerVoiceRecorderBar
                    isRecording={isVoiceRecording}
                    isTranscribing={isVoiceTranscribing}
                    durationLabel={voiceRecordingDurationLabel}
                    waveformLevels={voiceWaveformLevels}
                    onDiscard={cancelComposerVoiceRecording}
                    onStop={() => {
                      void submitComposerVoiceRecording();
                    }}
                  />
                ) : (
                  <>
                    {voice !== undefined && showVoiceNotesControl ? (
                      <ComposerVoiceButton
                        isRecording={isVoiceRecording}
                        isTranscribing={isVoiceTranscribing}
                        durationLabel={voiceRecordingDurationLabel}
                        onClick={() => {
                          void startComposerVoiceRecording();
                        }}
                      />
                    ) : null}
                    <Button
                      type="submit"
                      variant="prominent"
                      size="sm"
                      className="ml-auto h-7 rounded-full px-3"
                      aria-label="Add to chat"
                    >
                      Add to chat
                    </Button>
                  </>
                )}
              </div>
            </form>
          </DisclosureRegion>
        </div>
      </div>
    </div>
  );
}
