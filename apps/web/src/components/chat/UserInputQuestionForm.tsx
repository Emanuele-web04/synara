import type { UserInputQuestion } from "@synara/contracts";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

const NAV_BUTTON_CLASS_NAME =
  "flex size-5 items-center justify-center rounded-md text-[var(--color-text-foreground-tertiary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] disabled:pointer-events-none disabled:opacity-30";

export function UserInputQuestionForm({
  questions,
  submissionVersion,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCancel,
  autoAdvance = true,
  keyboardShortcuts = "global",
  children,
}: {
  questions: ReadonlyArray<UserInputQuestion>;
  submissionVersion: number;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => PendingUserInputDraftAnswer | null;
  onAdvance: (answerOverrides?: Record<string, PendingUserInputDraftAnswer>) => void;
  onPrevious: () => void;
  onCancel?: () => void;
  autoAdvance?: boolean;
  keyboardShortcuts?: "global" | "local";
  children?: ReactNode;
}) {
  const progress = derivePendingUserInputProgress(questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const selectedOptionLabelSet = new Set(progress.selectedOptionLabels);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Cancel a pending auto-advance on unmount, and whenever the active question
  // changes or a response is attempted. The version also catches immediate
  // failures whose true/false loading state React batches into a single render.
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
  }, [activeQuestion?.id, isResponding, submissionVersion]);

  const handleOptionSelection = (questionId: string, optionLabel: string) => {
    const nextDraftAnswer = onToggleOption(questionId, optionLabel);
    if (!autoAdvance || activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current(nextDraftAnswer ? { [questionId]: nextDraftAnswer } : undefined);
    }, 200);
  };
  const handleCancel = () => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    onCancel?.();
  };
  const handleShortcut = (
    event: Pick<
      KeyboardEvent,
      "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "preventDefault" | "stopPropagation"
    >,
  ) => {
    // Consume digit shortcuts even when this form has no matching option or is
    // submitting; another prompt's global listener must not handle them.
    if (keyboardShortcuts === "local" && /^[1-9]$/.test(event.key)) event.stopPropagation();
    if (!activeQuestion || isResponding || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
    )
      return;
    const digit = Number.parseInt(event.key, 10);
    const option = digit >= 1 && digit <= 9 ? activeQuestion.options[digit - 1] : undefined;
    if (!option) return;
    event.preventDefault();
    handleOptionSelection(activeQuestion.id, option.label);
  };
  const handleEffectShortcut = useEffectEvent(handleShortcut);

  // Blocking composer prompts keep global shortcuts. Inline forms only respond
  // to keys inside themselves, so multiple open questions cannot answer each other.
  useEffect(() => {
    if (keyboardShortcuts !== "global" || !activeQuestion || isResponding) return;
    const handler = (event: KeyboardEvent) => handleEffectShortcut(event);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, keyboardShortcuts]);

  if (!activeQuestion) {
    return null;
  }

  const questionCount = questions.length;
  const showNavigation = questionCount > 1;
  const canGoBack = progress.questionIndex > 0;
  const canGoForward = !progress.isLastQuestion && progress.canAdvance;

  return (
    <div
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
      onKeyDown={keyboardShortcuts === "local" ? handleShortcut : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-ui-lg font-medium leading-snug text-foreground/90">
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
            <span className="px-0.5 text-ui-sm tabular-nums">
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
        <p className="mt-1 text-ui-sm text-muted-foreground/55">Select one or more.</p>
      ) : null}
      {activeQuestion.options.length > 0 ? (
        <div className="mt-2.5 space-y-0.5">
          {activeQuestion.options.map((option, index) => {
            const isSelected = selectedOptionLabelSet.has(option.label);
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
      ) : null}
      {onCancel ? (
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            disabled={isResponding}
            onClick={handleCancel}
            className={cn(
              "rounded-md px-2 py-1 text-ui text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
              isResponding && "cursor-not-allowed opacity-50",
            )}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
