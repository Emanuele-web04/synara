// FILE: GitHubItemPageLayout.tsx
// Purpose: The shell of a GitHub item's detail on the code review page, one for pull requests and
//          issues: a top bar (back on a narrow window, the tabs, then the actions at the right),
//          the loading / unavailable / not found states, and the tab bodies. The Summary body
//          scrolls with the info either in a right-hand column or folded into rows under the
//          header; the switch is a container query on the detail pane itself, so a narrow window
//          and an open side chat dock fold it the same way. Every tab floats the question
//          composer over its bottom.
// Layer: Pull request presentation
// Exports: GitHubItemDetailPage, GitHubItemTabs, GitHubItemPageBody, GitHubItemTabBody,
//          GitHubItemPageIconActions, GitHubItemAskComposer, GitHubItemPageHost,
//          PullRequestDetailSkeleton

import { useInPageGlassOverlay } from "~/hooks/useInPageGlassOverlay";
import type { ProjectId, ThreadId } from "@synara/contracts";
import { useState, type ReactNode } from "react";

import {
  CHAT_SURFACE_CHIP_CLASS_NAME,
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
} from "~/components/chat/chatHeaderControls";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { IconButton } from "~/components/ui/icon-button";
import { MenuItem } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { ChatBubbleIcon, ExternalLinkIcon, LinkIcon } from "~/lib/icons";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { SendToAgentMenuItems, type GitHubItemSendTarget } from "./GitHubItemAgentActions";
import { GitHubItemFloatingComposer } from "./GitHubItemFloatingComposer";
import { GitHubItemBackButton } from "./GitHubItemHeader";
import type { GitHubItemInfoThread, GitHubItemInfoVariant } from "./GitHubItemInfo";
import type { GitHubItemAgentTarget } from "./githubItemAgentContext";
import { copyPullRequestLink } from "./PullRequestConfirmActionDialog";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

/** What the code review page gives a detail panel beyond the item itself. */
export interface GitHubItemPageHost {
  /** The list row's pin, for the top bar's pin control. */
  pin?: { pinned: boolean; onToggle: () => void } | undefined;
  /** The item's side chats, for the Threads row. */
  threads: ReadonlyArray<GitHubItemInfoThread>;
  /** Shows that side chat in the dock, opening the dock when it is closed. */
  onOpenThread?: ((id: ThreadId) => void) | undefined;
  /** Opens the side chat dock without sending anything. */
  onAsk?: ((target: GitHubItemAgentTarget) => void) | undefined;
  /** The floating composer's submit; absent hides the composer. */
  onAskQuestion?: ((target: GitHubItemAgentTarget, text: string) => void) | undefined;
  askPending: boolean;
  /** False while the side chat dock is open: its own composer takes over. */
  composerVisible: boolean;
}

/** A page without the code review page around it: no pin, threads, or composer. */
export const DETACHED_GITHUB_ITEM_PAGE_HOST: GitHubItemPageHost = {
  threads: [],
  askPending: false,
  composerVisible: false,
};

export function PullRequestDetailSkeleton() {
  return (
    <div className="space-y-4 p-5">
      <Skeleton className="h-7 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** The floating composer of a detail page, wired to the host's side chat. */
export function GitHubItemAskComposer({
  noun,
  defaultProjectId,
  sendTargets,
  buildTarget,
  host,
  onSendToAgent,
}: {
  noun: "pull request" | "issue";
  defaultProjectId: ProjectId;
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  buildTarget: (projectId: ProjectId) => GitHubItemAgentTarget;
  host: GitHubItemPageHost;
  onSendToAgent: (projectId: ProjectId) => void;
}) {
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const projectId =
    chosenProjectId !== null && sendTargets.some((target) => target.projectId === chosenProjectId)
      ? chosenProjectId
      : defaultProjectId;
  if (!host.onAskQuestion || !host.composerVisible) return null;
  const { onAskQuestion, onAsk } = host;
  return (
    <GitHubItemFloatingComposer
      placeholder={`Ask about this ${noun}`}
      projects={sendTargets}
      projectId={projectId}
      onProjectChange={setChosenProjectId}
      pending={host.askPending}
      onSubmit={(text) => onAskQuestion(buildTarget(projectId), text)}
      plusMenu={
        <>
          {onAsk ? (
            <MenuItem onClick={() => onAsk(buildTarget(projectId))}>
              <ChatBubbleIcon className={MENU_ICON_CLASS_NAME} />
              <span>Open side chat</span>
            </MenuItem>
          ) : null}
          <SendToAgentMenuItems sendTargets={sendTargets} onSendToAgent={onSendToAgent} />
        </>
      }
    />
  );
}

export interface GitHubItemTabOption<T extends string> {
  value: T;
  label: string;
  /** Rides after the label (the Changes tab's diff counts). */
  trailing?: ReactNode;
}

/**
 * A detail's tab row: the flat chip skin of the chat surfaces' own tabs (the dock tab strip and
 * the header toggles), so the page and the chat dock switch tabs with the same control.
 */
export function GitHubItemTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: ReadonlyArray<GitHubItemTabOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the row ("Pull request detail tabs"). */
  label: string;
  className?: string;
}) {
  return (
    <nav className={cn("flex min-w-0 items-center gap-0.5", className)} aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            CHAT_SURFACE_CHIP_CLASS_NAME,
            "inline-flex items-center px-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @max-[46rem]/topbar:px-2",
            value === tab.value && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
          )}
        >
          {tab.label}
          {tab.trailing}
        </button>
      ))}
    </nav>
  );
}

/** Pin, copy link, and open on GitHub: the quiet icon actions at the top bar's right. */
export function GitHubItemPageIconActions({
  url,
  itemLabel,
  pin,
}: {
  url: string;
  /** "pull request #12", for the pin control's accessible name. */
  itemLabel: string;
  pin: { pinned: boolean; onToggle: () => void } | undefined;
}) {
  return (
    <>
      {pin ? (
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={pinActionLabel(itemLabel, pin.pinned)}
          tooltip={pinActionLabel(itemLabel, pin.pinned)}
          tooltipSide="bottom"
          aria-pressed={pin.pinned}
          onClick={pin.onToggle}
        >
          <PinStatusIcon pinned={pin.pinned} className="size-4" aria-hidden />
        </IconButton>
      ) : null}
      <IconButton
        variant="ghost"
        size="icon-sm"
        label="Copy link"
        tooltip="Copy link"
        tooltipSide="bottom"
        onClick={() => copyPullRequestLink(url)}
      >
        <LinkIcon className="size-4" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label="Open on GitHub"
        tooltip="Open on GitHub"
        tooltipSide="bottom"
        onClick={() => void ensureNativeApi().shell.openExternal(url)}
      >
        <ExternalLinkIcon className="size-4" />
      </IconButton>
    </>
  );
}

/**
 * The whole detail page: the top bar, then the query's loading, unavailable, and not found
 * states, or the loaded tab body under any banners.
 */
export function GitHubItemDetailPage({
  onBack,
  tabs,
  actions,
  query,
  notFound,
  banners,
  children,
  overlay,
}: {
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: (() => void) | undefined;
  tabs: ReactNode;
  actions: ReactNode;
  query: {
    isPending: boolean;
    /** The first load's failure; later refresh failures are banners. */
    initialError: unknown;
    /** What could not be loaded, for the unavailable state ("Issues"). */
    subject?: string;
    onRetry: () => void;
    loaded: boolean;
  };
  notFound: { title: string; description: string };
  /** Warnings over the body (a failed background refresh). */
  banners?: ReactNode;
  children: ReactNode;
  /** Rendered after the body, outside the layout (confirm dialogs). */
  overlay?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col app-content-surface text-foreground">
      {/* The top bar is its own container so its controls can tighten once it is narrow (the
          side chat is open) and stay on one row; if even that is too narrow the actions wrap
          under the tabs, still right-aligned. */}
      <div className="@container/topbar shrink-0">
        <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 @max-[46rem]/topbar:px-2">
          <div className="flex shrink-0 items-center gap-0.5">
            {onBack ? <GitHubItemBackButton onBack={onBack} /> : null}
            {tabs}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 @max-[46rem]/topbar:gap-1">
            {actions}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {query.isPending ? (
          <PullRequestDetailSkeleton />
        ) : query.initialError ? (
          <PullRequestsUnavailableState
            error={query.initialError}
            {...(query.subject ? { subject: query.subject } : {})}
            onRetry={query.onRetry}
          />
        ) : !query.loaded ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{notFound.title}</EmptyTitle>
              <EmptyDescription>{notFound.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {banners}
            {children}
          </>
        )}
      </div>
      {overlay}
    </div>
  );
}

/** Floats the question composer over the bottom right of a tab body. */
function FloatingComposerSlot({ composer }: { composer: ReactNode }) {
  // The composer floats over the tab body; on a glass window that body is cut out from under
  // it, so it can take the same raised tint as the chat composer (see index.css).
  const glassOverlayRef = useInPageGlassOverlay<HTMLDivElement>(Boolean(composer));
  if (!composer) return null;
  return (
    <div
      ref={glassOverlayRef}
      data-glass-cutout=""
      className="pointer-events-none absolute right-4 bottom-4 left-4 flex justify-end"
    >
      <div className="pointer-events-auto w-full max-w-[40rem]">{composer}</div>
    </div>
  );
}

/** The Summary body: the header, the info (rows or column), and the item's own content. */
export function GitHubItemPageBody({
  header,
  info,
  children,
  composer,
}: {
  header: ReactNode;
  /** The info in either shape: rows under the header in a narrow pane, a column in a wide one. */
  info: (variant: GitHubItemInfoVariant) => ReactNode;
  children: ReactNode;
  composer?: ReactNode;
}) {
  return (
    <div className="@container/detail relative min-h-0 flex-1">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[76rem] items-start gap-12 px-6 pt-1 pb-44">
          <div className="min-w-0 flex-1">
            {header}
            <div className="mb-4 @min-[52rem]/detail:hidden">{info("rows")}</div>
            {children}
          </div>
          <aside
            aria-label="Details"
            className="sticky top-1 hidden w-[22rem] shrink-0 @min-[52rem]/detail:block"
          >
            {info("column")}
          </aside>
        </div>
      </div>
      <FloatingComposerSlot composer={composer} />
    </div>
  );
}

/** Any other tab (Changes, Timeline): a one-line title over the tab's own scrolling content. */
export function GitHubItemTabBody({
  glyph,
  title,
  composer,
  children,
}: {
  glyph: ReactNode;
  title: string;
  composer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 pb-2">
        {glyph}
        <h1 className="m-0 min-w-0 truncate text-ui-lg font-medium">{title}</h1>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <FloatingComposerSlot composer={composer} />
    </div>
  );
}
