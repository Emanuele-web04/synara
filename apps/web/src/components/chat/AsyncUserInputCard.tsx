import { useId, useRef, useState } from "react";
import type { AsyncUserInputResponse } from "@synara/contracts";
import type { AsyncUserInputActivity } from "@synara/shared/asyncUserInput";
import { CheckIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

export type RespondToAsyncUserInput = (response: AsyncUserInputResponse) => Promise<void>;

interface AsyncUserInputCardProps {
  activity: AsyncUserInputActivity;
  onRespond?: RespondToAsyncUserInput;
}

export function AsyncUserInputCard({ activity, onRespond }: AsyncUserInputCardProps) {
  const id = useId();
  const { questions, response } = activity.payload;
  const [choices, setChoices] = useState(() =>
    questions.map((question) => question.options?.[0] ?? ""),
  );
  const [drafts, setDrafts] = useState(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [submission, setSubmission] = useState<{
    payload: AsyncUserInputActivity["payload"];
    answers: readonly string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Any authoritative payload update supersedes the local submission, including
  // rollback delivered before React has rendered the intermediate answered state.
  const answered =
    response?.answers ?? (submission?.payload === activity.payload ? submission.answers : null);
  const answers = questions.map((_, index) => drafts[index]?.trim() || choices[index] || "");

  async function submit() {
    if (!onRespond || answered || inFlight.current || answers.some((answer) => !answer)) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onRespond({ activityId: activity.id, answers });
      setSubmission({ payload: activity.payload, answers });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit your answer. Try again.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form
      className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} space-y-4 p-4`}
      aria-label="Question from Codex"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {answered ? <CheckIcon className="size-3.5" /> : null}
        {answered ? "Answer submitted" : "Reply when you’re ready"}
      </p>
      {questions.map((question, index) => (
        <fieldset key={index} disabled={submitting || !onRespond} className="min-w-0 space-y-2">
          <legend className="mb-2 whitespace-pre-wrap text-[13px] font-medium text-foreground/90">
            {question.title}
          </legend>
          {answered ? (
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {answered[index]}
            </p>
          ) : (
            <>
              {question.options?.map((option, optionIndex) => (
                <ComposerChoiceRow
                  key={optionIndex}
                  shortcut={null}
                  label={option}
                  selected={!drafts[index]?.trim() && choices[index] === option}
                  onSelect={() => {
                    setChoices((previous) =>
                      previous.map((value, i) => (i === index ? option : value)),
                    );
                    setDrafts((previous) => previous.map((value, i) => (i === index ? "" : value)));
                  }}
                  trailing={
                    !drafts[index]?.trim() && choices[index] === option ? (
                      <CheckIcon className="size-3.5 shrink-0" />
                    ) : null
                  }
                />
              ))}
              <label htmlFor={`${id}-${index}`} className="block text-xs text-muted-foreground">
                {question.options?.length ? "Or write your own answer" : "Your answer"}
              </label>
              <textarea
                id={`${id}-${index}`}
                value={drafts[index] ?? ""}
                onChange={(event) => {
                  const text = event.target.value;
                  setDrafts((previous) => previous.map((value, i) => (i === index ? text : value)));
                }}
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </>
          )}
        </fieldset>
      ))}
      {error && !answered ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!answered ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={!onRespond || submitting || answers.some((answer) => !answer)}
          >
            {submitting ? "Submitting…" : "Submit answer"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
