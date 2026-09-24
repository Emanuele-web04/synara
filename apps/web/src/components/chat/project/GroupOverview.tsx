// FILE: GroupOverview.tsx
// Purpose: Section bodies for the Group panel's bottom section bar — Threads
//          grouped by live state, Pull requests opened by group threads, and
//          group-scoped Automations. The panel hoists the derivation (thread
//          rows, PR rows, automation scoping) so the bar's badges and the
//          expanded body read the same data.
// Layer: Group panel UI
// Why: Claude Code's Projects Overview lists every thread by live state; this is
//      Synara's version, derived from the same helpers the sidebar uses.

import type { AutomationDefinition, ThreadId } from "@synara/contracts";
import { type MouseEvent as ReactMouseEvent, useEffect, useId, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { IconButton } from "~/components/ui/icon-button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { PrStateChip } from "~/components/pullRequest/PrStateChip";
import { resolvePrStatePresentation } from "~/components/pullRequest/pullRequestStatePresentation";
import { ProviderIcon } from "~/components/ProviderIcon";
import { EnvironmentSectionLabel } from "~/components/chat/environment/EnvironmentRow";
import { CheckIcon, Columns2Icon, EllipsisIcon, GitHubIcon, RotateCcwIcon } from "~/lib/icons";
import type { GroupPanelSectionDescriptor, GroupPanelSectionId } from "./groupPanelSections";
import { formatSchedule } from "~/lib/automationForm";
import { formatRelativeTime } from "~/lib/relativeTime";
import { archiveThreadFromClient, unarchiveThreadFromClient } from "~/lib/threadArchive";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { useAutomations } from "~/routes/-automations.shared";
import type { SidebarThreadSummary } from "~/types";

import {
  GROUP_THREAD_SECTIONS,
  type GroupPullRequestRow,
  type GroupThreadRow as GroupThreadRowData,
  type GroupThreadSectionId,
} from "./groupOverview.logic";
import { buildGroupThreadActivitySeries } from "./groupThreadActivity.logic";
import type { useProjectAgent } from "./useProjectAgent";

type ProjectAgent = ReturnType<typeof useProjectAgent>;
type Automations = ReturnType<typeof useAutomations>;

// The native context menu renders icons from SVG markup, so the same glyphs used
// in React rows are rasterized once here.
const RESOLVE_MENU_ICON = renderToStaticMarkup(<CheckIcon />);
const SPLIT_VIEW_MENU_ICON = renderToStaticMarkup(<Columns2Icon />);
const REOPEN_MENU_ICON = renderToStaticMarkup(<RotateCcwIcon />);

// Row titles size off the same token as sidebar thread rows and the Focus card,
// never the panel's ambient font size.
const GROUP_OVERVIEW_ROW_TITLE_CLASS_NAME = "min-w-0 truncate text-ui font-medium text-foreground";

// — Section bar —

// Corner pill for a section's item count — small enough to sit on the icon
// without touching neighbouring buttons at the panel's narrowest width.
const SECTION_COUNT_PILL_CLASS_NAME =
  "absolute -right-2.5 -top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-0.5 text-ui-2xs leading-none tabular-nums text-muted-foreground/90";

/**
 * The Group panel's bottom bar: one evenly spaced icon button per section, each
 * centred in its equal slot so the row reads as a centred, evenly spaced unit.
 * Only the open section shows its label under the icon — closed buttons render
 * no label, so an all-closed bar is a vertically centred icon row with no dead
 * space under it. Every button carries the label in a tooltip and its
 * accessible name. Counts ride on the icon's top-right corner and a "waiting on
 * you" dot on the top-left; both are absolutely positioned and never shift the
 * icon off-centre, so the bar stays readable from ~260px up where inline labels
 * ran together.
 */
export function GroupPanelSectionBar({
  sections,
  sectionCounts,
  openSectionId,
  regionId,
  onToggle,
}: {
  readonly sections: readonly GroupPanelSectionDescriptor[];
  readonly sectionCounts: Readonly<
    Record<GroupPanelSectionId, { readonly count: number; readonly waiting: number }>
  >;
  readonly openSectionId: GroupPanelSectionId | null;
  readonly regionId: string;
  readonly onToggle: (sectionId: GroupPanelSectionId | null) => void;
}) {
  return (
    <div className="flex items-stretch">
      {sections.map((section) => {
        const counts = sectionCounts[section.id];
        const isOpen = openSectionId === section.id;
        const ariaLabel =
          counts.waiting > 0
            ? `${section.label}, ${counts.waiting} waiting on you`
            : counts.count > 0
              ? `${section.label}, ${counts.count}`
              : section.label;
        const toggle = () => {
          onToggle(isOpen ? null : section.id);
        };
        return (
          <Tooltip key={section.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={ariaLabel}
                  aria-expanded={isOpen}
                  aria-controls={regionId}
                  aria-pressed={isOpen}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1 text-ui-xs transition-colors",
                    isOpen
                      ? "bg-foreground/8 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                  onClick={toggle}
                />
              }
            >
              <span className="relative flex size-4 items-center justify-center">
                <section.icon className="size-4" aria-hidden />
                {counts.waiting > 0 ? (
                  <span
                    className="absolute -left-1.5 -top-1 block size-1.5 rounded-full bg-amber-500 dark:bg-amber-300/90"
                    aria-hidden
                  />
                ) : null}
                {counts.count > 0 ? (
                  <span className={SECTION_COUNT_PILL_CLASS_NAME} aria-hidden>
                    {counts.count}
                  </span>
                ) : null}
              </span>
              {isOpen ? <span className="min-w-0 max-w-full truncate">{section.label}</span> : null}
            </TooltipTrigger>
            <TooltipPopup>
              <p>{section.label}</p>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

// — Activity sparkline —

const SPARKLINE_VIEW_WIDTH = 100;
const SPARKLINE_VIEW_HEIGHT = 40;
const SPARKLINE_PAD_Y = 4;
const SPARKLINE_TICK_MS = 15_000;
const SPARKLINE_GRID_ROWS = [10, 20, 30] as const;
const SPARKLINE_GRID_COLUMNS = [25, 50, 75] as const;

/**
 * "Threads working" sparkline for the top of the Group panel: a thin accent
 * line over a faint dotted grid, a highlighted dot on the latest point, no
 * axes. The series is rebuilt from the store's thread summaries each render and
 * the window advances on a slow tick, so it updates as threads start and
 * finish. Hidden until the group has produced any work — a brand-new group has
 * nothing to chart.
 */
export function GroupThreadActivitySparkline({
  threads,
}: {
  readonly threads: readonly SidebarThreadSummary[];
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const gradientId = `group-activity-fill-${useId().replace(/:/g, "")}`;
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), SPARKLINE_TICK_MS);
    return () => window.clearInterval(interval);
  }, []);
  const series = buildGroupThreadActivitySeries({ threads, nowMs });
  if (series.points.length === 0) {
    return null;
  }
  const peak = Math.max(1, series.peakCount);
  const pointCount = series.points.length;
  const stepX = pointCount > 1 ? SPARKLINE_VIEW_WIDTH / (pointCount - 1) : 0;
  const coordinates = series.points.map((count, index) => ({
    x: pointCount > 1 ? index * stepX : SPARKLINE_VIEW_WIDTH / 2,
    y:
      SPARKLINE_VIEW_HEIGHT -
      SPARKLINE_PAD_Y -
      (count / peak) * (SPARKLINE_VIEW_HEIGHT - SPARKLINE_PAD_Y * 2),
  }));
  const lastPoint = coordinates[coordinates.length - 1];
  const pathData =
    coordinates.length > 1
      ? `M${coordinates.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L")}`
      : null;
  const areaData =
    pathData !== null
      ? `${pathData} L${SPARKLINE_VIEW_WIDTH} ${SPARKLINE_VIEW_HEIGHT} L0 ${SPARKLINE_VIEW_HEIGHT} Z`
      : null;
  const workingLabel = series.currentCount === 1 ? "1 thread" : `${series.currentCount} threads`;
  const accessibleLabel = `${workingLabel} working now, peak ${series.peakCount} in the last hour`;
  return (
    <div
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      tabIndex={0}
      className="relative mx-3 mb-1.5 mt-2 h-12"
    >
      <svg
        viewBox={`0 0 ${SPARKLINE_VIEW_WIDTH} ${SPARKLINE_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="block size-full"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-text-accent)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--color-text-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {SPARKLINE_GRID_ROWS.map((y) => (
          <line
            key={`row-${y}`}
            x1={0}
            y1={y}
            x2={SPARKLINE_VIEW_WIDTH}
            y2={y}
            stroke="var(--color-border-light)"
            strokeWidth={1}
            strokeDasharray="1 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {SPARKLINE_GRID_COLUMNS.map((x) => (
          <line
            key={`col-${x}`}
            x1={x}
            y1={0}
            x2={x}
            y2={SPARKLINE_VIEW_HEIGHT}
            stroke="var(--color-border-light)"
            strokeWidth={1}
            strokeDasharray="1 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {pathData !== null && areaData !== null ? (
          <path d={areaData} fill={`url(#${gradientId})`} stroke="none" />
        ) : null}
        {pathData !== null ? (
          <path
            d={pathData}
            fill="none"
            stroke="var(--color-text-accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {lastPoint !== undefined ? (
        <>
          <span
            className="pointer-events-none absolute size-4 rounded-full"
            style={{
              left: `calc(${(lastPoint.x / SPARKLINE_VIEW_WIDTH) * 100}% - 8px)`,
              top: `calc(${(lastPoint.y / SPARKLINE_VIEW_HEIGHT) * 100}% - 8px)`,
              backgroundColor: "var(--color-text-accent)",
              opacity: 0.2,
            }}
            aria-hidden
          />
          <span
            className="pointer-events-none absolute size-2 rounded-full"
            style={{
              left: `calc(${(lastPoint.x / SPARKLINE_VIEW_WIDTH) * 100}% - 4px)`,
              top: `calc(${(lastPoint.y / SPARKLINE_VIEW_HEIGHT) * 100}% - 4px)`,
              backgroundColor: "var(--color-text-accent)",
            }}
            aria-hidden
          />
        </>
      ) : null}
    </div>
  );
}

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
  // Sections toggled away from their default: "Resolved" starts collapsed and the
  // rest start open, so the set records the direction change, not the collapsed state.
  const [toggledSections, setToggledSections] = useState<ReadonlySet<GroupThreadSectionId>>(
    () => new Set(),
  );
  const visibleSections = sectionIds
    ? GROUP_THREAD_SECTIONS.filter((section) => sectionIds.includes(section.id))
    : GROUP_THREAD_SECTIONS;
  const totalRows = visibleSections.reduce(
    (count, section) => count + (sections.get(section.id)?.length ?? 0),
    0,
  );
  if (totalRows === 0) {
    return (
      <PanelStateMessage density="compact">
        <p>
          {emptyMessage ??
            "No threads yet. Ask the coordinator for work and it will start threads here."}
        </p>
      </PanelStateMessage>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {visibleSections.map((section) => {
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

export function GroupPullRequestsSection({
  rows,
  onOpenThread,
}: {
  readonly rows: readonly GroupPullRequestRow[];
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
      <PanelStateMessage density="compact">
        <p>Loading automations…</p>
      </PanelStateMessage>
    );
  }
  if (definitions.length === 0) {
    return (
      <PanelStateMessage density="compact">
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
