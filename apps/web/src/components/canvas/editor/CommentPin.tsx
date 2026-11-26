import type { CanvasCommentAuthor, CanvasCommentThread } from "@synara/contracts";
import { useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { accountInitial } from "~/lib/accountLogic";
import { BotIcon, CheckIcon, UserIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { useProfileIdentity } from "../../profile/useProfileIdentity";
import { ProviderIcon } from "../../ProviderIcon";

/** Edge of the on-canvas pin, in screen pixels; its bottom-left corner is the anchor point. */
export const COMMENT_PIN_SIZE = 26;

type AgentAuthor = Extract<CanvasCommentAuthor, { kind: "agent" }>;

/** First letter of the signed-in (or locally named) user, or null when no name is known. */
export function useCommentUserInitial(): string | null {
  const { name } = useProfileIdentity({ name: "", handle: "" });
  return name.trim() ? accountInitial(name) : null;
}

/** The provider glyph of the chat that wrote an agent message, or a neutral robot. */
export function CommentAgentGlyph({
  author,
  className,
}: {
  author: AgentAuthor;
  className?: string;
}) {
  const provider = useStore(
    (state) => state.sidebarThreadSummaryById[author.threadId]?.modelSelection.provider,
  );
  return (
    <ProviderIcon
      provider={provider}
      className={className}
      fallback={<BotIcon aria-hidden className={cn("text-muted-foreground", className)} />}
    />
  );
}

/**
 * Who wrote a comment: the user's initial on the primary fill, the agent's glyph on the
 * surface, or a check once the thread is resolved. `drop` is the pin's teardrop (square
 * bottom-left corner), `circle` the plain message avatar.
 */
export function CommentAvatar({
  author,
  userInitial,
  resolved = false,
  shape = "drop",
  className,
}: {
  author: CanvasCommentAuthor;
  userInitial: string | null;
  resolved?: boolean;
  shape?: "drop" | "circle";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-ui-2xs font-semibold",
        shape === "drop" && "rounded-bl-[calc(var(--radius-sm)-2px)]",
        resolved
          ? "bg-muted-foreground/45 text-white"
          : author.kind === "agent"
            ? "bg-popover shadow-[0_0_0_1px_rgb(0_0_0/0.1)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12)]"
            : "bg-primary text-primary-foreground",
        className,
      )}
    >
      {resolved ? (
        <CheckIcon className="size-2.5" strokeWidth={3} />
      ) : author.kind === "agent" ? (
        <CommentAgentGlyph author={author} className="size-2.75" />
      ) : userInitial ? (
        userInitial
      ) : (
        <UserIcon className="size-2.75" />
      )}
    </span>
  );
}

/** "You · 2m" / "Agent · 4m": the author in full weight, the time muted. */
export function CommentMeta({
  author,
  createdAt,
}: {
  author: CanvasCommentAuthor;
  createdAt: string;
}) {
  const { t } = useTranslation();
  return (
    <span className="truncate text-ui-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {author.kind === "user"
          ? t("workspace:canvasCommentYou")
          : t("workspace:canvasCommentAgent")}
      </span>
      {` · ${formatRelativeTime(createdAt)}`}
    </span>
  );
}

/** The agent's messages in a thread, oldest first. */
export function agentReplies(thread: CanvasCommentThread) {
  return thread.messages.filter(
    (message): message is (typeof thread.messages)[number] & { author: AgentAuthor } =>
      message.author.kind === "agent",
  );
}

/**
 * The comment pin: a teardrop avatar whose square corner sits on the anchor point.
 * Hovering a closed pin expands it into a preview of the first message; a badge with the
 * agent's glyph shows once the agent has replied. Without `onClick` it is the static pin of
 * a comment still being written.
 */
export function CommentPin({
  thread,
  author,
  userInitial,
  active = false,
  unread = false,
  label,
  onClick,
}: {
  /** The pinned thread; omitted while the first message is being written. */
  thread?: CanvasCommentThread;
  author: CanvasCommentAuthor;
  userInitial: string | null;
  active?: boolean;
  /** A reply the user has not read yet: a dot on the pin. */
  unread?: boolean;
  label?: string;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const first = thread?.messages[0];
  const resolved = thread?.status === "resolved";
  const agentReply = thread ? agentReplies(thread).at(-1)?.author : undefined;
  const preview = hovered && !active && first;
  const shadow = active
    ? "shadow-[0_0_0_3px_var(--color-background-button-secondary),0_2px_8px_rgb(0_0_0/0.18)]"
    : "shadow-[0_2px_8px_rgb(0_0_0/0.18)]";
  const body: ReactNode = preview ? (
    <span className="flex items-center gap-2 rounded-full rounded-bl-sm bg-popover py-0.75 ps-0.75 pe-3 shadow-[0_4px_14px_rgb(0_0_0/0.14),0_0_0_1px_rgb(0_0_0/0.04)]">
      <CommentAvatar
        author={first.author}
        userInitial={userInitial}
        resolved={resolved}
        className="size-5.5"
      />
      <span className="flex min-w-0 flex-col text-start">
        <CommentMeta author={first.author} createdAt={first.createdAt} />
        <span className="max-w-60 truncate text-ui-sm text-foreground">{first.text}</span>
      </span>
    </span>
  ) : (
    <span
      data-comment-pin-body=""
      className={cn(
        "relative flex size-6.5 rounded-full rounded-bl-sm bg-popover p-0.5",
        shadow,
        // Below 50% zoom a closed pin shrinks with the canvas (to half size at 25%), so it does
        // not cover the small frames it points at; it scales from its anchor corner.
        !active && "origin-bottom-left [scale:var(--canvas-pin-scale,1)]",
      )}
    >
      <CommentAvatar
        author={author}
        userInitial={userInitial}
        resolved={resolved}
        className="size-auto flex-1 rounded-bl-[calc(var(--radius-sm)-2px)]"
      />
      {agentReply && !resolved && (
        <span className="absolute -end-1.25 -top-1.25 flex size-3.5 items-center justify-center rounded-full bg-popover shadow-[0_1px_3px_rgb(0_0_0/0.2)]">
          <CommentAgentGlyph author={agentReply} className="size-2" />
        </span>
      )}
      {unread && !resolved && (
        <span
          data-comment-unread=""
          className="absolute -start-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-popover"
        />
      )}
    </span>
  );
  if (!onClick) return <span className="absolute bottom-0 left-0 flex">{body}</span>;
  return (
    <button
      type="button"
      data-canvas-ui=""
      data-canvas-comment-pin=""
      aria-label={label}
      aria-expanded={active}
      className="pointer-events-auto absolute bottom-0 left-0 flex rounded-full rounded-bl-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
