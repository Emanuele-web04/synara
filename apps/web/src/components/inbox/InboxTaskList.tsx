// FILE: InboxTaskList.tsx
// Purpose: The Inbox's task column: Needs you, In progress, Ready for review, and Failed
//          groups of threads (plus pull requests and automation runs waiting on the user).
//          Empty groups never render; the column is left out entirely when all are empty.
// Layer: Inbox UI
// Exports: InboxTaskList, Group

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { useId, type DragEvent, type ReactNode } from "react";

import { Spinner } from "~/components/ui/spinner";
import { beginThreadDrag, endThreadDrag } from "~/lib/threadDrag";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  GitPullRequestIcon,
  XIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { resolveThreadDisplayProvider } from "~/lib/threadDisplayProvider";
import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_FOCUS_CLASS_NAME } from "~/sidebarRowStyles";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import type { Project, SidebarThreadSummary } from "~/types";
import { DiffStat } from "../chat/DiffStatLabel";
import { ProviderIcon } from "../ProviderIcon";
import { resolveThreadProjectLabel, type SidebarActionBadge } from "../Sidebar.logic";
import type { InboxThreadGroups, NeedsYouKind } from "./inbox.logic";

const NEEDS_YOU_REASONS: Partial<Record<NeedsYouKind, string>> = {
  approval: "approve a command",
  input: "has a question",
  plan: "plan ready",
};

type RowTone = "attention" | "working" | "done" | "failed" | "link";

function RowIcon({ tone, icon }: { tone: RowTone; icon?: ReactNode }) {
  const className = "size-4 shrink-0";
  switch (tone) {
    case "attention":
      return <CircleAlertIcon className={cn(className, "text-info")} aria-hidden />;
    case "working":
      return <Spinner className={cn(className, "text-muted-foreground")} aria-hidden />;
    case "done":
      return <CircleCheckIcon className={cn(className, "text-status-success")} aria-hidden />;
    case "failed":
      return (
        <span
          className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-destructive text-destructive"
          aria-hidden
        >
          <XIcon className="size-2.5" />
        </span>
      );
    case "link":
      return <>{icon}</>;
  }
}

function TaskRow({
  tone,
  icon,
  title,
  meta,
  time,
  onOpen,
  threadId,
}: {
  tone: RowTone;
  icon?: ReactNode;
  title: string;
  meta: ReactNode;
  time?: string | undefined;
  onOpen: () => void;
  threadId?: ThreadId | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      {...(threadId
        ? {
            draggable: true,
            onDragStart: (event: DragEvent<HTMLButtonElement>) => beginThreadDrag(event, threadId),
            onDragEnd: endThreadDrag,
          }
        : {})}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 rounded-xl px-3 py-2 text-left",
        SIDEBAR_ROW_FOCUS_CLASS_NAME,
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
    >
      <span className="mt-0.5 flex">
        <RowIcon tone={tone} icon={icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui leading-5 text-foreground">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-ui-sm text-muted-foreground">
          {meta}
        </span>
      </span>
      {time ? (
        <span className="mt-0.5 shrink-0 text-ui-sm tabular-nums text-muted-foreground">
          {time}
        </span>
      ) : null}
    </button>
  );
}

export function Group({
  label,
  count,
  action,
  children,
}: {
  label: string;
  count: number;
  /** A quiet control at the end of the heading row. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="flex h-7 items-center justify-between gap-3 px-3">
        <h2
          id={headingId}
          className="flex items-center gap-1.5 text-ui-sm font-normal text-muted-foreground"
        >
          {label}
          <span className="text-muted-foreground/60 tabular-nums">{count}</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ThreadMeta({
  thread,
  project,
  reason,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  reason?: string | undefined;
}) {
  const pr = thread.lastKnownPr;
  return (
    <>
      <ProviderIcon
        provider={resolveThreadDisplayProvider(thread)}
        className="size-3 shrink-0 opacity-80"
      />
      {pr ? (
        <DiffStat
          additions={pr.additions ?? 0}
          deletions={pr.deletions ?? 0}
          className="shrink-0"
        />
      ) : null}
      <span className="truncate">
        {resolveThreadProjectLabel(project)}
        {reason ? `, ${reason}` : ""}
      </span>
    </>
  );
}

export function InboxTaskList({
  groups,
  projectById,
  reviewRequests,
  automationAttention,
  onOpenThread,
  onOpenPullRequests,
  onOpenAutomations,
}: {
  groups: InboxThreadGroups;
  projectById: ReadonlyMap<string, Project>;
  /** Pull requests waiting on the user's review, as the rail badge shows them ("3+"). */
  reviewRequests: { readonly count: number; readonly badge: SidebarActionBadge } | null;
  automationAttention: number;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenPullRequests: () => void;
  onOpenAutomations: () => void;
}) {
  const needsYouCount = groups.needsYou.length + (reviewRequests?.count ?? 0) + automationAttention;
  const threadRow = (thread: SidebarThreadSummary, tone: RowTone, reason?: string) => (
    <TaskRow
      key={thread.id}
      tone={tone}
      threadId={thread.id}
      title={thread.title}
      meta={
        <ThreadMeta thread={thread} project={projectById.get(thread.projectId)} reason={reason} />
      }
      time={formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
      onOpen={() => onOpenThread(thread.id)}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {needsYouCount > 0 ? (
        <Group label="Needs you" count={needsYouCount}>
          {groups.needsYou.map((item) =>
            threadRow(item.thread, "attention", NEEDS_YOU_REASONS[item.kind]),
          )}
          {reviewRequests ? (
            <TaskRow
              tone="link"
              icon={<GitPullRequestIcon className="size-4 shrink-0 text-info" aria-hidden />}
              title={`${reviewRequests.badge.text} ${pluralize(
                reviewRequests.count,
                "pull request",
              )} to review`}
              meta="GitHub"
              onOpen={onOpenPullRequests}
            />
          ) : null}
          {automationAttention > 0 ? (
            <TaskRow
              tone="link"
              icon={<ClockIcon className="size-4 shrink-0 text-info" aria-hidden />}
              title={`${automationAttention} ${pluralize(
                automationAttention,
                "automation run",
              )} to check`}
              meta="Automations"
              onOpen={onOpenAutomations}
            />
          ) : null}
        </Group>
      ) : null}
      {groups.working.length > 0 ? (
        <Group label="In progress" count={groups.working.length}>
          {groups.working.map((thread) => threadRow(thread, "working"))}
        </Group>
      ) : null}
      {groups.finished.length > 0 ? (
        <Group label="Ready for review" count={groups.finished.length}>
          {groups.finished.map((thread) => threadRow(thread, "done"))}
        </Group>
      ) : null}
      {groups.failed.length > 0 ? (
        <Group label="Failed" count={groups.failed.length}>
          {groups.failed.map((thread) => threadRow(thread, "failed", "turn failed"))}
        </Group>
      ) : null}
    </div>
  );
}
