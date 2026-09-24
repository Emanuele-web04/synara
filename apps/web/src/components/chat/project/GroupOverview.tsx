// FILE: GroupOverview.tsx
// Purpose: The Group panel's Overview body — Threads grouped by live state, Pull
//          requests opened by group threads, and group-scoped Automations.
// Layer: Group panel UI
// Why: Claude Code's Projects Overview lists every thread by live state; this is
//      Synara's version, derived from the same helpers the sidebar uses.

import type { AutomationDefinition, ProjectId, ProjectTask, ThreadId } from "@synara/contracts";
import { type MouseEvent as ReactMouseEvent, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { IconButton } from "~/components/ui/icon-button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { PrStateChip } from "~/components/pullRequest/PrStateChip";
import { resolvePrStatePresentation } from "~/components/pullRequest/pullRequestStatePresentation";
import { ProviderIcon } from "~/components/ProviderIcon";
import { EnvironmentSectionLabel } from "~/components/chat/environment/EnvironmentRow";
import { useThreadPullRequests } from "~/hooks/useThreadPullRequests";
import { CheckIcon, Columns2Icon, EllipsisIcon, GitHubIcon, RotateCcwIcon } from "~/lib/icons";
import { formatSchedule } from "~/lib/automationForm";
import { formatRelativeTime } from "~/lib/relativeTime";
import { archiveThreadFromClient, unarchiveThreadFromClient } from "~/lib/threadArchive";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useAutomations } from "~/routes/-automations.shared";

import type { SidebarThreadSummary } from "~/types";
import {
  GROUP_THREAD_SECTIONS,
  buildGroupThreadRows,
  collectGroupAutomations,
  collectGroupPullRequestRows,
  partitionGroupThreadRows,
  type GroupThreadRow,
  type GroupThreadSectionId,
} from "./groupOverview.logic";
import type { useProjectAgent } from "./useProjectAgent";

type ProjectAgent = ReturnType<typeof useProjectAgent>;

type GroupOverviewTab = "threads" | "pull-requests" | "automations";

const GROUP_OVERVIEW_TAB_OPTIONS: ReadonlyArray<{
  readonly value: GroupOverviewTab;
  readonly label: string;
}> = [
  { value: "threads", label: "Threads" },
  { value: "pull-requests", label: "Pull requests" },
  { value: "automations", label: "Automations" },
];

// The native context menu renders icons from SVG markup, so the same glyphs used
// in React rows are rasterized once here.
const RESOLVE_MENU_ICON = renderToStaticMarkup(<CheckIcon />);
const SPLIT_VIEW_MENU_ICON = renderToStaticMarkup(<Columns2Icon />);
const REOPEN_MENU_ICON = renderToStaticMarkup(<RotateCcwIcon />);

const EMPTY_THREADS: readonly SidebarThreadSummary[] = [];

// Row titles size off the same token as sidebar thread rows and the Focus card,
// never the panel's ambient font size.
const GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME = "min-w-0 truncate text-ui font-medium text-foreground";

export function GroupOverview({
  groupProjectId,
  groupName,
  memberThreadIds,
  groupThreads,
  projectNameById,
  projectCwdById,
  agent,
  onOpenThread,
  onOpenThreadSplit,
  onOpenAutomation,
}: {
  readonly groupProjectId: ProjectId;
  readonly groupName: string;
  readonly memberThreadIds: ReadonlySet<ThreadId>;
  readonly groupThreads: readonly SidebarThreadSummary[];
  readonly projectNameById: ReadonlyMap<ProjectId, string>;
  readonly projectCwdById: ReadonlyMap<ProjectId, string>;
  readonly agent: ProjectAgent;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenThreadSplit: (threadId: ThreadId) => void;
  readonly onOpenAutomation: (automationId: string) => void;
}) {
  const [tab, setTab] = useState<GroupOverviewTab>("threads");
  const wantsPullRequests = tab === "threads" || tab === "pull-requests";
  const pullRequestsByThreadId = useThreadPullRequests({
    // An empty thread list registers zero queries — the Automations tab stays cheap.
    threads: wantsPullRequests ? groupThreads : EMPTY_THREADS,
    projectCwdById,
  });

  const taskByThreadId = useMemo(() => {
    const map = new Map<ThreadId, ProjectTask>();
    for (const task of agent.tasks) {
      if (task.assignedThreadId) map.set(task.assignedThreadId, task);
    }
    return map;
  }, [agent.tasks]);
  const indexArchivedThreadIds = useMemo(
    () => new Set(agent.threads.filter((entry) => entry.archived).map((entry) => entry.threadId)),
    [agent.threads],
  );

  const threadRows = useMemo(
    () =>
      buildGroupThreadRows({
        threads: groupThreads,
        taskByThreadId,
        indexArchivedThreadIds,
        pullRequests: pullRequestsByThreadId,
        projectNameById,
        groupProjectId,
        groupProjectName: groupName,
      }),
    [
      groupThreads,
      taskByThreadId,
      indexArchivedThreadIds,
      pullRequestsByThreadId,
      projectNameById,
      groupProjectId,
      groupName,
    ],
  );
  const threadSections = useMemo(() => partitionGroupThreadRows(threadRows), [threadRows]);

  const pullRequestRows = useMemo(
    () =>
      collectGroupPullRequestRows({
        threads: groupThreads,
        pullRequests: pullRequestsByThreadId,
        projectNameById,
        groupProjectId,
        groupProjectName: groupName,
      }),
    [groupThreads, pullRequestsByThreadId, projectNameById, groupProjectId, groupName],
  );

  return (
    <div className="flex flex-col px-1 pb-1">
      <div className="px-1 py-1">
        <SettingsSegmentedControl
          value={tab}
          onValueChange={setTab}
          options={GROUP_OVERVIEW_TAB_OPTIONS}
          ariaLabel="Overview sections"
        />
      </div>
      {tab === "threads" ? (
        <GroupThreadsTab
          sections={threadSections}
          agent={agent}
          onOpenThread={onOpenThread}
          onOpenThreadSplit={onOpenThreadSplit}
        />
      ) : null}
      {tab === "pull-requests" ? (
        <GroupPullRequestsTab rows={pullRequestRows} onOpenThread={onOpenThread} />
      ) : null}
      {tab === "automations" ? (
        <GroupAutomationsTab
          groupProjectId={groupProjectId}
          memberThreadIds={memberThreadIds}
          onOpenAutomation={onOpenAutomation}
        />
      ) : null}
    </div>
  );
}

// — Threads —

function GroupThreadsTab({
  sections,
  agent,
  onOpenThread,
  onOpenThreadSplit,
}: {
  readonly sections: ReadonlyMap<GroupThreadSectionId, readonly GroupThreadRow[]>;
  readonly agent: ProjectAgent;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenThreadSplit: (threadId: ThreadId) => void;
}) {
  // Sections toggled away from their default: "Resolved" starts collapsed and the
  // rest start open, so the set records the direction change, not the collapsed state.
  const [toggledSections, setToggledSections] = useState<ReadonlySet<GroupThreadSectionId>>(
    () => new Set(),
  );
  const totalRows = GROUP_THREAD_SECTIONS.reduce(
    (count, section) => count + (sections.get(section.id)?.length ?? 0),
    0,
  );
  if (totalRows === 0) {
    return (
      <PanelStateMessage density="compact">
        <p>No threads yet. Ask the coordinator for work and it will start threads here.</p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {GROUP_THREAD_SECTIONS.map((section) => {
        const rows = sections.get(section.id) ?? [];
        if (rows.length === 0) return null;
        const collapsed = section.defaultOpen === toggledSections.has(section.id);
        const toggleSection = () => {
          setToggledSections((current) => {
            const next = new Set(current);
            if (next.has(section.id)) next.delete(section.id);
            else next.add(section.id);
            return next;
          });
        };
        return (
          <section key={section.id} className="flex flex-col">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left"
              aria-expanded={!collapsed}
              onClick={toggleSection}
            >
              <DisclosureChevron open={!collapsed} className="size-3 shrink-0 opacity-70" />
              <span className="flex-1">
                <EnvironmentSectionLabel>{section.label}</EnvironmentSectionLabel>
              </span>
              <span className="text-ui-xs text-muted-foreground/80">{rows.length}</span>
            </button>
            {collapsed ? null : (
              <div className="flex flex-col gap-0.5">
                {rows.map((row) => (
                  <GroupThreadRow
                    key={row.thread.id}
                    row={row}
                    agent={agent}
                    onOpenThread={onOpenThread}
                    onOpenThreadSplit={onOpenThreadSplit}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function GroupThreadRow({
  row,
  agent,
  onOpenThread,
  onOpenThreadSplit,
}: {
  readonly row: GroupThreadRow;
  readonly agent: ProjectAgent;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenThreadSplit: (threadId: ThreadId) => void;
}) {
  const section = GROUP_THREAD_SECTIONS.find((candidate) => candidate.id === row.state);
  const dotClassName = section?.dotClass ?? "bg-muted-foreground/40";
  const pulse = section?.pulse === true;

  const markResolved = () => {
    if (row.task) {
      void agent.updateTaskStatus(row.task, { status: "done" }).then((ok) => {
        if (!ok) toastManager.add({ type: "error", title: "Could not mark the task resolved." });
      });
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    void archiveThreadFromClient(api.orchestration, row.thread.id).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not archive the thread.",
        description: cause instanceof Error ? cause.message : undefined,
      });
    });
  };

  const reopen = () => {
    if (row.task) {
      void agent.updateTaskStatus(row.task, { status: "ready", archived: false }).then((ok) => {
        if (!ok) toastManager.add({ type: "error", title: "Could not reopen the task." });
      });
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    void unarchiveThreadFromClient(api.orchestration, row.thread.id).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not reopen the thread.",
        description: cause instanceof Error ? cause.message : undefined,
      });
    });
  };

  const showRowMenu = async (position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        row.state === "resolved"
          ? { id: "reopen" as const, label: "Reopen", icon: REOPEN_MENU_ICON }
          : { id: "resolve" as const, label: "Mark resolved", icon: RESOLVE_MENU_ICON },
        {
          id: "split" as const,
          label: "Open in split view",
          icon: SPLIT_VIEW_MENU_ICON,
          separatorBefore: true,
        },
      ],
      position,
    );
    if (clicked === "resolve") markResolved();
    if (clicked === "reopen") reopen();
    if (clicked === "split") onOpenThreadSplit(row.thread.id);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    void showRowMenu({ x: event.clientX, y: event.clientY });
  };

  const threadTitle = row.thread.title.trim() || "Untitled thread";
  return (
    <div
      className="group/grouprow flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-foreground/5"
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
        onClick={() => onOpenThread(row.thread.id)}
      >
        <span className="relative mt-1.5 shrink-0" aria-hidden>
          <span
            className={cn("block size-2 rounded-full", dotClassName, pulse && "animate-pulse")}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <ProviderIcon
              provider={row.thread.session?.provider ?? null}
              className="size-3 shrink-0 opacity-70"
            />
            <span className={GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME}>{threadTitle}</span>
            {row.pullRequest ? <PrStateChip pr={row.pullRequest} /> : null}
          </span>
          <span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
            {row.projectName ? <span className="truncate">{row.projectName}</span> : null}
            {row.taskLine ? <span className="truncate">{row.taskLine}</span> : null}
            <span className="shrink-0">
              {formatRelativeTime(row.thread.updatedAt ?? row.thread.createdAt)}
            </span>
          </span>
        </span>
      </button>
      <IconButton
        type="button"
        label={`Thread actions for ${threadTitle}`}
        tooltip="Thread actions"
        className="opacity-0 group-hover/grouprow:opacity-100"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          void showRowMenu({ x: rect.right, y: rect.bottom });
        }}
      >
        <EllipsisIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}

// — Pull requests —

function GroupPullRequestsTab({
  rows,
  onOpenThread,
}: {
  readonly rows: ReadonlyArray<{
    readonly thread: SidebarThreadSummary;
    readonly pullRequest: NonNullable<GroupThreadRow["pullRequest"]>;
    readonly projectName: string | null;
  }>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  if (rows.length === 0) {
    return (
      <PanelStateMessage density="compact">
        <p>No pull requests yet. PRs opened by group threads land here.</p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((row) => {
        const presentation = resolvePrStatePresentation(row.pullRequest);
        return (
          <div
            key={row.thread.id}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
              onClick={() => onOpenThread(row.thread.id)}
            >
              <span className="flex items-center gap-1.5">
                <PrStateChip pr={row.pullRequest} />
                <span className={GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME}>{row.pullRequest.title}</span>
              </span>
              <span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
                <span>{presentation.label}</span>
                {row.projectName ? <span className="truncate">{row.projectName}</span> : null}
                <span className="truncate">in {row.thread.title}</span>
              </span>
            </button>
            <IconButton
              type="button"
              label={`Open #${row.pullRequest.number} on GitHub`}
              tooltip="Open on GitHub"
              onClick={() => {
                void readNativeApi()?.shell.openExternal(row.pullRequest.url);
              }}
            >
              <GitHubIcon className="size-3.5" />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

// — Automations —

function GroupAutomationsTab({
  groupProjectId,
  memberThreadIds,
  onOpenAutomation,
}: {
  readonly groupProjectId: ProjectId;
  readonly memberThreadIds: ReadonlySet<ThreadId>;
  readonly onOpenAutomation: (automationId: string) => void;
}) {
  const automations = useAutomations();
  const scoped = useMemo(
    () =>
      collectGroupAutomations({
        definitions: automations.data.definitions,
        groupProjectId,
        memberThreadIds,
      }),
    [automations.data.definitions, groupProjectId, memberThreadIds],
  );

  if (automations.isLoading && scoped.length === 0) {
    return (
      <PanelStateMessage density="compact">
        <p>Loading automations…</p>
      </PanelStateMessage>
    );
  }
  if (scoped.length === 0) {
    return (
      <PanelStateMessage density="compact">
        <p>No automations yet. Ask the coordinator to check something on a schedule.</p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {scoped.map((definition) => (
        <GroupAutomationRow
          key={definition.id}
          definition={definition}
          lastRun={automations.runsByAutomationId.get(definition.id)?.[0] ?? null}
          pending={automations.updateMutation.isPending}
          onToggleEnabled={(enabled) =>
            automations.updateMutation.mutate({ id: definition.id, enabled })
          }
          onOpen={() => onOpenAutomation(definition.id)}
        />
      ))}
    </div>
  );
}

function GroupAutomationRow({
  definition,
  lastRun,
  pending,
  onToggleEnabled,
  onOpen,
}: {
  readonly definition: AutomationDefinition;
  readonly lastRun: { readonly scheduledFor: string; readonly status: string } | null;
  readonly pending: boolean;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-foreground/5">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        onClick={onOpen}
      >
        <span className={GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME}>{definition.name}</span>
        <span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
          <span className="truncate">{formatSchedule(definition.schedule)}</span>
          <span>
            {lastRun ? `Last run ${formatRelativeTime(lastRun.scheduledFor)}` : "Never run"}
          </span>
        </span>
      </button>
      <Switch
        checked={definition.enabled}
        disabled={pending}
        aria-label={`Enable ${definition.name}`}
        onCheckedChange={onToggleEnabled}
      />
    </div>
  );
}
