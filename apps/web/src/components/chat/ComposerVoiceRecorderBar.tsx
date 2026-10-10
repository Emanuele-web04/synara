// FILE: ComposerVoiceRecorderBar.tsx
// Purpose: Renders the expanded voice recorder UI inside the chat composer.
// Layer: Chat composer presentation
// Depends on: live waveform samples and caller-owned discard/stop/send actions.

import { useEffect, useRef, useState } from "react";

import { ComposerSendArrowIcon, Loader2Icon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ComposerVoiceRecorderBarProps {
  disabled?: boolean;
  isRecording: boolean;
  // Recording has started but the device has not delivered real audio yet.
  isWaitingForAudio?: boolean;
  isTranscribing: boolean;
  waveformLevels: readonly number[];
  // Throws the recording away without transcribing it.
  onDiscard: () => void;
  // Transcribes into the composer draft.
  onStop: () => void;
  // Transcribes and sends the message. Surfaces without a send step omit it.
  onSend?: () => void;
}

// Quiet samples render as round dots; louder ones grow into rounded bars.
const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 3;
const BAR_MAX_HEIGHT_PX = 14;
const BAR_NOISE_FLOOR = 0.06;

export function ComposerVoiceRecorderBar(props: ComposerVoiceRecorderBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [visibleBarCount, setVisibleBarCount] = useState(96);
  const [sendRequested, setSendRequested] = useState(false);

  useEffect(() => {
    const node = trackRef.current;
    if (!node) {
      return;
    }
    const computeVisibleBars = () => {
      const width = node.clientWidth;
      if (width <= 0) {
        return;
      }
      setVisibleBarCount(
        Math.max(8, Math.floor((width + BAR_GAP_PX) / (BAR_WIDTH_PX + BAR_GAP_PX))),
      );
    };
    computeVisibleBars();
    const observer = new ResizeObserver(computeVisibleBars);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Newest samples sit on the right; silence fills the rest of the track with dots.
  const recentLevels = props.waveformLevels.slice(-visibleBarCount);
  const visibleLevels = [
    ...Array.from({ length: visibleBarCount - recentLevels.length }, () => 0),
    ...recentLevels,
  ];
  const isWaitingForAudio = props.isWaitingForAudio === true && !props.isTranscribing;
  const actionsDisabled = props.disabled || props.isTranscribing;
  const { onSend } = props;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div
        ref={trackRef}
        aria-hidden="true"
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center justify-end overflow-hidden",
          props.isTranscribing && "opacity-55",
        )}
        style={{ gap: `${BAR_GAP_PX}px` }}
      >
        {visibleLevels.map((level, index) => {
          const clamped = level < BAR_NOISE_FLOOR ? 0 : Math.min(1, level);
          const height = Math.round(BAR_WIDTH_PX + clamped * (BAR_MAX_HEIGHT_PX - BAR_WIDTH_PX));
          const positionFromRight = visibleLevels.length - index;
          return (
            <span
              key={positionFromRight}
              className="shrink-0 rounded-full bg-[var(--color-text-foreground-secondary)]"
              style={{
                width: `${BAR_WIDTH_PX}px`,
                height: `${height}px`,
              }}
            />
          );
        })}
      </div>

      {isWaitingForAudio ? (
        <span
          role="status"
          className="flex shrink-0 items-center gap-1.5 text-ui-sm leading-snug text-zinc-500 dark:text-zinc-400"
        >
          <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
          Waiting for microphone…
        </span>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-7 rounded-full sm:size-7"
        aria-label="Cancel voice recording"
        title="Discard the recording"
        disabled={actionsDisabled}
        onClick={props.onDiscard}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </Button>

      <Button
        type="button"
        variant="subtle"
        size="icon-xs"
        className="size-7 rounded-full sm:size-7"
        aria-label={props.isTranscribing ? "Transcribing voice note" : "Stop voice recording"}
        title="Stop and add the transcript to the draft"
        disabled={actionsDisabled}
        onClick={() => {
          setSendRequested(false);
          props.onStop();
        }}
      >
        {props.isTranscribing && !sendRequested ? (
          <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
        ) : (
          <span aria-hidden="true" className="block size-2 rounded-[1px] bg-current" />
        )}
      </Button>

      {onSend ? (
        <Button
          type="button"
          variant="prominent"
          size="icon-xs"
          className="size-7 rounded-full sm:size-7"
          aria-label={props.isTranscribing ? "Transcribing voice note" : "Send voice note"}
          title="Stop and send the transcript"
          disabled={actionsDisabled}
          onClick={() => {
            setSendRequested(true);
            onSend();
          }}
        >
          {props.isTranscribing && sendRequested ? (
            <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <ComposerSendArrowIcon aria-hidden="true" className="size-5 shrink-0 translate-y-px" />
          )}
        </Button>
      ) : null}
    </div>
  );
}
