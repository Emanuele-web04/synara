import type { UserInputQuestion } from "@synara/contracts";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import {
  derivePendingUserInputProgress,
  splitRecommendedOptionLabel,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { useTranslation } from "~/i18n";

/** Key hint chip in the card footer, sized to the hint text beside it. */
const HINT_KBD_CLASS_NAME = "h-4 min-w-4 rounded-[4px] px-1 text-ui-xs font-normal leading-none";

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
  const { t } = useTranslation();

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
  const shortcutCount = Math.min(activeQuestion.options.length, 9);
  // Digit and Enter hints only hold for the composer-docked card: Enter submits through the
  // composer below it. Inline cards bring their own submit control.
  const showKeyHints = keyboardShortcuts === "global" && shortcutCount > 0;

  return (
    <div
      // Card padding plus each row's own px-2.5 put the question, number chips, footer and the
      // composer's text on one left edge.
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-1.5 pt-3 pb-1.5")}
      onKeyDown={keyboardShortcuts === "local" ? handleShortcut : undefined}
    >
      <div className="flex items-start justify-between gap-3 px-2.5">
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
              aria-label={t("chat:composerPendingUserInputPanel_previousQuestion")}
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <span className="px-0.5 text-ui-sm tabular-nums">
              {progress.questionIndex + 1} {t("onboarding:of")} {questionCount}
            </span>
            <button
              type="button"
              disabled={!canGoForward || isResponding}
              onClick={() => onAdvance()}
              className={NAV_BUTTON_CLASS_NAME}
              aria-label={t("chat:composerPendingUserInputPanel_nextQuestion")}
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 px-2.5 text-ui-sm text-muted-foreground/55">
          {t("chat:composerPendingUserInputPanel_selectOneOrMore")}
        </p>
      ) : null}
      {activeQuestion.options.length > 0 ? (
        <div className="mt-2 space-y-px">
          {activeQuestion.options.map((option, index) => {
            const isSelected = selectedOptionLabelSet.has(option.label);
            const shortcutKey = index < 9 ? index + 1 : null;
            const display = splitRecommendedOptionLabel(option.label);
            return (
              <ComposerChoiceRow
                key={`${activeQuestion.id}:${option.label}`}
                layout="stacked"
                shortcut={shortcutKey}
                label={display.label}
                description={option.description}
                badge={
                  display.recommended ? (
                    <Badge variant="info" size="sm">
                      {t("chat:recommended")}
                    </Badge>
                  ) : null
                }
                selected={isSelected}
                disabled={isResponding}
                onSelect={() => handleOptionSelection(activeQuestion.id, option.label)}
                trailing={
                  <span className="flex h-5 w-3.5 shrink-0 items-center">
                    {isSelected ? (
                      <CheckIcon className="size-3.5 text-[var(--color-text-foreground)]" />
                    ) : null}
                  </span>
                }
              />
            );
          })}
        </div>
      ) : null}
      {showKeyHints || onCancel ? (
        <div className="mt-1.5 flex min-h-7 items-center gap-3 pl-2.5">
          {showKeyHints ? (
            <div
              aria-hidden="true"
              className="flex min-w-0 flex-1 items-center gap-3 text-ui-xs text-muted-foreground/70"
            >
              <span className="flex items-center gap-1">
                <Kbd className={HINT_KBD_CLASS_NAME}>
                  {shortcutCount === 1 ? "1" : `1–${shortcutCount}`}
                </Kbd>
                {t("chat:composerPendingUserInputPanel_pickHint")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd className={HINT_KBD_CLASS_NAME}>↵</Kbd>
                {progress.isLastQuestion
                  ? t("chat:composerPendingUserInputPanel_submitHint")
                  : t("chat:composerPendingUserInputPanel_nextHint")}
              </span>
            </div>
          ) : null}
          {onCancel ? (
            <button
              type="button"
              disabled={isResponding}
              onClick={handleCancel}
              className={cn(
                "ml-auto rounded-md px-2 py-1 text-ui text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
                isResponding && "cursor-not-allowed opacity-50",
              )}
            >
              {t("common:form_cancel")}
            </button>
          ) : null}
        </div>
      ) : null}
      {children ? <div className="px-2.5 pb-1.5">{children}</div> : null}
    </div>
  );
}
