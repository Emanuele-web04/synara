// Note: option rows render through the shared ComposerChoiceRow (number chip +
// label + description) so this card and the pending-approval card stay identical;
// the nav arrows stay raw <button> since they are compact icon controls. The card
// is rendered detached, floating just above the composer (not fused into the
// composer surface), so it reuses the composer surface chrome to stay in-tint.
import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => PendingUserInputDraftAnswer | null;
  onAdvance: (answerOverrides?: Record<string, PendingUserInputDraftAnswer>) => void;
  onPrevious: () => void;
  onCancel: () => void;
}

const NAV_BUTTON_CLASS_NAME =
  "flex size-5 items-center justify-center rounded-md text-[var(--color-text-foreground-tertiary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] disabled:pointer-events-none disabled:opacity-30";

// Keep pending-input choices neutral so they read like Codex list controls instead of accent buttons.
export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCancel,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onPrevious={onPrevious}
      onCancel={onCancel}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCancel,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => PendingUserInputDraftAnswer | null;
  onAdvance: (answerOverrides?: Record<string, PendingUserInputDraftAnswer>) => void;
  onPrevious: () => void;
  onCancel: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Cancel a pending auto-advance on unmount, and whenever the active question
  // changes or a response goes in flight — otherwise a manual Next/Submit landing
  // inside the 200ms window leaves a stale timer that advances or submits again.
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
  }, [activeQuestion?.id, isResponding]);

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    const nextDraftAnswer = onToggleOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current(nextDraftAnswer ? { [questionId]: nextDraftAnswer } : undefined);
    }, 200);
  });

  // Keyboard shortcut: digits toggle options for multi-select prompts and preserve
  // the current auto-advance behavior for single-select questions.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // Let digit input pass through whenever focus is inside an editable region,
      // including nested contenteditable descendants inside the composer.
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const questionCount = prompt.questions.length;
  const showNavigation = questionCount > 1;
  const canGoBack = progress.questionIndex > 0;
  const canGoForward = !progress.isLastQuestion && progress.canAdvance;

  return (
    <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] font-medium leading-snug text-foreground/90">
          {activeQuestion.question}
        </p>
        {showNavigation ? (
          <div className="flex shrink-0 items-center gap-0.5 pt-px text-muted-foreground/70">
            <button
              type="button"
              disabled={!canGoBack || isResponding}
              onClick={onPrevious}
              className={NAV_BUTTON_CLASS_NAME}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <span className="px-0.5 text-[11px] tabular-nums">
              {progress.questionIndex + 1} of {questionCount}
            </span>
            <button
              type="button"
              disabled={!canGoForward || isResponding}
              onClick={() => onAdvance()}
              className={NAV_BUTTON_CLASS_NAME}
              aria-label="Next question"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-[11px] text-muted-foreground/55">Select one or more.</p>
      ) : null}
      {activeQuestion.options.length > 0 ? (
        <div className="mt-2.5 space-y-0.5">
          {activeQuestion.options.map((option, index) => {
            const isSelected = progress.selectedOptionLabels.includes(option.label);
            const shortcutKey = index < 9 ? index + 1 : null;
            return (
              <ComposerChoiceRow
                key={`${activeQuestion.id}:${option.label}`}
                shortcut={shortcutKey}
                label={option.label}
                description={option.description}
                selected={isSelected}
                disabled={isResponding}
                onSelect={() => handleOptionSelection(activeQuestion.id, option.label)}
                trailing={
                  isSelected ? (
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-foreground)]" />
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : (
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            disabled={isResponding}
            onClick={onCancel}
            className={cn(
              "rounded-md px-2 py-1 text-[12px] text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
              isResponding && "cursor-not-allowed opacity-50",
            )}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
});
