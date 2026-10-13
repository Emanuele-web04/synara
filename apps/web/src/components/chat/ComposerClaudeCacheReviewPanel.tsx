import type { PendingClaudeCacheReview } from "@synara/contracts";
import { assessClaudeCache } from "@synara/shared/claudeCache";
import { useEffect, useRef, useState } from "react";
import { DiagnosticReportAction } from "../DiagnosticReportAction";
import { diagnosticIssueReason, reportHandledIssue } from "~/lib/rendererErrorDiagnostics";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { formatCacheDuration } from "./ClaudeCacheDetails";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { useTranslation } from "~/i18n";

// "never" continues like "continue" and turns the review off, as Claude Code's
// "Don't ask me again" does.
export type ClaudeCacheReviewDecision = "continue" | "compact" | "cancel" | "never";

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
  const { t } = useTranslation();

  const submittedReviewRef = useRef<PendingClaudeCacheReview | null>(null);
  const [submittedReview, setSubmittedReview] = useState<PendingClaudeCacheReview | null>(null);
  const reportGenerationRef = useRef(0);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<{ reviewId: string; id: string } | null>(null);
  useEffect(() => {
    if (review.status !== "failed" && review.status !== "uncertain") return;
    let disposed = false;
    const generation = reportGenerationRef.current;
    void reportHandledIssue({
      code: review.status === "failed" ? "claude.cache.failed" : "claude.cache.uncertain",
      reason: diagnosticIssueReason(review.error),
    }).then((id) => {
      if (!disposed && id && reportGenerationRef.current === generation)
        setDiagnostic({ reviewId: review.reviewId, id });
    });
    return () => {
      disposed = true;
    };
  }, [review.reviewId, review.status, review.error]);
  const actionable = review.status === "pending" || review.status === "failed";
  const disabled = !actionable || submittedReview === review;
  const contextTokens = review.assessment.contextTokens;
  // Idle time when the message was held, so the wording stays stable.
  const idleSeconds = assessClaudeCache(
    review.assessment,
    Date.parse(review.createdAt),
  ).idleSeconds;
  // Claude Code's resume prompt wording, so both apps ask the same way.
  const title =
    review.status === "uncertain"
      ? t("Request status is uncertain")
      : isCompactionRequest
        ? t("Compaction will read the expired context")
        : idleSeconds !== undefined && contextTokens !== undefined
          ? t("This session is {{value0}} old and {{value1}} tokens.", {
              value0: formatCacheDuration(idleSeconds),
              value1: formatContextWindowTokens(contextTokens),
            })
          : t("Claude's prompt cache likely expired");

  const respondOnce = (decision: ClaudeCacheReviewDecision) => {
    if (disabled || submittedReviewRef.current === review) return;
    if (decision === "compact" && (compactDisabledReason !== null || isCompactionRequest)) return;
    submittedReviewRef.current = review;
    setSubmittedReview(review);
    setDispatchError(null);
    setDiagnostic(null);
    const generation = ++reportGenerationRef.current;
    const startedAt = performance.now();
    void onRespond(review, decision).catch((error: unknown) => {
      if (submittedReviewRef.current !== review) return;
      submittedReviewRef.current = null;
      setSubmittedReview(null);
      setDispatchError(
        error instanceof Error ? error.message : t("Could not submit this choice. Try again."),
      );
      void reportHandledIssue({
        code: "claude.cache.request-failed",
        reason: diagnosticIssueReason(error),
        durationMs: performance.now() - startedAt,
      }).then((id) => {
        if (id && reportGenerationRef.current === generation)
          setDiagnostic({ reviewId: review.reviewId, id });
      });
    });
  };

  if (!isClaudeCacheReviewPanelVisible(review)) return null;

  return (
    <section
      aria-label={t("Claude cache review")}
      aria-busy={submittedReview === review}
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
    >
      <p className="text-ui-lg font-medium leading-snug text-foreground/90">{title}</p>
      <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
        {review.status === "uncertain"
          ? t(
              "Claude may have accepted the request. Sending is paused until its status can be confirmed.",
            )
          : isCompactionRequest
            ? t("Your message is saved and on hold. Continuing may reprocess {{value0}}.", {
                value0:
                  contextTokens === undefined
                    ? t("the conversation's context")
                    : `about ${formatContextWindowTokens(contextTokens)} tokens`,
              })
            : t(
                "Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary. Your message is saved until you choose.",
              )}
      </p>
      {review.error || dispatchError ? (
        <p role="alert" className="mt-2 text-ui leading-relaxed text-destructive">
          {dispatchError ?? review.error}
        </p>
      ) : null}
      {diagnostic?.reviewId === review.reviewId &&
      (dispatchError || review.status === "failed" || review.status === "uncertain") ? (
        <DiagnosticReportAction key={diagnostic.id} id={diagnostic.id} />
      ) : null}
      <div className="mt-2.5 space-y-0.5">
        {isCompactionRequest ? (
          <ComposerChoiceRow
            shortcut={null}
            label={t("Compact this conversation")}
            description={t("Process the existing history and save its summary")}
            disabled={disabled}
            onSelect={() => respondOnce("continue")}
          />
        ) : (
          <>
            <ComposerChoiceRow
              shortcut={null}
              label={t("Resume from summary (recommended)")}
              tone="primary"
              description={
                compactDisabledReason ?? t("Summarize this session, then send your message")
              }
              disabled={disabled || compactDisabledReason !== null}
              onSelect={() => respondOnce("compact")}
            />
            <ComposerChoiceRow
              shortcut={null}
              label={t("Resume full session as-is")}
              description={t("Send your message with the full history")}
              disabled={disabled}
              onSelect={() => respondOnce("continue")}
            />
            <ComposerChoiceRow
              shortcut={null}
              label={t("Don't ask me again")}
              description={t(
                "Resume as-is now and stop asking. Turn it back on in Settings → Providers",
              )}
              disabled={disabled}
              onSelect={() => respondOnce("never")}
            />
          </>
        )}
        <ComposerChoiceRow
          shortcut={null}
          label={t("Cancel this send")}
          description={t("Keep your message without sending it")}
          disabled={disabled}
          onSelect={() => respondOnce("cancel")}
        />
      </div>
    </section>
  );
}
