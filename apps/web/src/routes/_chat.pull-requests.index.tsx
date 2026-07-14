import type {
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestState,
} from "@synara/contracts";
import { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { PullRequestAvatar } from "~/components/pullRequest/PullRequestAvatar";
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { PullRequestDiffStat } from "~/components/pullRequest/PullRequestDiffStat";
import {
  groupPullRequestEntriesByInvolvement,
  pullRequestListEntryKey,
} from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestStateGlyph } from "~/components/pullRequest/PullRequestStateGlyph";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { IconButton } from "~/components/ui/icon-button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { SearchInput } from "~/components/ui/search-input";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { disclosureWidthClassName } from "~/lib/disclosureMotion";
import { CheckIcon, FilterIcon, RefreshCwIcon } from "~/lib/icons";
import {
  pullRequestsForceRefreshMutationOptions,
  pullRequestsListQueryOptions,
} from "~/lib/pullRequestReactQuery";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";

export interface PullRequestsSearch {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
  projectId?: ProjectId;
  selectedProjectId?: ProjectId;
  selectedRepo?: string;
  number?: number;
  q?: string;
}

interface PullRequestsSearchPatch {
  involvement?: PullRequestInvolvement;
  state?: PullRequestState;
  projectId?: ProjectId | undefined;
  selectedProjectId?: ProjectId | undefined;
  selectedRepo?: string | undefined;
  number?: number | undefined;
  q?: string | undefined;
}

export const Route = createFileRoute("/_chat/pull-requests/")({
  validateSearch: (raw): PullRequestsSearch => ({
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state: raw.state === "closed" || raw.state === "merged" ? raw.state : "open",
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedRepo === "string" &&
    isValidGitHubRepositoryNameWithOwner(raw.selectedRepo)
      ? { selectedRepo: raw.selectedRepo.trim() }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  }),
  component: PullRequestsRouteView,
});

const INVOLVEMENT_TABS: ReadonlyArray<{ value: PullRequestInvolvement; label: string }> = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Reviewing" },
  { value: "authored", label: "Authored" },
];
const STATE_TABS: ReadonlyArray<{ value: PullRequestState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

function PillGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2 py-1 transition-colors",
            option.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TruncatedTitle({ title, number }: { title: string; number: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="truncate text-[0.8125rem] font-medium text-foreground">{title}</span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <p className="text-xs">
          {title} <span className="text-muted-foreground">#{number}</span>
        </p>
      </TooltipPopup>
    </Tooltip>
  );
}

function PullRequestRow({
  entry,
  selected,
  onClick,
}: {
  entry: PullRequestListEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-[var(--color-background-elevated-secondary)]"
          : "hover:bg-[var(--color-background-elevated-secondary)]/70 active:bg-[var(--color-background-elevated-secondary)]",
      )}
    >
      <PullRequestStateGlyph state={entry.state} isDraft={entry.isDraft} size="md" />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <TruncatedTitle title={entry.title} number={entry.number} />
          <span className="shrink-0 text-[10px] text-muted-foreground">#{entry.number}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <PullRequestAvatar actor={entry.author} size="sm" className="shrink-0" />
          <span className="truncate">{entry.repository}</span>
          <span>·</span>
          <code
            className="max-w-[14rem] truncate text-[11px]"
            title={`${entry.headBranch} → ${entry.baseBranch}`}
          >
            {entry.headBranch}
          </code>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] tabular-nums text-muted-foreground">
        <span>{formatRelativeTime(entry.updatedAt)}</span>
        <PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />
      </span>
    </button>
  );
}

function PullRequestList({
  entries,
  grouped,
  selectedProjectId,
  selectedRepo,
  selectedNumber,
  onSelect,
}: {
  entries: PullRequestListEntry[];
  grouped: ReturnType<typeof groupPullRequestEntriesByInvolvement> | null;
  selectedProjectId: ProjectId | undefined;
  selectedRepo: string | undefined;
  selectedNumber: number | undefined;
  onSelect: (entry: PullRequestListEntry) => void;
}) {
  if (grouped) {
    return (
      <div className="space-y-4">
        {grouped.map((group) => (
          <div key={group.key} className="space-y-0.5">
            <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
              {group.label}
            </h2>
            {group.entries.map((entry) => (
              <PullRequestRow
                key={pullRequestListEntryKey(entry)}
                entry={entry}
                selected={
                  selectedProjectId === entry.projectId &&
                  selectedRepo === entry.repository &&
                  selectedNumber === entry.number
                }
                onClick={() => onSelect(entry)}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <PullRequestRow
          key={pullRequestListEntryKey(entry)}
          entry={entry}
          selected={
            selectedProjectId === entry.projectId &&
            selectedRepo === entry.repository &&
            selectedNumber === entry.number
          }
          onClick={() => onSelect(entry)}
        />
      ))}
    </div>
  );
}

function ProjectFilterPopover({
  projects,
  value,
  onChange,
}: {
  projects: ReadonlyArray<readonly [ProjectId, string]>;
  value: ProjectId | undefined;
  onChange: (projectId: ProjectId | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label="Filter pull requests"
            tooltip="Filter by project"
            className={cn("relative", active && "text-foreground")}
          >
            <FilterIcon className="size-4" />
            {active ? (
              <span
                aria-hidden="true"
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </IconButton>
        }
      />
      <PopoverPopup align="end" className="w-64 p-1">
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Project
        </div>
        <div className="max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
              value === undefined && "text-foreground",
            )}
          >
            <span className="min-w-0 truncate">All projects</span>
            {value === undefined ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </button>
          {projects.map(([id, title]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
                value === id && "text-foreground",
              )}
            >
              <span className="min-w-0 truncate">{title}</span>
              {value === id ? <CheckIcon className="size-3.5 shrink-0" /> : null}
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PullRequestsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((store) => store.projects);
  const queryClient = useQueryClient();
  const listInput = {
    involvement: search.involvement,
    state: search.state,
    projectId: search.projectId ?? null,
  } as const;
  const listQuery = useQuery(pullRequestsListQueryOptions(listInput));
  const refreshMutation = useMutation(pullRequestsForceRefreshMutationOptions(queryClient));
  const updateSearch = (patch: PullRequestsSearchPatch) =>
    void navigate({
      search: (previous) => {
        const next = { ...previous, ...patch };
        return {
          involvement: next.involvement,
          state: next.state,
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.selectedRepo ? { selectedRepo: next.selectedRepo } : {}),
          ...(next.number ? { number: next.number } : {}),
          ...(next.q ? { q: next.q } : {}),
        };
      },
      replace: true,
    });
  const repositoryProjects = useMemo(
    () =>
      projects
        .filter((project) => project.kind === "project")
        .map((project) => [project.id, project.name] as const)
        .toSorted((left, right) => left[1].localeCompare(right[1])),
    [projects],
  );
  const query = search.q?.trim().toLowerCase() ?? "";
  const entries = useMemo(
    () =>
      (listQuery.data?.entries ?? []).filter((entry) =>
        query
          ? `${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
              .toLowerCase()
              .includes(query)
          : true,
      ),
    [listQuery.data, query],
  );
  const grouped = useMemo(
    () =>
      search.involvement === "all"
        ? groupPullRequestEntriesByInvolvement(entries, listQuery.data?.viewer)
        : null,
    [entries, listQuery.data?.viewer, search.involvement],
  );
  const selectedInput =
    search.selectedProjectId && search.selectedRepo && search.number
      ? {
          projectId: search.selectedProjectId,
          repository: search.selectedRepo,
          number: search.number,
        }
      : null;
  const detailOpen = selectedInput !== null;
  const [renderedInput, setRenderedInput] = useState(selectedInput);
  useEffect(() => {
    if (selectedInput) setRenderedInput(selectedInput);
    // selectedInput is a fresh object literal every render; depend on its primitive
    // fields instead so this only re-fires when the actual selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.selectedProjectId, search.selectedRepo, search.number]);
  useEffect(() => {
    if (detailOpen) return;
    const timeout = window.setTimeout(() => setRenderedInput(null), 300);
    return () => window.clearTimeout(timeout);
  }, [detailOpen]);

  const truncatedRepositoryCount =
    listQuery.data?.repositoryBatches.filter((batch) => batch.truncated).length ?? 0;

  const viewer = listQuery.data?.viewer;
  const subtitle = viewer
    ? `Review and track work across GitHub as ${viewer}.`
    : "Review and track work across GitHub.";

  return (
    <RouteInsetSurface>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <div className={cn("flex items-center gap-2", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh pull requests"
              title="Refresh"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate(listInput)}
            >
              <RefreshCwIcon
                className={cn(
                  "size-4",
                  (listQuery.isFetching || refreshMutation.isPending) && "animate-spin",
                )}
              />
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 pb-12 pt-7 sm:px-7">
            <div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">Pull requests</h1>
              <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/25 p-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SearchInput
                    placeholder="Search title, repository, branch, or author…"
                    value={search.q ?? ""}
                    onChange={(event) => updateSearch({ q: event.target.value || undefined })}
                  />
                </div>
                <ProjectFilterPopover
                  projects={repositoryProjects}
                  value={search.projectId}
                  onChange={(projectId) =>
                    updateSearch({
                      projectId,
                      selectedProjectId: undefined,
                      selectedRepo: undefined,
                      number: undefined,
                    })
                  }
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PillGroup
                  value={search.involvement}
                  options={INVOLVEMENT_TABS}
                  onChange={(involvement) =>
                    updateSearch({
                      involvement,
                      selectedProjectId: undefined,
                      selectedRepo: undefined,
                      number: undefined,
                    })
                  }
                />
                <PillGroup
                  value={search.state}
                  options={STATE_TABS}
                  onChange={(state) =>
                    updateSearch({
                      state,
                      selectedProjectId: undefined,
                      selectedRepo: undefined,
                      number: undefined,
                    })
                  }
                />
              </div>
            </div>

            {listQuery.isPending ? (
              <div className="space-y-2">
                {Array.from({ length: 7 }, (_, index) => (
                  <Skeleton key={index} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : listQuery.isError ? (
              <PullRequestsUnavailableState
                error={listQuery.error}
                onRetry={() => void listQuery.refetch()}
              />
            ) : entries.length === 0 ? (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle>
                    {search.involvement === "reviewing" && search.state !== "open"
                      ? "Review requests only apply to open pull requests"
                      : "No pull requests found"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {search.involvement === "reviewing" && search.state !== "open"
                      ? "Select Open to see pull requests currently awaiting your review."
                      : "Try another involvement, state, project, or search filter."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <PullRequestList
                entries={entries}
                grouped={grouped}
                selectedProjectId={search.selectedProjectId}
                selectedRepo={search.selectedRepo}
                selectedNumber={search.number}
                onSelect={(entry) =>
                  updateSearch({
                    selectedProjectId: entry.projectId,
                    selectedRepo: entry.repository,
                    number: entry.number,
                  })
                }
              />
            )}
            {truncatedRepositoryCount > 0 ? (
              <p className="px-1 text-[11px] text-muted-foreground">
                Showing the first 50 matching pull requests for {truncatedRepositoryCount}{" "}
                {truncatedRepositoryCount === 1 ? "repository" : "repositories"}.
              </p>
            ) : null}
            {listQuery.data?.errors.length ? (
              <PullRequestWarningNote className="rounded-lg px-3 py-2">
                {listQuery.data.errors.length} project{" "}
                {listQuery.data.errors.length === 1 ? "repository was" : "repositories were"}{" "}
                unavailable. Healthy repositories are still shown.
              </PullRequestWarningNote>
            ) : null}
          </div>
        </main>

        <div
          className={disclosureWidthClassName(
            detailOpen,
            "w-full sm:w-[min(52rem,58vw)]",
            "absolute inset-y-0 right-0 z-30 border-l border-border bg-background shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.5)]",
          )}
          aria-hidden={!detailOpen}
          inert={!detailOpen}
          onTransitionEnd={(event) => {
            if (event.propertyName === "width" && !detailOpen) setRenderedInput(null);
          }}
        >
          {renderedInput ? (
            <PullRequestDetailPanel
              key={`${renderedInput.projectId}:${renderedInput.repository}#${renderedInput.number}`}
              input={renderedInput}
              onClose={() =>
                updateSearch({
                  selectedProjectId: undefined,
                  selectedRepo: undefined,
                  number: undefined,
                })
              }
            />
          ) : null}
        </div>
      </div>
    </RouteInsetSurface>
  );
}
