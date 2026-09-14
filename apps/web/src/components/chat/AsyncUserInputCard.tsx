/* oxlint-disable no-array-index-key -- Native questions have no IDs; their positions are immutable within this message. */
import type { AsyncUserInput, MessageId } from "@synara/contracts";
import { useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function AsyncUserInputCard({
  messageId,
  input,
  onRespond,
}: {
  messageId: MessageId;
  input: AsyncUserInput;
  onRespond?: ((messageId: MessageId, answers: readonly string[]) => Promise<void>) | undefined;
}) {
  const formId = useId();
  const [answers, setAnswers] = useState(() =>
    input.questions.map((question) => question.options?.[0] ?? ""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const answered = Boolean(input.response) || submitted;
  const disabled = answered || submitting || !onRespond;

  return (
    <form
      aria-label="Questions from Codex"
      className="my-2 space-y-4 rounded-xl border border-border bg-card p-4 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || inFlight.current || answers.some((answer) => !answer.trim())) return;
        inFlight.current = true;
        setSubmitting(true);
        setError(null);
        try {
          await onRespond!(
            messageId,
            answers.map((answer) => answer.trim()),
          );
          setSubmitted(true);
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The answer could not be submitted. Try again.",
          );
        } finally {
          inFlight.current = false;
          setSubmitting(false);
        }
      }}
    >
      <div className="text-xs text-muted-foreground">
        {answered ? "Answered" : "Reply when ready · Codex can keep working"}
      </div>
      {input.questions.map((question, index) => (
        <fieldset
          key={`${index}:${question.title}`}
          disabled={disabled}
          className="min-w-0 space-y-2"
        >
          <legend className="mb-2 font-medium text-foreground">{question.title}</legend>
          {answered ? (
            <p className="whitespace-pre-wrap text-muted-foreground">
              {input.response?.answers[index] ?? answers[index]}
            </p>
          ) : (
            <>
              {question.options && (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option, optionIndex) => (
                    <Button
                      key={`${optionIndex}:${option}`}
                      type="button"
                      variant={answers[index] === option ? "secondary" : "outline"}
                      size="sm"
                      aria-pressed={answers[index] === option}
                      className="h-auto max-w-full whitespace-normal text-left"
                      onClick={() =>
                        setAnswers((current) =>
                          current.map((answer, i) => (i === index ? option : answer)),
                        )
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <label htmlFor={`${formId}-${index}`} className="sr-only">
                Answer: {question.title}
              </label>
              <Textarea
                id={`${formId}-${index}`}
                value={answers[index] ?? ""}
                rows={2}
                placeholder="Type your answer…"
                className="resize-y"
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((answer, i) => (i === index ? event.target.value : answer)),
                  )
                }
              />
            </>
          )}
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!answered && (
        <Button
          type="submit"
          size="sm"
          disabled={disabled || answers.some((answer) => !answer.trim())}
        >
          {submitting ? "Submitting…" : "Send answer"}
        </Button>
      )}
    </form>
  );
}
