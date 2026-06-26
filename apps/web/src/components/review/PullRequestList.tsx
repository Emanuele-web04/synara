import type {
  ReviewListSort,
  ReviewListPullRequestsResult,
  ReviewPullRequestSummary,
  ReviewSourceRef,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useMemo, useState } from "react";

import { GitPullRequestIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { reviewListPullRequestsQueryOptions, reviewQueryKeys } from "~/lib/reviewReactQuery";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { EmptyState } from "./reviewPrimitives";
import { PullRequestRow } from "./PullRequestRow";
import { ReviewFilterBar } from "./ReviewFilterBar";
import {
  ReviewInitialSyncPanel,
  ReviewSyncRowsSkeleton,
  ReviewSyncStatusStrip,
} from "./ReviewInitialSync";
import { VirtualizedPullRequestRows } from "./VirtualizedPullRequestRows";
import {
  type ActiveReviewFilter,
  buildReviewPullFilterOptions,
  filterReviewPullRequests,
  reviewPullFilterDefs,
  reviewPullSortOptions,
  sortReviewItems,
  toReviewServerListFilters,
  uniqueReviewPullRequests,
} from "./reviewFilters";

const EMPTY_PULL_REQUESTS: ReadonlyArray<ReviewPullRequestSummary> = [];
const REVIEW_LIST_PAGE_SIZE = 50;
const REVIEW_LIST_MAX_LIMIT = 500;

export function PullRequestList(props: {
  cwd: string | null;
  onSelectSource: (source: ReviewSourceRef) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [serverSearch] = useDebouncedValue(search, { wait: 250 });
  const [activeFilters, setActiveFilters] = useState<ActiveReviewFilter[]>([]);
  const [sortId, setSortId] = useState<ReviewListSort>("updated");
  const [resultLimitState, setResultLimitState] = useState<{
    scopeKey: string;
    limit: number;
  } | null>(null);
  const serverFilters = useMemo(() => toReviewServerListFilters(activeFilters), [activeFilters]);
  const serverSort = sortId === "updated" ? undefined : sortId;
  const hasRefinement = activeFilters.length > 0 || search.trim().length > 0;
  const listScopeKey = useMemo(
    () => JSON.stringify([props.cwd, serverSearch.trim(), serverFilters, serverSort]),
    [props.cwd, serverSearch, serverFilters, serverSort],
  );
  const resultLimit = resultLimitState?.scopeKey === listScopeKey ? resultLimitState.limit : null;
  const facetBaseQuery = useQuery({
    ...reviewListPullRequestsQueryOptions({ cwd: props.cwd }),
    enabled: props.cwd !== null && hasRefinement,
  });
  const pullRequestsQuery = useQuery({
    ...reviewListPullRequestsQueryOptions({
      cwd: props.cwd,
      ...(resultLimit !== null ? { limit: resultLimit } : {}),
      search: serverSearch,
      ...serverFilters,
      ...(serverSort !== undefined ? { sort: serverSort } : {}),
    }),
    placeholderData: (previousData: ReviewListPullRequestsResult | undefined) => previousData,
  });
  const clientSearch = search.trim() === serverSearch.trim() ? "" : search;

  const allPullRequests = pullRequestsQuery.data?.pullRequests ?? EMPTY_PULL_REQUESTS;
  const facetItems = useMemo(
    () =>
      uniqueReviewPullRequests([
        ...(facetBaseQuery.data?.pullRequests ?? EMPTY_PULL_REQUESTS),
        ...allPullRequests,
      ]),
    [facetBaseQuery.data?.pullRequests, allPullRequests],
  );
  const filterOptionsByFieldId = useMemo(
    () => buildReviewPullFilterOptions(facetItems),
    [facetItems],
  );
  const visible = useMemo(
    () =>
      sortReviewItems(
        filterReviewPullRequests(allPullRequests, clientSearch, activeFilters),
        sortId,
        reviewPullSortOptions,
      ),
    [allPullRequests, clientSearch, activeFilters, sortId],
  );
  const resultCountIsIncomplete =
    pullRequestsQuery.data?.meta?.candidateLimitReached === true &&
    visible.length >= (pullRequestsQuery.data.meta.returnedCount ?? 0);
  const hasPullRequestListData = pullRequestsQuery.data !== undefined;
  const isColdSyncing = !hasPullRequestListData && pullRequestsQuery.isFetching;
  const isRefreshing = hasPullRequestListData && pullRequestsQuery.isFetching;
  const listMeta = pullRequestsQuery.data?.meta;
  const canLoadMore =
    listMeta !== undefined &&
    (listMeta.candidateLimitReached || listMeta.matchedCount > listMeta.returnedCount) &&
    (resultLimit ?? listMeta.resultLimit) < REVIEW_LIST_MAX_LIMIT;
  const loadMore = useCallback(() => {
    if (!canLoadMore || pullRequestsQuery.isFetching) {
      return;
    }
    setResultLimitState((current) => {
      const currentLimit = current?.scopeKey === listScopeKey ? current.limit : null;
      if (currentLimit !== null && currentLimit > (listMeta?.resultLimit ?? 0)) {
        return current;
      }
      return {
        scopeKey: listScopeKey,
        limit: Math.min(
          (currentLimit ?? listMeta?.resultLimit ?? 0) + REVIEW_LIST_PAGE_SIZE,
          REVIEW_LIST_MAX_LIMIT,
        ),
      };
    });
  }, [canLoadMore, listMeta?.resultLimit, listScopeKey, pullRequestsQuery.isFetching]);

  const handleSync = () => {
    if (!props.cwd) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.pullRequestLists(props.cwd),
    });
  };

  const clearRefinement = useCallback(() => {
    setActiveFilters([]);
    setSearch("");
  }, []);

  if (pullRequestsQuery.isError) {
    return (
      <EmptyState
        icon={<TriangleAlertIcon className="text-destructive" />}
        title="Couldn't load pull requests"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 rounded-full bg-background/72 px-3 text-[12px] shadow-none"
            onClick={() => void pullRequestsQuery.refetch()}
            disabled={pullRequestsQuery.isFetching}
          >
            <RefreshCwIcon
              className={cn("size-4", pullRequestsQuery.isFetching && "animate-spin")}
            />
            Try again
          </Button>
        }
      >
        {rpcErrorMessage(pullRequestsQuery.error) ??
          "GitHub didn't return a result. Check your connection and retry."}
      </EmptyState>
    );
  }

  if (allPullRequests.length === 0) {
    if (isColdSyncing || pullRequestsQuery.isFetching) {
      return (
        <PullRequestListInitialSync
          onRetry={handleSync}
          isFetching={pullRequestsQuery.isFetching}
        />
      );
    }
    return (
      <EmptyState icon={<GitPullRequestIcon />} title="No open pull requests">
        Paste a PR URL above, or compare two branches below.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ReviewFilterBar
        items={facetItems}
        defs={reviewPullFilterDefs}
        resultCount={visible.length}
        resultCountIsIncomplete={resultCountIsIncomplete}
        search={search}
        onSearchChange={setSearch}
        activeFilters={activeFilters}
        onActiveFiltersChange={setActiveFilters}
        optionsByFieldId={filterOptionsByFieldId}
        sortOptions={reviewPullSortOptions}
        sortId={sortId}
        onSortChange={setSortId}
        onOpenReference={(reference) => props.onSelectSource({ _tag: "pullRequest", reference })}
      />
      {isRefreshing ? <ReviewSyncStatusStrip className="rounded-[1.15rem]" /> : null}
      {visible.length === 0 ? (
        <EmptyState
          icon={<GitPullRequestIcon />}
          title="No matches"
          action={
            hasRefinement ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 rounded-full bg-background/72 px-3 text-[12px] shadow-none"
                onClick={clearRefinement}
              >
                <XIcon className="size-4" />
                Clear filters
              </Button>
            ) : undefined
          }
        >
          {search.trim().length > 0
            ? "No pull requests match your search and filters."
            : "No pull requests match your filters."}
        </EmptyState>
      ) : (
        <VirtualizedPullRequestRows
          pullRequests={visible}
          estimateSize={82}
          overscan={10}
          threshold={30}
          className="flex max-h-[min(64vh,42rem)] flex-col gap-1.5"
          rowClassName="pb-1.5"
          onEndReached={loadMore}
          renderPullRequest={(pullRequest) => (
            <PullRequestRow pullRequest={pullRequest} onSelectSource={props.onSelectSource} />
          )}
        />
      )}
      {visible.length > 0 && resultCountIsIncomplete && !canLoadMore ? (
        <p className="px-3 pt-0.5 text-center text-[11px] text-muted-foreground/70">
          Showing the first {visible.length}. Refine search or filters to narrow the results.
        </p>
      ) : null}
    </div>
  );
}

function PullRequestListInitialSync(props: { onRetry: () => void; isFetching: boolean }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <ReviewInitialSyncPanel
        title="Syncing repository pull requests"
        detail="Synara is loading the first review window before it decides whether this repository is empty."
        onAction={props.onRetry}
        actionLabel="Sync now"
        actionDisabled={props.isFetching}
      />
      <ReviewSyncRowsSkeleton />
    </div>
  );
}
