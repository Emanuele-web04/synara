import type { CanvasCommentThread, CanvasPage } from "@synara/contracts";
import { useState } from "react";
import { useTranslation } from "~/i18n";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { FilterIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { SearchInput } from "../../ui/search-input";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../../ui/sidebar";
import {
  canvasCommentTarget,
  isCommentUnread,
  revealCanvasComment,
  useCanvasCommentActions,
} from "./CanvasComments";
import { useCanvasEditor } from "./CanvasEditorContext";
import {
  agentReplies,
  CommentAgentGlyph,
  CommentAvatar,
  useCommentUserInitial,
} from "./CommentPin";

/** Threads on a page, for the count beside the panel's "Comments" tab. */
export function canvasCommentCount(page: Pick<CanvasPage, "comments">): number {
  return page.comments.length;
}

type Sort = "newest" | "oldest" | "page";
type Author = "anyone" | "user" | "agent";
type PageFilter = "any" | "current";
/** "Show resolved" is remembered per execution host. */
const SHOW_RESOLVED_KEY = "synara:canvas-comments-show-resolved";

const lastActivity = (thread: CanvasCommentThread) => thread.messages.at(-1)!.createdAt;

const readShowResolved = () => {
  try {
    return executionStorage.getItem(SHOW_RESOLVED_KEY) !== "false";
  } catch {
    return true;
  }
};

/**
 * The Comments panel: every thread of the work,
 * with Search, Sort (Newest first, Oldest first, By page), author and page filters and a stored
 * Show resolved toggle; unread threads carry a dot. A row opens its thread on the canvas,
 * switching to its page, and pans to the pin; resolved rows reopen in place.
 */
export function CanvasCommentsPanel({ className }: { className?: string }) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const { work, page, activeCommentId } = editor;
  const actions = useCanvasCommentActions();
  const userInitial = useCommentUserInitial();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [author, setAuthor] = useState<Author>("anyone");
  const [pageFilter, setPageFilter] = useState<PageFilter>("any");
  const [showResolved, setShowResolved] = useState(readShowResolved);
  const toggleResolved = (value: boolean) => {
    setShowResolved(value);
    try {
      executionStorage.setItem(SHOW_RESOLVED_KEY, String(value));
    } catch {
      /* A remembered toggle is a convenience only. */
    }
  };
  const pageOrder = new Map(work.pages.map((item, at) => [item.id, at]));
  const all = work.pages.flatMap((item) => item.comments.map((thread) => ({ thread, page: item })));
  const needle = query.trim().toLowerCase();
  const shown = all
    .filter(({ thread, page: owner }) => {
      if (!showResolved && thread.status === "resolved") return false;
      if (pageFilter === "current" && owner.id !== page.id) return false;
      if (author !== "anyone" && thread.messages[0]!.author.kind !== author) return false;
      if (!needle) return true;
      return thread.messages.some((message) => message.text.toLowerCase().includes(needle));
    })
    .toSorted((a, b) => {
      if (sort === "page") {
        const byPage = pageOrder.get(a.page.id)! - pageOrder.get(b.page.id)!;
        if (byPage !== 0) return byPage;
      }
      const byTime = lastActivity(a.thread).localeCompare(lastActivity(b.thread));
      return sort === "oldest" ? byTime : -byTime;
    });
  const open = shown.filter(({ thread }) => thread.status === "open");
  const resolved = shown.filter(({ thread }) => thread.status === "resolved");
  const row = ({ thread, page: owner }: (typeof all)[number]) => (
    <CommentRow
      key={thread.id}
      thread={thread}
      title={owner.id === page.id ? canvasCommentTarget(editor, thread) : owner.title}
      pageTitle={sort === "page" || pageFilter === "any" ? owner.title : null}
      active={thread.id === activeCommentId}
      userInitial={userInitial}
      onSelect={() =>
        owner.id === page.id
          ? revealCanvasComment(editor, thread)
          : editor.openComment({ threadId: thread.id, pageId: owner.id })
      }
      onReopen={owner.id === page.id ? () => void actions.reopen(thread) : null}
    />
  );
  return (
    <div
      role="region"
      aria-label={t("workspace:canvasComments")}
      data-canvas-comments-list=""
      className={cn("flex min-h-0 flex-col", className)}
    >
      {all.length === 0 ? (
        <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground">
          {t("workspace:canvasCommentsEmpty")}
        </p>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
            <div className="min-w-0 flex-1">
              <SearchInput
                size="sm"
                value={query}
                placeholder={t("workspace:canvasCommentsSearch")}
                aria-label={t("workspace:canvasCommentsSearch")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={t("workspace:canvasCommentsFilters")}
                    tooltip={t("workspace:canvasCommentsFilters")}
                  >
                    <FilterIcon className="size-3.5" />
                  </IconButton>
                }
              >
                <FilterIcon className="size-3.5" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" className="w-52">
                <MenuGroup>
                  <MenuGroupLabel>{t("workspace:canvasCommentsSort")}</MenuGroupLabel>
                  <MenuRadioGroup value={sort} onValueChange={(value) => setSort(value as Sort)}>
                    <MenuRadioItem value="newest">
                      {t("workspace:canvasCommentsNewest")}
                    </MenuRadioItem>
                    <MenuRadioItem value="oldest">
                      {t("workspace:canvasCommentsOldest")}
                    </MenuRadioItem>
                    <MenuRadioItem value="page">
                      {t("workspace:canvasCommentsByPage")}
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>{t("workspace:canvasCommentsAuthor")}</MenuGroupLabel>
                  <MenuRadioGroup
                    value={author}
                    onValueChange={(value) => setAuthor(value as Author)}
                  >
                    <MenuRadioItem value="anyone">
                      {t("workspace:canvasCommentsAnyone")}
                    </MenuRadioItem>
                    <MenuRadioItem value="user">{t("workspace:canvasCommentYou")}</MenuRadioItem>
                    <MenuRadioItem value="agent">{t("workspace:canvasCommentAgent")}</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>{t("workspace:canvasCommentsPage")}</MenuGroupLabel>
                  <MenuRadioGroup
                    value={pageFilter}
                    onValueChange={(value) => setPageFilter(value as PageFilter)}
                  >
                    <MenuRadioItem value="any">
                      {t("workspace:canvasCommentsAnyPage")}
                    </MenuRadioItem>
                    <MenuRadioItem value="current">
                      {t("workspace:canvasCommentsThisPage")}
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuCheckboxItem checked={showResolved} onCheckedChange={toggleResolved}>
                  {t("workspace:canvasCommentsShowResolved")}
                </MenuCheckboxItem>
              </ComposerPickerMenuPopup>
            </Menu>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground">
                {t("workspace:canvasCommentsNoMatch")}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-3.5 pt-1 pb-1 text-ui-xs text-muted-foreground">
                  <span className="shrink-0">
                    {t("workspace:canvasCommentsOpenCount", { count: open.length })}
                  </span>
                </div>
                <SidebarMenu className="gap-px px-1.5">{open.map(row)}</SidebarMenu>
                {resolved.length > 0 && (
                  <div className="flex flex-col gap-px px-1.5 pt-2.5">
                    <span className="px-2 py-1 text-ui-xs text-muted-foreground">
                      {t("workspace:canvasCommentsResolvedCount", { count: resolved.length })}
                    </span>
                    <SidebarMenu className="gap-px">{resolved.map(row)}</SidebarMenu>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CommentRow({
  thread,
  title,
  pageTitle,
  active,
  userInitial,
  onSelect,
  onReopen,
}: {
  thread: CanvasCommentThread;
  title: string;
  /** The thread's page, when the list spans pages. */
  pageTitle: string | null;
  active: boolean;
  userInitial: string | null;
  onSelect: () => void;
  onReopen: (() => void) | null;
}) {
  const { t } = useTranslation();
  const first = thread.messages[0]!;
  const resolved = thread.status === "resolved";
  const replies = agentReplies(thread);
  const lastReply = replies.at(-1);
  const unread = !resolved && isCommentUnread(thread);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        data-comment-row={thread.id}
        className={cn(
          "h-auto items-start rounded-md px-2 py-1.75 text-ui",
          resolved && onReopen && "pe-20",
        )}
        onClick={onSelect}
      >
        <CommentAvatar author={first.author} userInitial={userInitial} resolved={resolved} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                "truncate text-ui-xs font-medium",
                resolved ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {title}
              {pageTitle && pageTitle !== title ? (
                <span className="font-normal text-muted-foreground">{` · ${pageTitle}`}</span>
              ) : null}
            </span>
            {!resolved && (
              <span className="flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground">
                {unread && (
                  <span
                    role="img"
                    aria-label={t("workspace:canvasCommentUnread")}
                    data-comment-unread=""
                    className="size-1.5 rounded-full bg-primary"
                  />
                )}
                {formatRelativeTime(lastActivity(thread))}
              </span>
            )}
          </div>
          <span
            className={cn(
              "line-clamp-2 text-ui-sm break-words",
              resolved ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {first.text}
          </span>
          {lastReply && !resolved && (
            <span className="flex items-center gap-1 pt-0.5 text-ui-xs text-muted-foreground">
              <CommentAgentGlyph author={lastReply.author} className="size-2.5" />
              {t("workspace:canvasCommentAgentReplied", { count: replies.length })}
            </span>
          )}
        </div>
      </SidebarMenuButton>
      {resolved && onReopen && (
        <Button
          variant="outline"
          size="xs"
          className="absolute end-2 top-1/2 -translate-y-1/2"
          onClick={onReopen}
        >
          {t("workspace:canvasCommentReopen")}
        </Button>
      )}
    </SidebarMenuItem>
  );
}
