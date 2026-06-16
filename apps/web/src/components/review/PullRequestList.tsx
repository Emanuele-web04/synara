import type {
  ReviewListSort,
  ReviewListPullRequestsResult,
  ReviewPullRequestSummary,
  ReviewSourceRef,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useMemo, useState } from "react";

import { GitPullRequestIcon } from "~/lib/icons";
import {
  reviewListPullRequestsQueryOptions,
  reviewQueryKeys,
} from "~/lib/reviewReactQuery";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
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
  const serverFilters = useMemo(
    () => toReviewServerListFilters(activeFilters),
    [activeFilters],
  );
  const serverSort = sortId === "updated" ? undefined : sortId;
  const listScopeKey = useMemo(
    () => JSON.stringify([props.cwd, serverSearch.trim(), serverFilters, serverSort]),
    [props.cwd, serverSearch, serverFilters, serverSort],
  );
  const resultLimit =
    resultLimitState?.scopeKey === listScopeKey ? resultLimitState.limit : null;
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
  const facetItems = useMemo(() => {
    const basePullRequests =
      queryClient.getQueryData<ReviewListPullRequestsResult>(
        reviewQueryKeys.pullRequests({ cwd: props.cwd }),
      )?.pullRequests ?? [];
    return uniqueReviewPullRequests([...basePullRequests, ...allPullRequests]);
  }, [queryClient, props.cwd, allPullRequests]);
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

  if (pullRequestsQuery.isError) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-destructive">
        {rpcErrorMessage(pullRequestsQuery.error) ?? "Failed to load pull requests."}
      </p>
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
        <EmptyState icon={<GitPullRequestIcon />} title="No matches">
          No pull requests match your filters.
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
