import type { ReviewListPullRequestsResult, ReviewPullRequestSummary } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  reviewListPullRequestsQueryOptions,
  reviewQueryKeys,
  reviewViewerQueryOptions,
} from "~/lib/reviewReactQuery";
import { GitPullRequestIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../base-ui/tabs";
import { CountChip, EmptyState } from "./reviewPrimitives";
import { ReviewBoardCard } from "./ReviewBoardCard";
import { ReviewFilterBar } from "./ReviewFilterBar";
import { VirtualizedPullRequestRows } from "./VirtualizedPullRequestRows";
import {
  type ActiveReviewFilter,
  filterReviewPullRequests,
  reviewPullFilterDefs,
  toReviewServerListFilters,
} from "./reviewFilters";
import {
  REVIEW_BOARD_COLUMNS,
  REVIEW_BOARD_VIEWS,
  type ReviewBoardView,
  filterByView,
  groupByColumn,
} from "./reviewBoardColumns";

export function ReviewBoard(props: { cwd: string | null }) {
  const { cwd } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ReviewBoardView>("all");
  const [search, setSearch] = useState("");
  const [serverSearch] = useDebouncedValue(search, { wait: 250 });
  const [activeFilters, setActiveFilters] = useState<ActiveReviewFilter[]>([]);

  const viewerQuery = useQuery(reviewViewerQueryOptions({ cwd }));
  const viewerLogin = viewerQuery.data?.login ?? null;
  const listState = view === "merged" ? "merged" : "open";
  const viewServerFilters = useMemo(() => {
    if (!viewerLogin || view === "all" || view === "merged") {
      return {};
    }
    if (view === "mine") {
      return { author: viewerLogin };
    }
    if (view === "needs-my-review") {
      return { reviewRequested: viewerLogin };
    }
    return {};
  }, [view, viewerLogin]);
  const serverFilters = useMemo(
    () => ({ ...toReviewServerListFilters(activeFilters), ...viewServerFilters }),
    [activeFilters, viewServerFilters],
  );
  const pullRequestsQuery = useQuery(
    reviewListPullRequestsQueryOptions({
      cwd,
      ...(listState === "merged" ? { state: listState } : {}),
      search: serverSearch,
      ...serverFilters,
    }),
  );
  const clientSearch = search.trim() === serverSearch.trim() ? "" : search;
  const cachedPullRequests = queryClient
    .getQueriesData<ReviewListPullRequestsResult>({
      queryKey: reviewQueryKeys.pullRequestLists(cwd),
    })
    .flatMap(([, data]) => data?.pullRequests ?? []);
  const facetBasePullRequests = uniquePullRequests([
    ...cachedPullRequests,
    ...(pullRequestsQuery.data?.pullRequests ?? []),
  ]);

  const byView = useMemo(() => {
    const all = pullRequestsQuery.data?.pullRequests ?? [];
    return filterByView(all, view, viewerLogin);
  }, [pullRequestsQuery.data, view, viewerLogin]);
  const facetItems = useMemo(
    () => filterByView(facetBasePullRequests, view, viewerLogin),
    [facetBasePullRequests, view, viewerLogin],
  );
  const visiblePullRequests = useMemo(
    () => filterReviewPullRequests(byView, clientSearch, activeFilters),
    [byView, clientSearch, activeFilters],
  );
  const grouped = useMemo(() => groupByColumn(visiblePullRequests), [visiblePullRequests]);
  const resultCountIsIncomplete =
    pullRequestsQuery.data?.meta?.candidateLimitReached === true &&
    visiblePullRequests.length >= (pullRequestsQuery.data.meta.returnedCount ?? 0);

  if (cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        Add a project to review a pull request.
      </div>
    );
  }

  const handleSync = () => {
    void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.pullRequestLists(cwd) });
  };

  const openReference = (reference: string) => {
    void navigate({
      to: "/review/$reference",
      params: { reference },
      search: { cwd },
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/45 bg-background/78 px-3 py-2.5">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-[1.15rem] border border-border/55 bg-card/60 px-2 py-2 shadow-[0_10px_28px_-26px_var(--foreground)]"
          role="toolbar"
          aria-label="Pull request review controls"
        >
          <Tabs
            value={view}
            onValueChange={(next) => {
              if (
                next === "needs-my-review" ||
                next === "mine" ||
                next === "merged" ||
                next === "all"
              ) {
                setView(next);
              }
            }}
            className="shrink-0 gap-0"
          >
            <TabsList
              aria-label="Pull request view"
              activateOnFocus
              className="h-9 shrink-0 rounded-full bg-background/72 p-1 ring-1 ring-border/55"
            >
              {REVIEW_BOARD_VIEWS.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="h-7 rounded-full px-3 text-[12px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] hover:text-foreground data-[active]:bg-foreground data-[active]:text-background data-[active]:shadow-sm motion-reduce:transition-none"
                >
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="hidden h-6 w-px shrink-0 bg-border/55 lg:block" aria-hidden="true" />
          <ReviewFilterBar
            items={facetItems}
            defs={reviewPullFilterDefs}
            resultCount={visiblePullRequests.length}
            resultCountIsIncomplete={resultCountIsIncomplete}
            search={search}
            onSearchChange={setSearch}
            activeFilters={activeFilters}
            onActiveFiltersChange={setActiveFilters}
            onOpenReference={openReference}
            className="min-w-[18rem]"
            searchClassName="lg:max-w-[40rem]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ms-auto h-8 shrink-0 rounded-full bg-background/72 px-3 text-[12px] shadow-none ring-border/55 transition-[background-color] hover:bg-background"
            onClick={handleSync}
            disabled={pullRequestsQuery.isFetching}
          >
            <RefreshCwIcon className={cn(pullRequestsQuery.isFetching && "animate-spin")} />
            Sync
          </Button>
        </div>
      </div>

      {pullRequestsQuery.isLoading ? (
        <BoardLoadingSkeleton />
      ) : pullRequestsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
          {pullRequestsQuery.error instanceof Error
            ? pullRequestsQuery.error.message
            : "Failed to load pull requests."}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex h-full min-w-0 flex-col gap-3 p-3 md:min-w-max md:flex-row">
            {REVIEW_BOARD_COLUMNS.map((column) => (
              <ReviewBoardColumn
                key={column.id}
                column={column}
                pullRequests={grouped[column.id]}
                cwd={cwd}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function uniquePullRequests(
  pullRequests: ReadonlyArray<ReviewPullRequestSummary>,
): ReadonlyArray<ReviewPullRequestSummary> {
  const byKey = new Map<string, ReviewPullRequestSummary>();
  for (const pullRequest of pullRequests) {
    byKey.set(`${String(pullRequest.number)}:${pullRequest.url}`, pullRequest);
  }
  return [...byKey.values()];
}

function ReviewBoardColumn(props: {
  column: (typeof REVIEW_BOARD_COLUMNS)[number];
  pullRequests: readonly ReviewPullRequestSummary[];
  cwd: string;
}) {
  const { column, pullRequests, cwd } = props;
  const isEmpty = pullRequests.length === 0;
  return (
    <section className="flex h-full w-full shrink-0 flex-col gap-2 rounded-[1.5rem] border border-border/60 bg-card/55 p-2.5 shadow-sm md:w-72">
      <header className="flex shrink-0 items-center gap-2 px-1">
        <span
          className="min-w-0 truncate font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
          title={column.label}
        >
          {column.label}
        </span>
        {pullRequests.length > 0 ? <CountChip count={pullRequests.length} /> : null}
      </header>
      {isEmpty ? (
        <EmptyState icon={<GitPullRequestIcon />} title={column.emptyTitle}>
          {column.emptyHint}
        </EmptyState>
      ) : (
        <VirtualizedPullRequestRows
          pullRequests={pullRequests}
          estimateSize={116}
          overscan={8}
          threshold={30}
          className="min-h-0 flex-1"
          rowClassName="pb-2"
          renderPullRequest={(pullRequest) => (
            <ReviewBoardCard pullRequest={pullRequest} cwd={cwd} />
          )}
        />
      )}
    </section>
  );
}

// Mirror the loaded layout: column shells with placeholder cards, so data arrival
// fills the columns in place instead of popping a centered spinner into a full board.
function BoardLoadingSkeleton() {
  return (
    <ScrollArea className="flex-1">
      <div
        className="flex h-full min-w-0 flex-col gap-3 p-3 md:min-w-max md:flex-row"
        aria-busy="true"
      >
        {REVIEW_BOARD_COLUMNS.map((column) => (
          <section
            key={column.id}
            className="flex h-full w-full shrink-0 flex-col gap-2 rounded-[1.5rem] border border-border/60 bg-card/55 p-2.5 shadow-sm md:w-72"
          >
            <header className="flex shrink-0 items-center gap-2 px-1">
              <span
                className="min-w-0 truncate font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
                title={column.label}
              >
                {column.label}
              </span>
            </header>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {[0, 1, 2].map((index) => (
                <li key={index}>
                  <div className="flex flex-col gap-2 rounded-[1.15rem] border border-border/70 bg-card/90 px-3.5 py-3 shadow-[0_8px_24px_-22px_var(--foreground)]">
                    <div className="flex min-w-0 items-center gap-2">
                      <Skeleton className="size-4 rounded-full" />
                      <Skeleton className="h-3.5 w-3/4" />
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-14" />
                      <Skeleton className="ms-auto h-4 w-12 rounded-full" />
                    </div>
                    <Skeleton className="h-3 w-11/12" />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
