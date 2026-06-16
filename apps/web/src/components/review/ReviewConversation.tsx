import type {
  ReviewPullRequestDetail,
  ReviewPullRequestHeaderDetail,
  ReviewTimelineEvent,
} from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  CheckIcon,
  GitCommitIcon,
  Loader2Icon,
  MessageCircleIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { reviewSubmitMutationOptions } from "~/lib/reviewReactQuery";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ReviewAvatar, reviewerStatePill } from "./reviewPrPrimitives";
import { ReviewPill, formatRelativeReviewTime, reviewTextareaClassName } from "./reviewPrimitives";

type CommentEvent = Extract<ReviewTimelineEvent, { _tag: "comment" }>;
type ReviewEvent = Extract<ReviewTimelineEvent, { _tag: "review" }>;
type CommitEvent = Extract<ReviewTimelineEvent, { _tag: "commit" }>;

function CommentCard(props: {
  author: string;
  authorAvatarUrl?: string | undefined;
  when: string | null;
  verb: string;
  body: string;
  cwd: string | null;
  badge?: React.ReactNode;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-[1.1rem] border border-border/38 bg-card/38 p-3.5">
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <ReviewAvatar
          login={props.author}
          {...(props.authorAvatarUrl !== undefined ? { avatarUrl: props.authorAvatarUrl } : {})}
        />
        <span className="font-medium text-foreground">{props.author || "unknown"}</span>
        {props.badge}
        {props.when ? (
          <span className="tabular-nums">
            {props.verb} {props.when}
          </span>
        ) : null}
      </header>
      {props.body.trim().length > 0 ? (
        <ChatMarkdown
          text={props.body}
          cwd={props.cwd ?? undefined}
          className="chat-markdown text-[13px]"
        />
      ) : null}
    </article>
  );
}

function SummaryCard(props: { body: string; cwd: string | null }) {
  return (
    <article className="flex flex-col gap-3 rounded-[1.2rem] border border-border/38 bg-card/38 p-5">
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-[16px] text-foreground">
          Summary
        </h2>
      </header>
      <ChatMarkdown
        text={props.body.trim().length > 0 ? props.body : "_No description provided._"}
        cwd={props.cwd ?? undefined}
        className="chat-markdown text-[13px] leading-relaxed"
      />
    </article>
  );
}

function CommentCardLoading() {
  return (
    <article
      className="flex flex-col gap-2 rounded-[1.1rem] border border-border/38 bg-card/38 p-3.5"
      aria-busy="true"
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </header>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-2/3" />
    </article>
  );
}

function ConversationLoadingStack() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading conversation">
      <CommentCardLoading />
      <CommentCardLoading />
      <div className="flex min-w-0 items-center gap-2 px-1 text-[12px] text-muted-foreground">
        <Skeleton className="size-3.5 rounded-full" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="ms-auto h-3 w-20" />
      </div>
    </div>
  );
}

function TimelineComment(props: { event: CommentEvent; cwd: string | null }) {
  return (
    <CommentCard
      author={props.event.author}
      {...(props.event.authorAvatarUrl !== undefined
        ? { authorAvatarUrl: props.event.authorAvatarUrl }
        : {})}
      when={formatRelativeReviewTime(props.event.createdAt)}
      verb="commented"
      body={props.event.body}
      cwd={props.cwd}
    />
  );
}

function TimelineReview(props: { event: ReviewEvent; cwd: string | null }) {
  const pill = reviewerStatePill(props.event.state);
  return (
    <CommentCard
      author={props.event.author}
      {...(props.event.authorAvatarUrl !== undefined
        ? { authorAvatarUrl: props.event.authorAvatarUrl }
        : {})}
      when={formatRelativeReviewTime(props.event.createdAt)}
      verb="reviewed"
      body={props.event.body}
      cwd={props.cwd}
      badge={<ReviewPill tone={pill.tone}>{pill.label}</ReviewPill>}
    />
  );
}

function TimelineCommit(props: { event: CommitEvent }) {
  const when = formatRelativeReviewTime(props.event.createdAt);
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 text-[12px] text-muted-foreground">
      <GitCommitIcon className="size-3.5 shrink-0" />
      <span
        className="min-w-0 flex-1 truncate text-foreground/90"
        title={props.event.messageHeadline}
      >
        {props.event.messageHeadline}
      </span>
      {props.event.author.length > 0 ? (
        <span className="shrink-0 truncate">{props.event.author}</span>
      ) : null}
      <code className="shrink-0 font-mono text-[10px] tabular-nums">
        {props.event.abbreviatedOid}
      </code>
      {when ? <span className="shrink-0 tabular-nums">{when}</span> : null}
    </div>
  );
}

function ConversationCommentComposer(props: {
  cwd: string | null;
  reference: string;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const postedResetTimeout = useRef<number | null>(null);
  const submitMutation = useMutation(reviewSubmitMutationOptions({ queryClient, target: null }));
  const trimmedBody = body.trim();
  const canSubmit = props.cwd !== null && !props.disabled && trimmedBody.length > 0;
  const composerDisabled = props.disabled || submitMutation.isPending;

  useEffect(
    () => () => {
      if (postedResetTimeout.current !== null) {
        window.clearTimeout(postedResetTimeout.current);
      }
    },
    [],
  );

  const submitComment = () => {
    if (!canSubmit || props.cwd === null) {
      return;
    }
    setError(null);
    submitMutation.mutate(
      {
        cwd: props.cwd,
        reference: props.reference,
        event: "comment",
        body: trimmedBody,
      },
      {
        onSuccess: () => {
          setBody("");
          setPosted(true);
          if (postedResetTimeout.current !== null) {
            window.clearTimeout(postedResetTimeout.current);
          }
          postedResetTimeout.current = window.setTimeout(() => setPosted(false), 1200);
        },
        onError: (mutationError) =>
          setError(
            mutationError instanceof Error ? mutationError.message : "Failed to post comment.",
          ),
      },
    );
  };

  return (
    <section
      className={cn(
        "group/comment-composer overflow-hidden rounded-[1.2rem] border border-border/38 bg-card/38",
        "transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none",
        "focus-within:border-ring/55 focus-within:bg-card/48",
      )}
    >
      <div className="flex min-w-0 items-start gap-3 px-3.5 pt-3.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 transition-colors duration-150 group-focus-within/comment-composer:text-foreground motion-reduce:transition-none">
          <MessageCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="truncate font-semibold text-[13px] text-foreground">Add comment</h2>
            <span className="text-[11px] text-muted-foreground/70">General PR discussion</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Markdown is supported. Inline comments stay with changed files.
          </p>
        </div>
      </div>

      <div className="px-3.5 py-3">
        <textarea
          aria-label="Pull request comment"
          value={body}
          disabled={composerDisabled}
          placeholder="Write a comment..."
          onChange={(event) => setBody(event.target.value)}
          className={cn(
            reviewTextareaClassName,
            "min-h-20 resize-none rounded-[1rem] border-border/38 bg-background/70 px-3 py-2.5 text-[13px] leading-relaxed shadow-none",
            "placeholder:text-muted-foreground/70 hover:bg-muted/20 focus-visible:bg-background/90",
          )}
        />
      </div>

      <div className="flex min-w-0 items-end justify-between gap-3 border-t border-border/28 bg-background/14 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          {error ? (
            <p
              role="alert"
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-destructive"
            >
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate" title={error}>
                {error}
              </span>
            </p>
          ) : (
            <span
              className={cn(
                "block text-balance text-[11px] text-muted-foreground",
                posted && "font-medium text-success-foreground",
              )}
              aria-live="polite"
            >
              {posted ? "Comment added." : "Use Files for line-specific comments."}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={canSubmit || posted ? "prominent" : "secondary"}
          className="h-8 shrink-0 rounded-md px-3.5 font-medium transition-[transform,opacity] duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          disabled={!canSubmit || submitMutation.isPending}
          onClick={submitComment}
        >
          {submitMutation.isPending ? (
            <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          ) : posted ? (
            <CheckIcon className="size-3" aria-hidden="true" />
          ) : null}
          Comment
        </Button>
      </div>
    </section>
  );
}

export function ReviewConversation(props: {
  detail: ReviewPullRequestDetail | ReviewPullRequestHeaderDetail;
  cwd: string | null;
  reference: string;
  events: ReadonlyArray<ReviewTimelineEvent>;
  isLoading: boolean;
  className?: string;
}) {
  const { detail } = props;
  const opened = formatRelativeReviewTime(detail.createdAt);
  const hasTimelineEvents = props.events.length > 0;

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[64rem] flex-col gap-3 px-5 py-4 2xl:max-w-[70rem]",
        props.className,
      )}
    >
      <SummaryCard body={detail.body} cwd={props.cwd} />

      <div className="px-1 text-[11px] text-muted-foreground">
        {detail.author || "unknown"} opened {opened ?? "this pull request"}
      </div>

      <ConversationCommentComposer
        cwd={props.cwd}
        reference={props.reference}
        disabled={props.detail.state !== "open"}
      />

      {!props.isLoading && !hasTimelineEvents ? (
        <div className="rounded-lg border border-dashed border-border/55 bg-background px-4 py-5 text-center text-[12px] text-muted-foreground">
          No discussion yet. Start with the first useful note.
        </div>
      ) : null}

      {props.events.map((event) => {
        switch (event._tag) {
          case "comment":
            return <TimelineComment key={event.id} event={event} cwd={props.cwd} />;
          case "review":
            return <TimelineReview key={event.id} event={event} cwd={props.cwd} />;
          case "commit":
            return <TimelineCommit key={event.oid} event={event} />;
          default:
            return null;
        }
      })}

      {props.isLoading ? <ConversationLoadingStack /> : null}
    </div>
  );
}
