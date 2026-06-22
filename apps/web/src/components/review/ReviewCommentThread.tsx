import type {
  ReviewFinding,
  ReviewLocalComment,
  ReviewRemoteThread,
  ReviewViewerResult,
} from "@t3tools/contracts";
import { useState } from "react";

import { BotIcon, CheckIcon, MessageCircleIcon, SquarePenIcon, Trash2, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
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

const BUBBLE_SHELL_CLASS =
  "mx-2 my-1 overflow-hidden rounded-lg border border-border/70 bg-card/95 shadow-[0_12px_30px_-26px_var(--foreground)]";

const SEVERITY_SURFACE: Record<ReviewFinding["severity"], string> = {
  blocker: "border-destructive/35 bg-destructive/[0.055]",
  major: "border-warning-foreground/30 bg-warning/[0.09]",
  minor: "border-info/30 bg-info/[0.07]",
  nit: "border-border/80 bg-muted/22",
};

const THREAD_ACTION_CLASS =
  "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

const PRIMARY_THREAD_ACTION_CLASS =
  "flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background outline-none transition-opacity duration-150 motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring";

const ICON_BUTTON_CLASS =
  "rounded-md p-1 text-muted-foreground opacity-70 outline-none transition-[background-color,color,opacity] duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";

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
        <button
          type="button"
          className={PRIMARY_THREAD_ACTION_CLASS}
          onClick={() => actions.convertFinding(finding)}
        >
          <MessageCircleIcon className="size-3" />
          Convert to comment
        </button>
        <button
          type="button"
          className={THREAD_ACTION_CLASS}
          onClick={() => actions.dismissFinding(finding)}
        >
          <XIcon className="size-3" />
          Dismiss
        </button>
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
        <span
          className={cn("shrink-0 tabular-nums", comment.resolved && "line-through opacity-70")}
        >
          {formatTimestamp(comment.updatedAt)}
        </span>
        {comment.resolved ? <ReviewPill tone="success">Resolved</ReviewPill> : null}
        <div className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 motion-reduce:transition-none">
          <button
            type="button"
            title={comment.resolved ? "Reopen" : "Resolve"}
            aria-label={comment.resolved ? "Reopen comment" : "Resolve comment"}
            className={ICON_BUTTON_CLASS}
            onClick={() => actions.toggleResolved(comment)}
          >
            <CheckIcon className="size-3" />
          </button>
          <button
            type="button"
            title="Edit"
            aria-label="Edit comment"
            className={ICON_BUTTON_CLASS}
            onClick={() => setEditing(true)}
          >
            <SquarePenIcon className="size-3" />
          </button>
          <button
            type="button"
            title="Delete"
            aria-label="Delete comment"
            className={cn(ICON_BUTTON_CLASS, "hover:bg-destructive/10 hover:text-destructive")}
            onClick={() => actions.remove(comment)}
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap break-words ps-5 text-[13px] leading-relaxed text-foreground/88",
          comment.resolved && "opacity-70",
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
          <div className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 motion-reduce:transition-none">
            <button
              type="button"
              title="Edit"
              aria-label="Edit comment"
              className={ICON_BUTTON_CLASS}
              onClick={() => setEditing(true)}
            >
              <SquarePenIcon className="size-3" />
            </button>
            <button
              type="button"
              title="Delete"
              aria-label="Delete comment"
              className={cn(ICON_BUTTON_CLASS, "hover:bg-destructive/10 hover:text-destructive")}
              onClick={() => actions.deleteRemoteComment(commentId)}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words ps-5 text-[13px] leading-relaxed text-foreground/88">
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
    <div className={cn(BUBBLE_SHELL_CLASS, "divide-y divide-border/45 bg-card/95")}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground">
        <MessageCircleIcon className="size-3.5 shrink-0" />
        <span className="font-medium uppercase tracking-wide">Submitted</span>
        {thread.isResolved ? <ReviewPill tone="success">Resolved</ReviewPill> : null}
        <button
          type="button"
          className={cn(THREAD_ACTION_CLASS, "ms-auto")}
          onClick={() => actions.resolveRemoteThread(thread, !thread.isResolved)}
        >
          <CheckIcon className="size-3" />
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </button>
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
        <button
          type="button"
          className={cn(THREAD_ACTION_CLASS, "m-2 self-start")}
          onClick={() => setReplying(true)}
        >
          <MessageCircleIcon className="size-3" />
          Reply
        </button>
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
      <div className="flex h-8 items-center gap-2 border-b border-border/45 bg-muted/16 px-3">
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
        <div className="border-t border-border/35 p-2.5 first:border-t-0">
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
        <button
          type="button"
          className={cn(THREAD_ACTION_CLASS, "mx-2.5 mb-2.5 self-start")}
          onClick={() => actions.startReply(data)}
        >
          <MessageCircleIcon className="size-3" />
          Reply
        </button>
      ) : null}
    </div>
  );
}
