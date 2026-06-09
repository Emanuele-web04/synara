import type {
  ReviewInlineComment,
  ReviewSubmitEvent,
  ReviewSubmitResult,
  ReviewTargetKey,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { CircleCheckIcon, GitPullRequestIcon, Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import {
  clearSubmittedReviewComments,
  reviewListCommentsQueryOptions,
  reviewLoadRemoteThreadsQueryOptions,
  reviewQueryKeys,
  reviewSubmitMutationOptions,
} from "~/lib/reviewReactQuery";
import { cn } from "~/lib/utils";
import { reviewTargetKeyString } from "~/reviewStore.logic";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ReviewPill, reviewTextareaClassName } from "./reviewPrimitives";

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "success"; result: ReviewSubmitResult; cleanupError?: string }
  | { kind: "error"; message: string };

const EVENT_OPTIONS: ReadonlyArray<{ value: ReviewSubmitEvent; label: string; hint: string }> = [
  { value: "comment", label: "Comment", hint: "Leave feedback without an explicit decision." },
  { value: "approve", label: "Approve", hint: "Approve the changes." },
  { value: "request_changes", label: "Request changes", hint: "Block until updates are made." },
];

export function ReviewSubmitBar(props: {
  mode: "header" | "page" | "dock";
  cwd: string | null;
  reference: string | null;
  target: ReviewTargetKey | null;
  expectedHeadSha?: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<ReviewSubmitEvent>("comment");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });

  const isPullRequest = props.target?._tag === "pullRequest";
  const canSubmit = isPullRequest && props.cwd !== null && props.reference !== null;
  const currentSubmitKey =
    props.target && props.cwd !== null && props.reference !== null
      ? `${props.cwd}:${props.reference}:${props.expectedHeadSha ?? ""}:${reviewTargetKeyString(props.target)}`
      : null;
  const currentSubmitKeyRef = useRef(currentSubmitKey);
  currentSubmitKeyRef.current = currentSubmitKey;

  const commentsQuery = useQuery(reviewListCommentsQueryOptions({ target: props.target }));
  const remoteThreadsQuery = useQuery(
    reviewLoadRemoteThreadsQueryOptions({
      cwd: isPullRequest ? props.cwd : null,
      reference: isPullRequest ? props.reference : null,
    }),
  );
  const submitMutation = useMutation(
    reviewSubmitMutationOptions({ queryClient, target: props.target }),
  );

  const pendingInlineComments = useMemo(
    () => (commentsQuery.data?.comments ?? []).filter((comment) => !comment.resolved),
    [commentsQuery.data],
  );
  const commentsAreRefreshing = commentsQuery.isPending || commentsQuery.isFetching;
  const inlineComments = useMemo<ReadonlyArray<ReviewInlineComment>>(
    () =>
      pendingInlineComments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
      })),
    [pendingInlineComments],
  );

  const generalThreadCount = useMemo(
    () =>
      (remoteThreadsQuery.data?.threads ?? []).filter(
        (thread) => !thread.path || thread.line === undefined,
      ).length,
    [remoteThreadsQuery.data],
  );

  if (!canSubmit) {
    return null;
  }

  const handleSubmit = () => {
    if (props.cwd === null || props.reference === null) {
      return;
    }
    if (commentsAreRefreshing) {
      setStatus({ kind: "error", message: "Review comments are still loading." });
      return;
    }
    const trimmedBody = body.trim();
    if (event === "comment" && trimmedBody.length === 0 && inlineComments.length === 0) {
      return;
    }
    const submittedSubmitKey = currentSubmitKey;
    if (submittedSubmitKey === null) {
      return;
    }
    setStatus({ kind: "idle" });
    const submittedTarget = props.target;
    const submittedComments = pendingInlineComments;
    submitMutation.mutate(
      {
        cwd: props.cwd,
        reference: props.reference,
        event,
        ...(trimmedBody.length > 0 ? { body: trimmedBody } : {}),
        ...(inlineComments.length > 0 ? { comments: inlineComments } : {}),
        ...(props.expectedHeadSha ? { expectedHeadSha: props.expectedHeadSha } : {}),
      },
      {
        onSuccess: async (result) => {
          let cleanupError: string | undefined;
          if (submittedTarget && result.submitted && !result.headMoved) {
            try {
              await clearSubmittedReviewComments({
                queryClient,
                target: submittedTarget,
                comments: submittedComments,
                ...(result.skippedComments ? { skippedComments: result.skippedComments } : {}),
              });
            } catch (error) {
              cleanupError =
                error instanceof Error
                  ? error.message
                  : "Submitted review, but local comments could not be cleared.";
              await queryClient.invalidateQueries({
                queryKey: reviewQueryKeys.comments(reviewTargetKeyString(submittedTarget)),
              });
            }
          }
          if (currentSubmitKeyRef.current !== submittedSubmitKey) {
            return;
          }
          setStatus({ kind: "success", result, ...(cleanupError ? { cleanupError } : {}) });
          if (!result.headMoved) {
            setBody("");
            setOpen(cleanupError !== undefined);
          }
        },
        onError: (error) => {
          if (currentSubmitKeyRef.current !== submittedSubmitKey) {
            return;
          }
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to submit review.",
          });
        },
      },
    );
  };

  const summary =
    inlineComments.length === 1
      ? "1 inline comment will be included"
      : `${inlineComments.length} inline comments will be included`;
  const pageSummary =
    inlineComments.length > 0 || generalThreadCount > 0
      ? `${summary}${
          generalThreadCount > 0
            ? ` · ${generalThreadCount} general review comment${generalThreadCount === 1 ? "" : "s"}`
            : ""
        }`
      : null;

  // GitHub rejects a COMMENT review with neither a body nor inline comments.
  const canSend = event !== "comment" || body.trim().length > 0 || inlineComments.length > 0;
  const submitDisabled = submitMutation.isPending || commentsAreRefreshing || !canSend;
  const reloadReviewData = () => {
    void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.all });
    setStatus({ kind: "idle" });
  };

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 bg-background",
        props.mode === "header" && "ms-auto max-w-full border-0 bg-transparent p-0 shadow-none",
        props.mode === "page" &&
          "absolute bottom-3 right-3 z-20 max-w-[min(30rem,calc(100%-1.5rem))] rounded-xl border border-border/70 px-2 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]",
        props.mode === "dock" && "border-t border-border/70 px-2 py-1.5",
      )}
    >
      {(props.mode === "page" || props.mode === "header") && pageSummary ? (
        <div
          className={cn(
            "flex min-w-48 flex-1 items-center gap-2 text-[11px] text-muted-foreground tabular-nums",
            props.mode === "header" && "hidden",
          )}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{pageSummary}</span>
          </span>
        </div>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size={props.mode === "dock" ? "xs" : "sm"}
              variant={event === "request_changes" ? "destructive" : "default"}
              className={cn(
                "ms-auto shrink-0 shadow-none",
                props.mode === "header" ? "h-7 rounded-md px-2.5 text-[12px]" : "rounded-lg",
              )}
            />
          }
        >
          <GitPullRequestIcon className="size-3.5" />
          {event === "approve"
            ? "Approve review"
            : event === "request_changes"
              ? "Request changes"
              : "Submit review"}
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          side="top"
          sideOffset={6}
          className="w-[min(20rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)]"
        >
          <div className="flex flex-col gap-3">
            <RadioGroup
              value={event}
              onValueChange={(value) => setEvent(value as ReviewSubmitEvent)}
              aria-label="Review decision"
              className="-mx-1.5 gap-0.5"
            >
              {EVENT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-[12px] text-foreground",
                    "transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/50",
                  )}
                >
                  <Radio value={option.value} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium leading-none">{option.label}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>

            <textarea
              aria-label="Review summary"
              value={body}
              disabled={submitMutation.isPending}
              placeholder="Optional review summary"
              onChange={(textEvent) => setBody(textEvent.target.value)}
              className={cn(reviewTextareaClassName, "min-h-20")}
            />

            <p className="text-[11px] text-muted-foreground">
              {commentsAreRefreshing ? "Refreshing inline comments before submit." : `${summary}.`}
            </p>

            <div className="flex items-center justify-end gap-1.5">
              <PopoverClose
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={submitMutation.isPending}
                  >
                    Cancel
                  </Button>
                }
              />
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={submitDisabled}
                onClick={handleSubmit}
              >
                {submitMutation.isPending ? <Loader2Icon className="size-3 animate-spin" /> : null}
                Submit
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>

      <SubmitStatusLine
        status={status}
        className={props.mode === "page" ? "" : "ms-auto"}
        onReload={reloadReviewData}
      />
    </div>
  );
}

function SubmitStatusLine(props: {
  status: SubmitStatus;
  className?: string;
  onReload: () => void;
}) {
  const { status } = props;
  if (status.kind === "idle") {
    return null;
  }
  if (status.kind === "error") {
    return (
      <span
        role="alert"
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px] text-destructive",
          "basis-full sm:basis-auto",
          props.className,
        )}
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate" title={status.message}>
          {status.message}
        </span>
      </span>
    );
  }
  const { result } = status;
  if (status.cleanupError) {
    return (
      <span
        role="alert"
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px] text-warning-foreground",
          "basis-full sm:basis-auto",
          props.className,
        )}
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate" title={status.cleanupError}>
          Review submitted, but local comments could not be cleared.
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={props.onReload}
        >
          Refresh
        </Button>
      </span>
    );
  }
  if (result.headMoved) {
    return (
      <span
        role="alert"
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px] text-warning-foreground",
          "basis-full sm:basis-auto",
          props.className,
        )}
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          PR head moved since you loaded it. Reload to anchor comments to the latest commit.
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={props.onReload}
        >
          Reload
        </Button>
      </span>
    );
  }
  const skipped = result.skippedComments?.length ?? 0;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px] text-success-foreground",
        "basis-full sm:basis-auto",
        props.className,
      )}
    >
      <CircleCheckIcon className="size-3.5 shrink-0" />
      Review submitted
      {skipped > 0 ? <ReviewPill tone="warning">{skipped} skipped</ReviewPill> : null}
    </span>
  );
}
