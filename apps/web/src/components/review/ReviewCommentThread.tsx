import type {
  ReviewFinding,
  ReviewLocalComment,
  ReviewRemoteThread,
  ReviewViewerResult,
} from "@t3tools/contracts";
import { useState } from "react";

import { BotIcon, CheckIcon, MessageCircleIcon, SquarePenIcon, Trash2, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import type { ReviewLineAnnotationData, ReviewLocalDraftAnnotation } from "./reviewAnnotations";
import { InlineCommentForm } from "./InlineCommentForm";
import { ReviewAvatar } from "./reviewPrPrimitives";
import { ReviewPill, severityPill } from "./reviewPrimitives";

export interface ReviewCommentThreadActions {
  saveDraft: (draftId: string, body: string) => void;
  cancelDraft: (draftId: string) => void;
  updateBody: (comment: ReviewLocalComment, body: string) => void;
  toggleResolved: (comment: ReviewLocalComment) => void;
  remove: (comment: ReviewLocalComment) => void;
  startReply: (anchor: ReviewLocalDraftAnnotation) => void;
  convertFinding: (finding: ReviewFinding) => void;
  dismissFinding: (finding: ReviewFinding) => void;
  resolveRemoteThread: (thread: ReviewRemoteThread, resolved: boolean) => void;
  replyRemoteThread: (thread: ReviewRemoteThread, body: string) => void;
  editRemoteComment: (commentId: string, body: string) => void;
  deleteRemoteComment: (commentId: string) => void;
}

const BUBBLE_SHELL_CLASS = "mx-2 my-1 overflow-hidden rounded-lg border border-border/60 bg-card";

const SEVERITY_SURFACE: Record<ReviewFinding["severity"], string> = {
  blocker: "border-destructive/25 bg-destructive/10",
  major: "border-warning/25 bg-warning/10",
  minor: "border-info/25 bg-info/10",
  nit: "border-border/40 bg-muted/40",
};

function viewerAuthor(
  viewer: ReviewViewerResult | null,
): { login: string; avatarUrl?: string } | undefined {
  if (!viewer) return undefined;
  const login = viewer.login.trim() || "You";
  return {
    login,
    ...(viewer.avatarUrl !== undefined ? { avatarUrl: viewer.avatarUrl } : {}),
  };
}

function AgentFinding(props: { finding: ReviewFinding; actions: ReviewCommentThreadActions }) {
  const { finding, actions } = props;
  const pill = severityPill(finding.severity);
  return (
    <div
      className={cn(
        BUBBLE_SHELL_CLASS,
        "flex flex-col gap-2 px-3 py-2.5",
        SEVERITY_SURFACE[finding.severity],
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <BotIcon className="size-3 shrink-0" />
        <ReviewPill tone={pill.tone}>{pill.label}</ReviewPill>
        <span className="min-w-0 truncate font-medium text-foreground" title={finding.title}>
          {finding.title}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
        {finding.message}
      </p>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="default"
          className="active:scale-[0.96] motion-reduce:active:scale-100"
          onClick={() => actions.convertFinding(finding)}
        >
          <MessageCircleIcon className="size-3" />
          Convert to comment
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="active:scale-[0.96] motion-reduce:active:scale-100"
          onClick={() => actions.dismissFinding(finding)}
        >
          <XIcon className="size-3" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SavedCommentBubble(props: {
  comment: ReviewLocalComment;
  actions: ReviewCommentThreadActions;
  viewer: ReviewViewerResult | null;
}) {
  const { comment, actions } = props;
  const [editing, setEditing] = useState(false);
  const author = viewerAuthor(props.viewer);

  if (editing) {
    return (
      <InlineCommentForm
        initialBody={comment.body}
        saveLabel="Update"
        {...(author ? { author } : {})}
        onCancel={() => setEditing(false)}
        onSave={(body) => {
          actions.updateBody(comment, body);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="group/comment relative flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
        <ReviewAvatar
          login={props.viewer?.login || "You"}
          {...(props.viewer?.avatarUrl !== undefined ? { avatarUrl: props.viewer.avatarUrl } : {})}
          className="size-4"
        />
        <span className="min-w-0 truncate font-medium text-foreground">
          {props.viewer?.login || "You"}
        </span>
        <span className="shrink-0 tabular-nums">{formatTimestamp(comment.updatedAt)}</span>
        {comment.resolved ? <ReviewPill tone="success">Resolved</ReviewPill> : null}
        <div className="ms-auto flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={comment.resolved ? "Reopen" : "Resolve"}
            aria-label={comment.resolved ? "Reopen comment" : "Resolve comment"}
            className="active:scale-[0.96] motion-reduce:active:scale-100"
            onClick={() => actions.toggleResolved(comment)}
          >
            <CheckIcon className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Edit"
            aria-label="Edit comment"
            className="active:scale-[0.96] motion-reduce:active:scale-100"
            onClick={() => setEditing(true)}
          >
            <SquarePenIcon className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Delete"
            aria-label="Delete comment"
            className="hover:text-destructive active:scale-[0.96] motion-reduce:active:scale-100"
            onClick={() => actions.remove(comment)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap break-words ps-5 text-[13px] leading-relaxed text-foreground",
          comment.resolved && "text-muted-foreground",
        )}
      >
        {comment.body}
      </p>
    </div>
  );
}

function SubmittedThreadComment(props: {
  comment: ReviewRemoteThread["comments"][number];
  canManage: boolean;
  actions: ReviewCommentThreadActions;
}) {
  const { comment, actions } = props;
  const [editing, setEditing] = useState(false);
  const commentId = comment.id;

  if (editing && commentId !== undefined) {
    return (
      <div className="p-2.5">
        <InlineCommentForm
          initialBody={comment.body}
          saveLabel="Update"
          onCancel={() => setEditing(false)}
          onSave={(body) => {
            actions.editRemoteComment(commentId, body);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="group/comment relative flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
        <ReviewAvatar
          login={comment.author || "unknown"}
          {...(comment.authorAvatarUrl !== undefined ? { avatarUrl: comment.authorAvatarUrl } : {})}
          className="size-4"
        />
        <span className="min-w-0 truncate font-medium text-foreground">
          {comment.author || "unknown"}
        </span>
        <span className="shrink-0 tabular-nums">{formatTimestamp(comment.createdAt)}</span>
        {props.canManage && commentId !== undefined ? (
          <div className="ms-auto flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Edit"
              aria-label="Edit comment"
              className="active:scale-[0.96] motion-reduce:active:scale-100"
              onClick={() => setEditing(true)}
            >
              <SquarePenIcon className="size-3" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Delete"
              aria-label="Delete comment"
              className="hover:text-destructive active:scale-[0.96] motion-reduce:active:scale-100"
              onClick={() => actions.deleteRemoteComment(commentId)}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words ps-5 text-[13px] leading-relaxed text-foreground">
        {comment.body}
      </p>
    </div>
  );
}

function SubmittedThread(props: {
  thread: ReviewRemoteThread;
  actions: ReviewCommentThreadActions;
  viewer: ReviewViewerResult | null;
}) {
  const { thread, actions } = props;
  const [replying, setReplying] = useState(false);
  const viewerLogin = props.viewer?.login.trim() ?? "";
  return (
    <div className={cn(BUBBLE_SHELL_CLASS, "divide-y divide-border/40")}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground">
        <MessageCircleIcon className="size-3.5 shrink-0" />
        <span className="font-medium uppercase tracking-wide">Submitted</span>
        {thread.isResolved ? <ReviewPill tone="success">Resolved</ReviewPill> : null}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ms-auto active:scale-[0.96] motion-reduce:active:scale-100"
          onClick={() => actions.resolveRemoteThread(thread, !thread.isResolved)}
        >
          <CheckIcon className="size-3" />
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </Button>
      </div>
      {thread.comments.map((comment, index) => (
        <SubmittedThreadComment
          key={comment.id ?? `${comment.author}:${comment.createdAt}:${index}`}
          comment={comment}
          canManage={viewerLogin.length > 0 && comment.author === viewerLogin}
          actions={actions}
        />
      ))}
      {replying ? (
        <div className="p-2.5">
          <InlineCommentForm
            saveLabel="Reply"
            placeholder="Reply to this thread..."
            onCancel={() => setReplying(false)}
            onSave={(body) => {
              actions.replyRemoteThread(thread, body);
              setReplying(false);
            }}
          />
        </div>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="m-2 self-start active:scale-[0.96] motion-reduce:active:scale-100"
          onClick={() => setReplying(true)}
        >
          <MessageCircleIcon className="size-3" />
          Reply
        </Button>
      )}
    </div>
  );
}

export function ReviewCommentThread(props: {
  data: ReviewLineAnnotationData;
  actions: ReviewCommentThreadActions;
  viewer?: ReviewViewerResult | null;
}) {
  const { data, actions } = props;
  const author = viewerAuthor(props.viewer ?? null);

  if (data.kind === "submitted-thread") {
    return <SubmittedThread thread={data.thread} actions={actions} viewer={props.viewer ?? null} />;
  }

  if (data.kind === "agent-finding") {
    return <AgentFinding finding={data.finding} actions={actions} />;
  }

  const draft = data.draft;
  return (
    <div
      className={cn(
        BUBBLE_SHELL_CLASS,
        data.comments.length === 0 && "border-dashed bg-background/92",
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border/40 bg-muted/40 px-3">
        <MessageCircleIcon className="size-3.5 text-muted-foreground/85" aria-hidden="true" />
        <span className="font-medium text-[12px] text-foreground/90">
          {data.comments.length > 0 ? "Comment thread" : "Comment"}
        </span>
        {data.comments.length > 0 ? (
          <ReviewPill tone="muted">{data.comments.length}</ReviewPill>
        ) : null}
      </div>
      {data.comments.map((comment) => (
        <SavedCommentBubble
          key={comment.id}
          comment={comment}
          actions={actions}
          viewer={props.viewer ?? null}
        />
      ))}

      {draft ? (
        <div className="border-t border-border/25 p-2.5 first:border-t-0">
          <InlineCommentForm
            initialBody={draft.body}
            busy={draft.status === "saving"}
            placeholder={
              data.comments.length > 0 ? "Reply to this thread..." : "Leave a comment..."
            }
            saveLabel={data.comments.length > 0 ? "Reply" : "Add comment"}
            {...(author ? { author } : {})}
            onCancel={() => actions.cancelDraft(draft.draftId)}
            onSave={(body) => actions.saveDraft(draft.draftId, body)}
          />
        </div>
      ) : data.comments.length > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mx-2.5 mb-2.5 self-start active:scale-[0.96] motion-reduce:active:scale-100"
          onClick={() => actions.startReply(data)}
        >
          <MessageCircleIcon className="size-3" />
          Reply
        </Button>
      ) : null}
    </div>
  );
}
