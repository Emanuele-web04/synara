import { ProviderInteractionMode } from "@synara/contracts";
import { type ReactNode } from "react";
import { GoTasklist } from "react-icons/go";
import { BugIcon, ChevronDownIcon, ComposerSendArrowIcon, LayoutSidebarIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { derivePendingUserInputProgress } from "../../pendingUserInput";
import type { SessionPhase } from "../../types";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";
import { COMPOSER_FOOTER_ROW_CLASS_NAME } from "./composerPickerStyles";
interface ChatComposerFooterProps {
  isComposerFooterCompact: boolean;
  leadingControls: ReactNode;
  composerPickerControls: ReactNode;
  contextMeter: ReactNode;
  interactionMode: ProviderInteractionMode;
  resetInteractionMode: () => void;
  sidebarAction: { title: string; label: string; onClick: () => void } | null;
  voice: {
    enabled: boolean;
    recording: boolean;
    transcribing: boolean;
    durationLabel: string;
    waveformLevels: readonly number[];
    onCancel: () => void;
    onSubmit: () => void;
    onToggle: () => void;
  };
  pendingInput: {
    progress: NonNullable<ReturnType<typeof derivePendingUserInputProgress>>;
    responding: boolean;
    answersComplete: boolean;
  } | null;
  submission: {
    phase: SessionPhase;
    busy: boolean;
    connecting: boolean;
    expired: boolean;
    preparingImages: boolean;
    preparingWorktree: boolean;
    hasContent: boolean;
    hasPendingUserInputs: boolean;
    showPlanFollowUp: boolean;
    hasPrompt: boolean;
    onInterrupt: () => void;
    onImplementInNewThread: () => void;
  };
}

export function ChatComposerFooter({
  isComposerFooterCompact,
  leadingControls,
  composerPickerControls,
  contextMeter,
  interactionMode,
  resetInteractionMode,
  sidebarAction,
  voice,
  pendingInput,
  submission,
}: ChatComposerFooterProps) {
  return (
    <div
      data-chat-composer-footer="true"
      className={cn(
        "@container",
        COMPOSER_FOOTER_ROW_CLASS_NAME,
        isComposerFooterCompact ? "gap-1.5" : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
      )}
    >
      <div
        data-chat-composer-leading="true"
        className={cn(
          "flex items-center",
          voice.recording || voice.transcribing
            ? "min-w-0 shrink-0 gap-1"
            : isComposerFooterCompact
              ? "min-w-0 flex-1 gap-1 overflow-hidden"
              : "min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
        )}
      >
        {leadingControls}

        {!voice.recording && !voice.transcribing ? (
          <>
            {interactionMode !== "default" ? (
              <Button
                variant="ghost"
                className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] sm:px-3"
                size="sm"
                type="button"
                onClick={resetInteractionMode}
                title={`${interactionMode === "plan" ? "Plan" : "Debug"} mode — click to return to normal build mode`}
              >
                {interactionMode === "plan" ? (
                  <GoTasklist className="size-3.5" />
                ) : (
                  <BugIcon className="size-3.5" />
                )}
                <span className="sr-only sm:not-sr-only">
                  {interactionMode === "plan" ? "Plan" : "Debug"}
                </span>
              </Button>
            ) : null}

            {sidebarAction ? (
              <Button
                variant="ghost"
                className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                size="sm"
                type="button"
                onClick={sidebarAction.onClick}
                title={sidebarAction.title}
                aria-label={sidebarAction.title}
              >
                <LayoutSidebarIcon className="size-3.5" />
                <span className="sr-only sm:not-sr-only">{sidebarAction.label}</span>
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      <div
        data-chat-composer-actions="right"
        className={cn(
          "flex items-center gap-2",
          voice.recording || voice.transcribing ? "min-w-0 flex-1" : "shrink-0",
        )}
      >
        {contextMeter}
        {!voice.recording && !voice.transcribing ? composerPickerControls : null}
        {voice.enabled && (voice.recording || voice.transcribing) ? (
          <ComposerVoiceRecorderBar
            disabled={submission.connecting || submission.busy || submission.expired}
            isRecording={voice.recording}
            isTranscribing={voice.transcribing}
            durationLabel={voice.durationLabel}
            waveformLevels={voice.waveformLevels}
            onDiscard={voice.onCancel}
            onStop={() => {
              void voice.onSubmit();
            }}
          />
        ) : null}
        {pendingInput?.progress ? (
          <Button
            type="submit"
            size="sm"
            className="rounded-full px-4"
            disabled={
              pendingInput.responding ||
              (pendingInput.progress.isLastQuestion
                ? !pendingInput.answersComplete
                : !pendingInput.progress.canAdvance)
            }
          >
            {pendingInput.responding
              ? "Submitting..."
              : pendingInput.progress.isLastQuestion
                ? "Submit answers"
                : "Next question"}
          </Button>
        ) : submission.phase === "running" ? (
          <Button
            type="button"
            variant="prominent"
            size="icon-xs"
            className="sm:size-[26px]"
            onClick={submission.onInterrupt}
            aria-label="Stop generation"
            title="Stop the current response. On Mac, press Ctrl+C to interrupt."
          >
            <span aria-hidden="true" className="block size-2 rounded-[1px] bg-current" />
          </Button>
        ) : !submission.hasPendingUserInputs && !voice.recording && !voice.transcribing ? (
          submission.showPlanFollowUp ? (
            submission.hasPrompt ? (
              <Button
                type="submit"
                size="sm"
                className="h-9 rounded-full px-4 sm:h-8"
                disabled={submission.busy || submission.connecting || submission.expired}
              >
                {submission.connecting || submission.busy ? "Sending..." : "Refine"}
              </Button>
            ) : (
              <div className="flex items-center">
                <Button
                  type="submit"
                  size="sm"
                  className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                  disabled={submission.busy || submission.connecting || submission.expired}
                >
                  {submission.connecting || submission.busy ? "Sending..." : "Implement"}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="sm"
                        variant="default"
                        className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                        aria-label="Implementation actions"
                        disabled={submission.busy || submission.connecting || submission.expired}
                      />
                    }
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="end" side="top">
                    <MenuItem
                      disabled={submission.busy || submission.connecting || submission.expired}
                      onClick={() => void submission.onImplementInNewThread()}
                    >
                      Implement in a new thread
                    </MenuItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              </div>
            )
          ) : (
            <>
              {voice.enabled ? (
                <ComposerVoiceButton
                  disabled={submission.connecting || submission.busy || submission.expired}
                  isRecording={voice.recording}
                  isTranscribing={voice.transcribing}
                  durationLabel={voice.durationLabel}
                  onClick={voice.onToggle}
                />
              ) : null}
              <Button
                type="submit"
                variant="prominent"
                size="icon-xs"
                className="size-7 rounded-full sm:size-7"
                disabled={
                  submission.busy ||
                  submission.connecting ||
                  submission.expired ||
                  voice.transcribing ||
                  submission.preparingImages ||
                  !submission.hasContent
                }
                aria-label={
                  submission.connecting
                    ? "Connecting"
                    : voice.transcribing
                      ? "Transcribing voice note"
                      : submission.preparingImages
                        ? "Optimizing image"
                        : submission.preparingWorktree
                          ? "Preparing worktree"
                          : submission.busy
                            ? "Sending"
                            : "Send message"
                }
              >
                {submission.connecting || submission.busy || submission.preparingImages ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 14 14"
                    fill="none"
                    className="animate-spin"
                    aria-hidden="true"
                  >
                    <circle
                      cx="7"
                      cy="7"
                      r="5.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeDasharray="20 12"
                    />
                  </svg>
                ) : (
                  <ComposerSendArrowIcon
                    aria-hidden="true"
                    className="size-5 shrink-0 translate-y-px"
                  />
                )}
              </Button>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
