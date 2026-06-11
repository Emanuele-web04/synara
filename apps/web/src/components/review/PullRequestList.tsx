import type { ReviewSourceRef } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { GitPullRequestIcon } from "~/lib/icons";
import { reviewListPullRequestsQueryOptions } from "~/lib/reviewReactQuery";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { EmptyState } from "./reviewPrimitives";
import { Skeleton } from "../ui/skeleton";
import { PullRequestRow } from "./PullRequestRow";
import { ReviewFilterBar } from "./ReviewFilterBar";
import {
  type ActiveReviewFilter,
  filterReviewPullRequests,
  reviewPullFilterDefs,
  reviewPullSortOptions,
  sortReviewItems,
} from "./reviewFilters";

export function PullRequestList(props: {
  cwd: string | null;
  onSelectSource: (source: ReviewSourceRef) => void;
}) {
  const pullRequestsQuery = useQuery(reviewListPullRequestsQueryOptions({ cwd: props.cwd }));
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<ActiveReviewFilter[]>([]);
  const [sortId, setSortId] = useState("updated");

  const allPullRequests = pullRequestsQuery.data?.pullRequests ?? [];
  const visible = useMemo(
    () =>
      sortReviewItems(
        filterReviewPullRequests(allPullRequests, search, activeFilters),
        sortId,
        reviewPullSortOptions,
      ),
    [allPullRequests, search, activeFilters, sortId],
  );

  if (pullRequestsQuery.isError) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-destructive">
        {rpcErrorMessage(pullRequestsQuery.error) ?? "Failed to load pull requests."}
      </p>
    );
  }

  if (allPullRequests.length === 0) {
    if (pullRequestsQuery.isLoading) {
      return <PullRequestListLoadingSkeleton />;
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
        items={allPullRequests}
        defs={reviewPullFilterDefs}
        resultCount={visible.length}
        search={search}
        onSearchChange={setSearch}
        activeFilters={activeFilters}
        onActiveFiltersChange={setActiveFilters}
        sortOptions={reviewPullSortOptions}
        sortId={sortId}
        onSortChange={setSortId}
        onOpenReference={(reference) => props.onSelectSource({ _tag: "pullRequest", reference })}
      />
      {pullRequestsQuery.isLoading ? (
        <PullRequestListLoadingSkeleton includeFilter={false} />
      ) : null}
      {visible.length === 0 ? (
        <EmptyState icon={<GitPullRequestIcon />} title="No matches">
          No pull requests match your filters.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((pullRequest) => (
            <li key={pullRequest.number}>
              <PullRequestRow pullRequest={pullRequest} onSelectSource={props.onSelectSource} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PullRequestListLoadingSkeleton(props: { includeFilter?: boolean }) {
  const includeFilter = props.includeFilter ?? true;
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading pull requests">
      {includeFilter ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-card/64 p-1.5 shadow-sm">
          <Skeleton className="h-8 w-72 rounded-2xl" />
          <Skeleton className="h-8 w-24 rounded-xl" />
          <Skeleton className="h-8 w-24 rounded-xl" />
          <Skeleton className="h-8 w-20 rounded-xl" />
        </div>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <li key={index}>
            <div className="flex min-w-0 flex-col gap-2 rounded-[1.15rem] border border-border/70 bg-card/90 px-3.5 py-3 shadow-[0_8px_24px_-22px_var(--foreground)]">
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="ms-auto h-4 w-14 rounded-full" />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
