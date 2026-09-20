import type { PendingClaudeCacheReview } from "@synara/contracts";
import { useRef, useState } from "react";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

export type ClaudeCacheReviewDecision = "continue" | "compact" | "cancel";

// An accepted choice is already visible in the transcript (compaction progress
// or the resumed turn), so the panel only returns if the review fails.
export function isClaudeCacheReviewPanelVisible(review: PendingClaudeCacheReview): boolean {
  return review.status !== "responding" && review.status !== "compacting";
}

export function ComposerClaudeCacheReviewPanel({
  review,
  compactDisabledReason,
  isCompactionRequest = false,
  onRespond,
}: {
  review: PendingClaudeCacheReview;
  compactDisabledReason: string | null;
  isCompactionRequest?: boolean;
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
    review.status === "uncertain"
      ? "Request status is uncertain"
      : isCompactionRequest
        ? "Compaction will read the expired context"
        : "Claude's prompt cache likely expired";

  const respondOnce = (decision: ClaudeCacheReviewDecision) => {
    if (disabled || submittedReviewRef.current === review) return;
    if (decision === "compact" && (compactDisabledReason !== null || isCompactionRequest)) return;
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

  if (!isClaudeCacheReviewPanelVisible(review)) return null;

  return (
    <section
      aria-label="Claude cache review"
      aria-busy={submittedReview === review}
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
    >
      <p className="text-ui-lg font-medium leading-snug text-foreground/90">{title}</p>
      <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
        {review.status === "uncertain"
          ? "Claude may have accepted the request. Sending is paused until its status can be confirmed."
          : `Your message is saved and on hold. Continuing may reprocess ${contextTokens === undefined ? "the conversation's context" : `about ${formatContextWindowTokens(contextTokens)} tokens`}.`}
      </p>
      {actionable ? (
        <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
          Compacting also processes the full history once. Later requests use its summary.
        </p>
      ) : null}
      {review.error || dispatchError ? (
        <p role="alert" className="mt-2 text-ui leading-relaxed text-destructive">
          {dispatchError ?? review.error}
        </p>
      ) : null}
      <div className="mt-2.5 space-y-0.5">
        <ComposerChoiceRow
          shortcut={null}
          label={isCompactionRequest ? "Compact this conversation" : "Continue with full context"}
          description={
            isCompactionRequest
              ? "Process the existing history and save its summary"
              : "Send the saved message with the existing history"
          }
          disabled={disabled}
          onSelect={() => respondOnce("continue")}
        />
        {!isCompactionRequest ? (
          <ComposerChoiceRow
            shortcut={null}
            label="Compact, then send"
            description={
              compactDisabledReason ??
              "Summarize this conversation before sending the saved message"
            }
            disabled={disabled || compactDisabledReason !== null}
            onSelect={() => respondOnce("compact")}
          />
        ) : null}
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
