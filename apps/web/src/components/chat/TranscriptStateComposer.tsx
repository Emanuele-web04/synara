import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";

import {
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";
import {
  EMPTY_USER_INPUT_REQUEST_IDS,
  LAB_APPROVAL_REQUEST_ID,
  LAB_PENDING_APPROVAL,
  LAB_PENDING_USER_INPUT,
  LAB_PENDING_USER_INPUTS,
  RESPONDING_USER_INPUT_REQUEST_IDS,
} from "./TranscriptStateComposer.fixtures";
import {
  composerActionDisabled,
  composerActionLabel,
  composerModeForScenario,
  composerPlaceholderForState,
  composerStatusLabel,
} from "./TranscriptStateComposer.logic";
import { TranscriptStateComposerStatus } from "./TranscriptStateComposerStatus";
import { TranscriptStateReadyComposer } from "./TranscriptStateReadyComposer";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

interface TranscriptStateComposerProps {
  readonly state: TranscriptScenarioState;
  readonly className?: string;
}

export function TranscriptStateComposer({ state, className }: TranscriptStateComposerProps): ReactElement {
  const mode = composerModeForScenario(state);
  const [approvalDecision, setApprovalDecision] = useState<ProviderApprovalDecision | null>(null);
  const [userInputAnswers, setUserInputAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});
  const [userInputQuestionIndex, setUserInputQuestionIndex] = useState(0);
  const [userInputSubmitted, setUserInputSubmitted] = useState(false);

  const userInputProgress = useMemo(
    () =>
      derivePendingUserInputProgress(
        LAB_PENDING_USER_INPUT.questions,
        userInputAnswers,
        userInputQuestionIndex,
      ),
    [userInputAnswers, userInputQuestionIndex],
  );

  const activeQuestion = userInputProgress.activeQuestion;
  const activeQuestionId = activeQuestion?.id ?? null;
  const activeCustomAnswer = userInputProgress.customAnswer;
  const statusLabel = composerStatusLabel(mode, state, approvalDecision, userInputSubmitted);
  const userInputSubmitDisabled =
    userInputSubmitted ||
    (userInputProgress.isLastQuestion ? !userInputProgress.isComplete : !userInputProgress.canAdvance);
  const userInputSubmitLabel = userInputSubmitted ? "Submitting..." : userInputProgress.isLastQuestion ? "Submit answers" : "Next question";

  const onRespondToApproval = useCallback(
    async (_requestId: ApprovalRequestId, decision: ProviderApprovalDecision): Promise<void> => {
      setApprovalDecision(decision);
    },
    [],
  );

  const onToggleUserInputOption = useCallback(
    (questionId: string, optionLabel: string): PendingUserInputDraftAnswer | null => {
      const question = LAB_PENDING_USER_INPUT.questions.find((entry) => entry.id === questionId);
      if (!question) return null;

      const nextAnswer = togglePendingUserInputOptionSelection(
        question,
        userInputAnswers[questionId],
        optionLabel,
      );
      setUserInputAnswers((existing) => ({ ...existing, [questionId]: nextAnswer }));
      setUserInputSubmitted(false);
      return nextAnswer;
    },
    [userInputAnswers],
  );

  const onAdvanceUserInput = useCallback(
    (answerOverrides?: Record<string, PendingUserInputDraftAnswer>): void => {
      const nextAnswers = { ...userInputAnswers, ...answerOverrides };
      const nextProgress = derivePendingUserInputProgress(
        LAB_PENDING_USER_INPUT.questions,
        nextAnswers,
        userInputQuestionIndex,
      );

      setUserInputAnswers(nextAnswers);
      if (!nextProgress.canAdvance) return;
      if (nextProgress.isLastQuestion) {
        setUserInputSubmitted(true);
        return;
      }

      setUserInputQuestionIndex(nextProgress.questionIndex + 1);
    },
    [userInputAnswers, userInputQuestionIndex],
  );

  const onCancelUserInput = useCallback((): void => {
    setUserInputAnswers({});
    setUserInputQuestionIndex(0);
    setUserInputSubmitted(false);
  }, []);

  const onPreviousUserInputQuestion = useCallback((): void => {
    setUserInputQuestionIndex((existing) => Math.max(0, existing - 1));
    setUserInputSubmitted(false);
  }, []);

  const onCustomAnswerChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      if (!activeQuestionId) return;
      const customAnswer = event.currentTarget.value;
      setUserInputAnswers((existing) => ({
        ...existing,
        [activeQuestionId]: setPendingUserInputCustomAnswer(
          existing[activeQuestionId],
          customAnswer,
        ),
      }));
      setUserInputSubmitted(false);
    },
    [activeQuestionId],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (mode === "user-input") {
        onAdvanceUserInput();
      }
    },
    [mode, onAdvanceUserInput],
  );

  if (mode === "ready") {
    return <TranscriptStateReadyComposer key={state.scenario.id} state={state} className={className} />;
  }

  return (
    <form
      className={cn("mx-auto w-full max-w-[46rem]", className)}
      aria-label="Transcript lab composer"
      onSubmit={onSubmit}
    >
      <div className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, "overflow-hidden")}>
        <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden")}>
          {mode === "approval" ? (
            <div className={COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME}>
              <ComposerPendingApprovalPanel approval={LAB_PENDING_APPROVAL} pendingCount={1} />
            </div>
          ) : null}
          {mode === "user-input" ? (
            <div className={COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME}>
              <ComposerPendingUserInputPanel
                pendingUserInputs={LAB_PENDING_USER_INPUTS}
                respondingRequestIds={
                  userInputSubmitted
                    ? RESPONDING_USER_INPUT_REQUEST_IDS
                    : EMPTY_USER_INPUT_REQUEST_IDS
                }
                answers={userInputAnswers}
                questionIndex={userInputQuestionIndex}
                onToggleOption={onToggleUserInputOption}
                onAdvance={onAdvanceUserInput}
                onCancel={onCancelUserInput}
              />
            </div>
          ) : null}
          <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
            {mode === "user-input" ? (
              <>
                <label className="sr-only" htmlFor="transcript-lab-user-input-answer">
                  Optional custom answer
                </label>
                <textarea
                  id="transcript-lab-user-input-answer"
                  value={activeCustomAnswer}
                  disabled={userInputSubmitted}
                  rows={2}
                  className={cn(
                    "block w-full resize-none border-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted-foreground/40 disabled:cursor-not-allowed disabled:opacity-55",
                    COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                  )}
                  placeholder="Type your own answer, or leave this blank to use the selected option"
                  onChange={onCustomAnswerChange}
                />
              </>
            ) : (
              <div
                role="textbox"
                aria-disabled="true"
                aria-readonly="true"
                className={cn(
                  "min-h-[2lh] select-none",
                  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                  mode === "error" ? "text-foreground/80" : COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
                )}
              >
                {composerPlaceholderForState(mode, state)}
              </div>
            )}
          </div>
          {mode === "approval" ? (
            <div className={cn(COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME, "flex-wrap")}>
              <ComposerPendingApprovalActions
                requestId={LAB_APPROVAL_REQUEST_ID}
                isResponding={false}
                describedById={`pending-approval-status-${LAB_APPROVAL_REQUEST_ID}`}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : mode === "user-input" ? (
            <div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-2")}>
              <TranscriptStateComposerStatus label={statusLabel} />
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {userInputProgress.questionIndex > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    disabled={userInputSubmitted}
                    onClick={onPreviousUserInputQuestion}
                  >
                    Previous
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  disabled={userInputSubmitted}
                  onClick={onCancelUserInput}
                >
                  Reset
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="rounded-full px-4"
                  disabled={userInputSubmitDisabled}
                >
                  {userInputSubmitLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-2")}>
              <TranscriptStateComposerStatus label={statusLabel} />
              <Button
                type="button"
                size="sm"
                variant={mode === "error" ? "outline" : "ghost"}
                className="rounded-full px-4"
                disabled={composerActionDisabled(mode)}
              >
                {composerActionLabel(mode, state)}
              </Button>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
