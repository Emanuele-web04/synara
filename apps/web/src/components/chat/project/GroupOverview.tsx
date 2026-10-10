// FILE: GroupOverview.tsx
// Purpose: Section bodies for the Group panel — Threads grouped by live state,
//          Pull requests opened by group threads, and group-scoped Automations.
//          The panel hoists the derivation (thread rows, PR rows, automation
//          scoping) so each row's count and its expanded body read the same data.
// Layer: Group panel UI
// Why: Claude Code's Projects Overview lists every thread by live state; this is
//      Synara's version, derived from the same helpers the sidebar uses.

import type { AutomationDefinition, ThreadId } from "@synara/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { IconButton } from "~/components/ui/icon-button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { PrStateChip } from "~/components/pullRequest/PrStateChip";
import { resolvePrStatePresentation } from "~/components/pullRequest/pullRequestStatePresentation";
import {
  EnvironmentCollapsibleSection,
  EnvironmentSectionLabel,
} from "~/components/chat/environment/EnvironmentRow";
import { CheckIcon, Columns2Icon, EllipsisIcon, GitHubIcon, RotateCcwIcon } from "~/lib/icons";
import { formatSchedule } from "~/lib/automationForm";
import { formatRelativeTime } from "~/lib/relativeTime";
import { archiveThreadFromClient, unarchiveThreadFromClient } from "~/lib/threadArchive";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { useAutomations } from "~/routes/-automations.shared";

import {
  GROUP_THREAD_SECTIONS,
  type GroupPullRequestRow,
  type GroupThreadRow as GroupThreadRowData,
  type GroupThreadSectionId,
} from "./groupOverview.logic";
import type { useProjectAgent } from "./useProjectAgent";

type ProjectAgent = ReturnType<typeof useProjectAgent>;
type Automations = ReturnType<typeof useAutomations>;

// The native context menu renders icons from SVG markup, so the same glyphs used
// in React rows are rasterized once here.
const RESOLVE_MENU_ICON = renderToStaticMarkup(<CheckIcon />);
const SPLIT_VIEW_MENU_ICON = renderToStaticMarkup(<Columns2Icon />);
const REOPEN_MENU_ICON = renderToStaticMarkup(<RotateCcwIcon />);

// Row titles use the same size and weight as Environment panel rows, never the
// panel's ambient font size.
const GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME = "min-w-0 truncate text-ui font-normal text-foreground";

// Empty states line up with the panel's rows instead of centring in a narrow column.
const GROUP_PANEL_EMPTY_STATE_CLASS_NAME = "justify-start px-2 py-1 text-left";

// — Threads —

export function GroupThreadsSection({
  sections,
  sectionIds,
  emptyMessage,
  agent,
  onOpenThread,
  onOpenThreadSplit,
}: {
  readonly sections: ReadonlyMap<GroupThreadSectionId, readonly GroupThreadRowData[]>;
  /** Limit the rendered state buckets; defaults to all five. */
  readonly sectionIds?: readonly GroupThreadSectionId[] | undefined;
  readonly emptyMessage?: string | undefined;
  readonly agent: ProjectAgent;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenThreadSplit: (threadId: ThreadId) => void;
}) {
  const visibleSections = sectionIds
    ? GROUP_THREAD_SECTIONS.filter((section) => sectionIds.includes(section.id))
    : GROUP_THREAD_SECTIONS;
  const totalRows = visibleSections.reduce(
    (count, section) => count + (sections.get(section.id)?.length ?? 0),
    0,
  );
  if (totalRows === 0) {
    return (
      <PanelStateMessage density="compact" className={GROUP_PANEL_EMPTY_STATE_CLASS_NAME}>
        <p>
          {emptyMessage ??
            "No threads yet. Ask the coordinator for work and it will start threads here."}
        </p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {visibleSections.map((section) => {
        const rows = sections.get(section.id) ?? [];
        if (rows.length === 0) return null;
        const label = (
          <span className="flex items-center gap-1.5">
            <span>{section.label}</span>
            <span className="tabular-nums">{rows.length}</span>
          </span>
        );
        const list = (
          <div className="flex flex-col">
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
        );
        // Live states are plain labels; only the collapsed-by-default Resolved
        // bucket needs a disclosure, so no chevron sits on every heading.
        return section.defaultOpen ? (
          <section key={section.id} className="flex flex-col">
            <EnvironmentSectionLabel>{label}</EnvironmentSectionLabel>
            {list}
          </section>
        ) : (
          <EnvironmentCollapsibleSection key={section.id} defaultOpen={false} label={label}>
            {list}
          </EnvironmentCollapsibleSection>
        );
      })}
    </div>
  );
}

export function GroupThreadRow({
  row,
  agent,
  onOpenThread,
  onOpenThreadSplit,
}: {
  readonly row: GroupThreadRowData;
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
  const updatedLabel = formatRelativeTime(row.thread.updatedAt ?? row.thread.createdAt);
  // One line per thread: state dot, title, and a quiet trailing meta that gives
  // way to the actions button on hover. The task line rides in the tooltip.
  const meta = row.projectName ? `${row.projectName} · ${updatedLabel}` : updatedLabel;
  return (
    <div
      className="group/grouprow flex h-7 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={row.taskLine ? `${threadTitle} — ${row.taskLine}` : threadTitle}
        onClick={() => onOpenThread(row.thread.id)}
      >
        <span
          className={cn(
            "block size-1.5 shrink-0 rounded-full",
            dotClassName,
            pulse && "animate-pulse",
          )}
          aria-hidden
        />
        <span className={GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME}>{threadTitle}</span>
        {row.pullRequest ? <PrStateChip pr={row.pullRequest} /> : null}
      </button>
      <span className="max-w-24 shrink-0 truncate text-ui-xs text-muted-foreground group-focus-within/grouprow:hidden group-hover/grouprow:hidden">
        {meta}
      </span>
      <IconButton
        type="button"
        label={`Thread actions for ${threadTitle}`}
        tooltip="Thread actions"
        className="hidden group-focus-within/grouprow:inline-flex group-hover/grouprow:inline-flex"
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

export function GroupPullRequestsSection({
  rows,
  onOpenThread,
}: {
  readonly rows: readonly GroupPullRequestRow[];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  if (rows.length === 0) {
    return (
      <PanelStateMessage density="compact" className={GROUP_PANEL_EMPTY_STATE_CLASS_NAME}>
        <p>No pull requests yet. PRs opened by hub threads land here.</p>
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

export function GroupAutomationsSection({
  definitions,
  automations,
  onOpenAutomation,
}: {
  readonly definitions: readonly AutomationDefinition[];
  readonly automations: Automations;
  readonly onOpenAutomation: (automationId: string) => void;
}) {
  if (automations.isLoading && definitions.length === 0) {
    return (
      <PanelStateMessage density="compact" className={GROUP_PANEL_EMPTY_STATE_CLASS_NAME}>
        <p>Loading automations…</p>
      </PanelStateMessage>
    );
  }
  if (definitions.length === 0) {
    return (
      <PanelStateMessage density="compact" className={GROUP_PANEL_EMPTY_STATE_CLASS_NAME}>
        <p>No automations yet. Ask the coordinator to check something on a schedule.</p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {definitions.map((definition) => (
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
