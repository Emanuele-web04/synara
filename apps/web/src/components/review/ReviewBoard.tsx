import type {
  ReviewBoardLanesResult,
  ReviewListPullRequestsResult,
  ReviewPullRequestSummary,
} from "@t3tools/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import {
  reviewLoadBoardLanesQueryOptions,
  reviewListPullRequestsQueryOptions,
  reviewQueryKeys,
  reviewViewerQueryOptions,
} from "~/lib/reviewReactQuery";
import { GitPullRequestIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger } from "../base-ui/tabs";
import { CountChip, EmptyState } from "./reviewPrimitives";
import {
  ReviewInitialSyncPanel,
  ReviewSyncRowsSkeleton,
  ReviewSyncStatusStrip,
} from "./ReviewInitialSync";
import { ReviewBoardCard } from "./ReviewBoardCard";
import { ReviewFilterBar } from "./ReviewFilterBar";
import { VirtualizedPullRequestRows } from "./VirtualizedPullRequestRows";
import {
  type ActiveReviewFilter,
  type ReviewServerListFilters,
  buildReviewPullFilterOptions,
  filterReviewPullRequests,
  reviewPullFilterDefs,
  toReviewServerListFilters,
  uniqueReviewPullRequests,
} from "./reviewFilters";
import {
  REVIEW_BOARD_COLUMNS,
  REVIEW_BOARD_VIEWS,
  type ReviewBoardView,
  type ReviewColumnId,
  type ReviewColumnAccent,
  deriveReviewColumn,
  filterByView,
} from "./reviewBoardColumns";

const REVIEW_BOARD_CARD_ROW_HEIGHT = 128;
type ReviewBoardColumnQueryInput = Parameters<typeof reviewListPullRequestsQueryOptions>[0];

// Accents drawn from the app's own token palette (foreground / amber / emerald /
// info), not new hues. Merged matches its blue state pill; needs-review uses the
// strongest neutral to read as the live queue.
const COLUMN_ACCENT_DOT: Record<ReviewColumnAccent, string> = {
  attention: "bg-foreground/70",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  muted: "bg-muted-foreground/45",
  merged: "bg-info",
};

const COLUMN_ACCENT_CHIP: Record<ReviewColumnAccent, string> = {
  attention: "bg-foreground/10 text-foreground",
  warning: "bg-amber-500/14 text-amber-700 dark:bg-amber-400/16 dark:text-amber-300",
  success: "bg-emerald-500/14 text-emerald-700 dark:bg-emerald-400/16 dark:text-emerald-300",
  muted: "bg-muted text-muted-foreground",
  merged: "bg-info/15 text-info-foreground dark:bg-info/20",
};
const REVIEW_LIST_PAGE_SIZE = 50;
const REVIEW_LIST_MAX_LIMIT = 500;

function viewNeedsViewer(view: ReviewBoardView): boolean {
  return view === "mine" || view === "needs-my-review";
}

function boardColumnListState(columnId: ReviewColumnId): "open" | "merged" {
  return columnId === "merged" ? "merged" : "open";
}

function isColumnAvailableForView(columnId: ReviewColumnId, view: ReviewBoardView): boolean {
  return view === "merged" ? columnId === "merged" : columnId !== "merged";
}

function selectedColumnsAllow(
  columnId: ReviewColumnId,
  selectedColumns: ReadonlyArray<ReviewColumnId> | undefined,
): boolean {
  return selectedColumns === undefined || selectedColumns.includes(columnId);
}

function boardColumnServerFilters(
  columnId: ReviewColumnId,
  serverFilters: ReviewServerListFilters,
): ReviewServerListFilters {
  const { columns: _columns, draft: _draft, ...rest } = serverFilters;
  return {
    ...rest,
    columns: [columnId],
    ...(columnId === "draft" ? { draft: true } : {}),
  };
}

function boardLaneResultForColumn(
  lanes: ReviewBoardLanesResult | undefined,
  columnId: ReviewColumnId,
): ReviewListPullRequestsResult | undefined {
  if (!lanes || columnId === "merged") {
    return undefined;
  }
  return lanes[columnId];
}

export function ReviewBoard(props: { cwd: string | null }) {
  const { cwd } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ReviewBoardView>("all");
  const [search, setSearch] = useState("");
  const [serverSearch] = useDebouncedValue(search, { wait: 250 });
  const [activeFilters, setActiveFilters] = useState<ActiveReviewFilter[]>([]);
  const [resultLimitState, setResultLimitState] = useState<{
    scopeKey: string;
    limit: number;
  } | null>(null);

  const shouldLoadViewer = cwd !== null && viewNeedsViewer(view);
  const viewerQuery = useQuery({
    ...reviewViewerQueryOptions({ cwd }),
    enabled: shouldLoadViewer,
  });
  const viewerLogin = viewerQuery.data?.login ?? null;
  const viewerFilterReady = !shouldLoadViewer || viewerLogin !== null;
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
  const canUseBoardLaneHydrate =
    cwd !== null &&
    view === "all" &&
    serverSearch.trim().length === 0 &&
    activeFilters.length === 0 &&
    resultLimitState === null;
  const canUseBoardLaneFallback =
    cwd !== null &&
    view === "all" &&
    serverSearch.trim().length === 0 &&
    activeFilters.length === 0;
  const boardLanesQuery = useQuery({
    ...reviewLoadBoardLanesQueryOptions({ cwd, limit: REVIEW_LIST_PAGE_SIZE }),
    enabled: canUseBoardLaneHydrate,
  });
  const columnQueryInputs = useMemo(
    () =>
      REVIEW_BOARD_COLUMNS.map(
        (
          column,
        ): {
          columnId: ReviewColumnId;
          enabled: boolean;
          scopeKey: string;
          input: ReviewBoardColumnQueryInput;
        } => {
          const selectedColumns = serverFilters.columns;
          const enabled =
            isColumnAvailableForView(column.id, view) &&
            selectedColumnsAllow(column.id, selectedColumns);
          const columnFilters = boardColumnServerFilters(column.id, serverFilters);
          const state = boardColumnListState(column.id);
          const scopeKey = JSON.stringify([
            cwd,
            column.id,
            state,
            serverSearch.trim(),
            columnFilters,
          ]);
          const resultLimitForColumn =
            resultLimitState?.scopeKey === scopeKey ? resultLimitState.limit : null;
          return {
            columnId: column.id,
            enabled,
            scopeKey,
            input: {
              cwd: enabled && viewerFilterReady ? cwd : null,
              state,
              ...(resultLimitForColumn !== null ? { limit: resultLimitForColumn } : {}),
              search: serverSearch,
              ...columnFilters,
            },
          };
        },
      ),
    [cwd, resultLimitState, serverFilters, serverSearch, view, viewerFilterReady],
  );
  const columnQueries = useQueries({
    queries: columnQueryInputs.map((columnInput) => ({
      ...reviewListPullRequestsQueryOptions(columnInput.input),
      enabled:
        columnInput.input.cwd !== null &&
        !canUseBoardLaneHydrate &&
        (resultLimitState === null || resultLimitState.scopeKey === columnInput.scopeKey),
      placeholderData: (previousData: ReviewListPullRequestsResult | undefined) => previousData,
    })),
  });
  const clientSearch = search.trim() === serverSearch.trim() ? "" : search;
  const facetBasePullRequests = useMemo(() => {
    const columnPullRequests = columnQueries.flatMap((query) => query.data?.pullRequests ?? []);
    // Lane-hydrated views disable the per-column queries, so their pull requests
    // only live in boardLanesQuery; include them or the facet menu has no options.
    const lanePullRequests = REVIEW_BOARD_COLUMNS.flatMap(
      (column) => boardLaneResultForColumn(boardLanesQuery.data, column.id)?.pullRequests ?? [],
    );
    return uniqueReviewPullRequests([...columnPullRequests, ...lanePullRequests]);
  }, [columnQueries, boardLanesQuery.data]);

  const facetItems = useMemo(
    () => filterByView(facetBasePullRequests, view, viewerLogin),
    [facetBasePullRequests, view, viewerLogin],
  );
  const filterOptionsByFieldId = useMemo(
    () => buildReviewPullFilterOptions(facetItems),
    [facetItems],
  );
  const columnStates = useMemo(
    () =>
      REVIEW_BOARD_COLUMNS.map((column, index) => {
        const columnInput = columnQueryInputs[index]!;
        const query = columnQueries[index]!;
        const laneData = canUseBoardLaneFallback
          ? boardLaneResultForColumn(boardLanesQuery.data, column.id)
          : undefined;
        const queryData = query.data;
        const sourceData = queryData ?? laneData;
        const pullRequests = filterReviewPullRequests(
          filterByView(sourceData?.pullRequests ?? [], view, viewerLogin).filter(
            (summary) => deriveReviewColumn(summary) === column.id,
          ),
          clientSearch,
          activeFilters,
        );
        const meta = sourceData?.meta;
        const resultLimitForColumn =
          resultLimitState?.scopeKey === columnInput.scopeKey ? resultLimitState.limit : null;
        const canLoadMore =
          columnInput.enabled &&
          meta !== undefined &&
          (meta.candidateLimitReached || meta.matchedCount > meta.returnedCount) &&
          (resultLimitForColumn ?? meta.resultLimit) < REVIEW_LIST_MAX_LIMIT;
        return {
          columnId: column.id,
          enabled: columnInput.enabled,
          scopeKey: columnInput.scopeKey,
          pullRequests,
          query,
          meta,
          canLoadMore,
          hasData: sourceData !== undefined,
        };
      }),
    [
      activeFilters,
      clientSearch,
      columnQueries,
      columnQueryInputs,
      boardLanesQuery.data,
      canUseBoardLaneFallback,
      resultLimitState,
      view,
      viewerLogin,
    ],
  );
  const visiblePullRequests = useMemo(
    () => columnStates.flatMap((column) => column.pullRequests),
    [columnStates],
  );
  const resultCountIsIncomplete =
    columnStates.some((column) => column.meta?.candidateLimitReached === true) &&
    columnStates.some(
      (column) =>
        column.meta !== undefined && column.pullRequests.length >= (column.meta.returnedCount ?? 0),
    );
  const enabledColumnStates = columnStates.filter((column) => column.enabled);
  const hasPullRequestListData =
    canUseBoardLaneHydrate && boardLanesQuery.data
      ? true
      : enabledColumnStates.length > 0 && enabledColumnStates.every((column) => column.hasData);
  const isColdSyncing =
    !hasPullRequestListData &&
    (enabledColumnStates.some((column) => column.query.isFetching) ||
      boardLanesQuery.isFetching ||
      (shouldLoadViewer && viewerQuery.isFetching));
  const isRefreshing =
    hasPullRequestListData &&
    (enabledColumnStates.some((column) => column.query.isFetching) || boardLanesQuery.isFetching);
  const errorState =
    boardLanesQuery.error ??
    enabledColumnStates.find((column) => column.query.isError)?.query.error;
  const loadMore = useCallback(
    (columnId: ReviewColumnId) => {
      const columnState = columnStates.find((column) => column.columnId === columnId);
      if (!columnState?.canLoadMore || columnState.query.isFetching) {
        return;
      }
      setResultLimitState((current) => {
        const currentLimit = current?.scopeKey === columnState.scopeKey ? current.limit : null;
        if (currentLimit !== null && currentLimit > (columnState.meta?.resultLimit ?? 0)) {
          return current;
        }
        return {
          scopeKey: columnState.scopeKey,
          limit: Math.min(
            (currentLimit ?? columnState.meta?.resultLimit ?? 0) + REVIEW_LIST_PAGE_SIZE,
            REVIEW_LIST_MAX_LIMIT,
          ),
        };
      });
    },
    [columnStates],
  );

  if (cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        Add a project to review a pull request.
      </div>
    );
  }

  const handleSync = () => {
    void boardLanesQuery.refetch();
    void queryClient.refetchQueries({ queryKey: reviewQueryKeys.pullRequestLists(cwd) });
  };

  const openReference = (reference: string) => {
    void navigate({
      to: "/review/$reference",
      params: { reference },
      search: { cwd },
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/45 bg-background/78 px-3 py-2.5">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-border/55 bg-card/60 px-2 py-2 shadow-[0_10px_28px_-26px_var(--foreground)]"
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
            optionsByFieldId={filterOptionsByFieldId}
            onOpenReference={openReference}
            className="min-w-[16rem]"
            searchClassName="lg:max-w-[32rem]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 rounded-full bg-background/72 px-3 text-[12px] shadow-none ring-border/55 transition-[background-color] hover:bg-background"
            onClick={handleSync}
            disabled={enabledColumnStates.some((column) => column.query.isFetching)}
          >
            <RefreshCwIcon
              className={cn(
                enabledColumnStates.some((column) => column.query.isFetching) && "animate-spin",
              )}
            />
            Sync
          </Button>
        </div>
      </div>

      {isColdSyncing ? (
        <BoardLoadingSkeleton
          isFetching={enabledColumnStates.some((column) => column.query.isFetching)}
          onRetry={handleSync}
        />
      ) : errorState ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
          {errorState instanceof Error ? errorState.message : "Failed to load pull requests."}
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
          {isRefreshing ? <ReviewSyncStatusStrip /> : null}
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-auto overflow-y-hidden md:flex-row">
            {REVIEW_BOARD_COLUMNS.map((column) => (
              <ReviewBoardColumn
                key={column.id}
                column={column}
                pullRequests={
                  columnStates.find((columnState) => columnState.columnId === column.id)
                    ?.pullRequests ?? []
                }
                cwd={cwd}
                onEndReached={() => loadMore(column.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewBoardColumnShell(props: {
  column: (typeof REVIEW_BOARD_COLUMNS)[number];
  count?: number;
  children: ReactNode;
}) {
  const { column } = props;
  return (
    <section className="flex min-h-0 w-full shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-border/55 bg-card/40 p-2.5 md:h-full md:w-72">
      <header className="flex shrink-0 items-center gap-2 px-1">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", COLUMN_ACCENT_DOT[column.accent])}
          aria-hidden="true"
        />
        <span
          className="min-w-0 truncate font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
          title={column.label}
        >
          {column.label}
        </span>
        {props.count !== undefined && props.count > 0 ? (
          <CountChip count={props.count} className={COLUMN_ACCENT_CHIP[column.accent]} />
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

function ReviewBoardColumn(props: {
  column: (typeof REVIEW_BOARD_COLUMNS)[number];
  pullRequests: readonly ReviewPullRequestSummary[];
  cwd: string;
  onEndReached: () => void;
}) {
  const { column, pullRequests, cwd, onEndReached } = props;
  const isEmpty = pullRequests.length === 0;
  return (
    <ReviewBoardColumnShell column={column} count={pullRequests.length}>
      {isEmpty ? (
        <EmptyState icon={<GitPullRequestIcon />} title={column.emptyTitle}>
          {column.emptyHint}
        </EmptyState>
      ) : (
        <VirtualizedPullRequestRows
          pullRequests={pullRequests}
          estimateSize={REVIEW_BOARD_CARD_ROW_HEIGHT}
          overscan={8}
          threshold={30}
          className="min-h-0 flex-1"
          rowClassName="h-32 pb-2"
          onEndReached={onEndReached}
          renderPullRequest={(pullRequest) => (
            <ReviewBoardCard pullRequest={pullRequest} cwd={cwd} />
          )}
        />
      )}
    </ReviewBoardColumnShell>
  );
}

// Mirror the loaded layout: column shells with placeholder cards, so data arrival
// fills the columns in place instead of popping a centered spinner into a full board.
function BoardLoadingSkeleton(props: { isFetching: boolean; onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3" aria-busy="true">
      <ReviewInitialSyncPanel
        onAction={props.onRetry}
        actionLabel="Sync now"
        actionDisabled={props.isFetching}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-auto overflow-y-hidden md:flex-row">
        {REVIEW_BOARD_COLUMNS.map((column) => (
          <ReviewBoardColumnShell key={column.id} column={column}>
            <ReviewSyncRowsSkeleton rows={3} compact />
          </ReviewBoardColumnShell>
        ))}
      </div>
    </div>
  );
}
