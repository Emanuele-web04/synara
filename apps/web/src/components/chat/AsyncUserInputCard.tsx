import type { AsyncUserInput, MessageId, UserInputQuestion } from "@synara/contracts";
import { useMemo, useRef, useState } from "react";
import { CircleQuestionIcon, CheckIcon } from "~/lib/icons";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { UserInputQuestionForm } from "./UserInputQuestionForm";

export function AsyncUserInputCard({
  messageId,
  input,
  onRespond,
}: {
  messageId: MessageId;
  input: AsyncUserInput;
  onRespond?: ((messageId: MessageId, answers: readonly string[]) => Promise<void>) | undefined;
}) {
  // Native questions have no IDs. Their positions are stable within this message.
  const questions = useMemo<ReadonlyArray<UserInputQuestion>>(
    () =>
      input.questions.map((question, index) => ({
        id: `question-${index}`,
        header: "Question",
        question: question.title,
        options: (question.options ?? []).map((label) => ({ label, description: label })),
        multiSelect: false,
      })),
    [input.questions],
  );
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        {
          selectedOptionLabels: question.options[0] ? [question.options[0].label] : [],
        },
      ]),
    ),
  );
  const [open, setOpen] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submission, setSubmission] = useState<{
    answers: readonly string[];
    responseSequence: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const acceptedAnswers =
    input.response?.answers ??
    (submission?.responseSequence === (input.responseSequence ?? 0) ? submission.answers : null);
  const answered = acceptedAnswers !== null;
  const disabled = answered || submitting || !onRespond;
  const progress = derivePendingUserInputProgress(questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;

  const advance = async () => {
    if (disabled || inFlight.current || !progress.canAdvance) return;
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(questions, answers);
    if (!resolved) return;
    const response = questions.map((question) => {
      const answer = resolved[question.id]!;
      return Array.isArray(answer) ? answer.join(", ") : answer;
    });
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onRespond!(messageId, response);
      setSubmission({ answers: response, responseSequence: input.responseSequence ?? 0 });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The answer could not be submitted. Try again.",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-ui leading-snug text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <CircleQuestionIcon className="size-3.5" aria-hidden="true" />
        {questions.length} {questions.length === 1 ? "question" : "questions"}
        {answered && (
          <>
            <CheckIcon className="size-3" aria-hidden="true" />
            <span>Answered</span>
          </>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2">
          {acceptedAnswers ? (
            <dl className="space-y-3 rounded-xl border border-border p-3.5 text-ui leading-snug">
              {questions.map((question, index) => (
                <div key={question.id}>
                  <dt className="font-medium">{question.question}</dt>
                  <dd className="whitespace-pre-wrap text-muted-foreground">
                    {acceptedAnswers[index]}
                  </dd>
                </div>
              ))}
            </dl>
          ) : activeQuestion ? (
            <form
              aria-label="Questions from Codex"
              onSubmit={(event) => {
                event.preventDefault();
                void advance();
              }}
            >
              <UserInputQuestionForm
                questions={questions}
                answers={answers}
                questionIndex={questionIndex}
                submissionVersion={0}
                isResponding={disabled}
                autoAdvance={false}
                keyboardShortcuts="local"
                onToggleOption={(questionId, label) => {
                  const draft = togglePendingUserInputOptionSelection(
                    activeQuestion,
                    answers[questionId],
                    label,
                  );
                  setAnswers((current) => ({ ...current, [questionId]: draft }));
                  return draft;
                }}
                onAdvance={() => void advance()}
                onPrevious={() => setQuestionIndex(Math.max(0, questionIndex - 1))}
              >
                <div className="mt-3 space-y-2">
                  <Textarea
                    aria-label={`Answer: ${activeQuestion.question}`}
                    value={progress.customAnswer}
                    disabled={disabled}
                    rows={2}
                    placeholder={
                      activeQuestion.options.length > 0
                        ? "Or type your own answer…"
                        : "Type your answer…"
                    }
                    onChange={(event) => {
                      const draft = setPendingUserInputCustomAnswer(
                        answers[activeQuestion.id],
                        event.target.value,
                      );
                      setAnswers((current) => ({ ...current, [activeQuestion.id]: draft }));
                    }}
                  />
                  {error && (
                    <p role="alert" className="text-ui leading-snug text-destructive">
                      {error}
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ui leading-snug text-muted-foreground">
                      Codex can keep working
                    </span>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        disabled ||
                        !progress.canAdvance ||
                        (progress.isLastQuestion && !progress.isComplete)
                      }
                    >
                      {submitting
                        ? "Submitting…"
                        : progress.isLastQuestion
                          ? "Send answer"
                          : "Next"}
                    </Button>
                  </div>
                </div>
              </UserInputQuestionForm>
            </form>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
