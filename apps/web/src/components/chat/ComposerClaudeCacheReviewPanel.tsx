import type { PendingClaudeCacheReview } from "@synara/contracts";
import { useRef, useState } from "react";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

export type ClaudeCacheReviewDecision = "continue" | "compact" | "cancel";

export function ComposerClaudeCacheReviewPanel({
  review,
  compactDisabledReason,
  onRespond,
}: {
  review: PendingClaudeCacheReview;
  compactDisabledReason: string | null;
  onRespond: (
    review: PendingClaudeCacheReview,
    decision: ClaudeCacheReviewDecision,
  ) => Promise<void>;
}) {
  const submittedReviewRef = useRef<PendingClaudeCacheReview | null>(null);
  const [submittedReview, setSubmittedReview] = useState<PendingClaudeCacheReview | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const actionable = review.status === "pending" || review.status === "failed";
  const disabled = !actionable || submittedReview === review;
  const contextTokens = review.assessment.contextTokens;
  const title =
    review.status === "compacting"
      ? "Compacting before sending"
      : review.status === "responding"
        ? "Resuming your saved message"
        : review.status === "uncertain"
          ? "Checking the pending request"
          : "Claude's prompt cache likely expired";

  const respondOnce = (decision: ClaudeCacheReviewDecision) => {
    if (disabled || submittedReviewRef.current === review) return;
    if (decision === "compact" && compactDisabledReason !== null) return;
    submittedReviewRef.current = review;
    setSubmittedReview(review);
    setDispatchError(null);
    void onRespond(review, decision).catch((error: unknown) => {
      if (submittedReviewRef.current !== review) return;
      submittedReviewRef.current = null;
      setSubmittedReview(null);
      setDispatchError(
        error instanceof Error ? error.message : "Could not submit this choice. Try again.",
      );
    });
  };

  return (
    <section
      aria-label="Claude cache review"
      aria-busy={
        review.status === "responding" ||
        review.status === "compacting" ||
        submittedReview === review
      }
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
    >
      <p className="text-[13px] font-medium leading-snug text-foreground/90">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {review.status === "uncertain"
          ? "Claude may have accepted the request. Sending is paused until its status can be confirmed."
          : review.status === "compacting"
            ? "Your message stays on hold until Claude confirms that compaction has finished."
            : review.status === "responding"
              ? "Waiting for Claude to accept the saved message."
              : `Your message is saved and on hold. Continuing may reprocess ${contextTokens === undefined ? "the conversation's context" : `about ${formatContextWindowTokens(contextTokens)} tokens`}.`}
      </p>
      {actionable ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Compacting also reads the expired context once, then uses a summary for later turns. It
          can consume usage and is not a free cache refresh.
        </p>
      ) : null}
      {review.error || dispatchError ? (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
          {dispatchError ?? review.error}
        </p>
      ) : null}
      <div className="mt-2.5 space-y-0.5">
        <ComposerChoiceRow
          shortcut={null}
          label="Continue with full context"
          description="Send the saved message with the existing history"
          disabled={disabled}
          onSelect={() => respondOnce("continue")}
        />
        <ComposerChoiceRow
          shortcut={null}
          label="Compact, then send"
          description={
            compactDisabledReason ?? "Summarize this conversation before sending the saved message"
          }
          disabled={disabled || compactDisabledReason !== null}
          onSelect={() => respondOnce("compact")}
        />
        <ComposerChoiceRow
          shortcut={null}
          label="Cancel this send"
          description="Keep this conversation without sending the held message"
          disabled={disabled}
          onSelect={() => respondOnce("cancel")}
        />
      </div>
    </section>
  );
}
