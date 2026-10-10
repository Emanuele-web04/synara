import type { GitHubInboxListResult, ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  githubIssueCommentMutationOptions,
  githubIssueDetailQueryOptions,
} from "./githubInboxQueryOptions";
import {
  githubInboxListQueryOptions,
  githubInboxQueryKeys,
  githubInboxReviewBadgeQueryOptions,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
} from "./pullRequestReactQuery";

describe("GitHub inbox list query options", () => {
  it("polls every five minutes only while the page is visible, and refreshes on focus", () => {
    const options = githubInboxListQueryOptions("open");

    expect(options.queryKey).toEqual(["github-inbox", "list", "open", "created"]);
    expect(options.staleTime).toBe(60_000);
    expect(options.refetchInterval).toBe(5 * 60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
    // Cross-key placeholders rendered actionable rows under the wrong state heading.
    expect(options.placeholderData).toBeUndefined();
  });

  it("drives the sidebar badge from the open list every fifteen minutes", () => {
    const options = githubInboxReviewBadgeQueryOptions();
    const result = {
      reviewRequestedCount: 3,
      reviewRequestedCountIncomplete: true,
    } as GitHubInboxListResult;

    expect(options.queryKey).toEqual(githubInboxQueryKeys.list("open"));
    expect(options.refetchInterval).toBe(15 * 60_000);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.select?.(result)).toEqual({ count: 3, incomplete: true });
  });
});

describe("pull request detail query options", () => {
  const input = { projectId: "project-a" as ProjectId, repository: "acme/widgets", number: 42 };

  it("polls every two minutes while visible", () => {
    const options = pullRequestDetailQueryOptions(input);

    expect(options.staleTime).toBe(60_000);
    expect(options.refetchInterval).toBe(2 * 60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("disables detail polling and focus refresh while its dock is collapsed", () => {
    const options = pullRequestDetailQueryOptions(input, { pollingEnabled: false });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });

  it("keeps stale data visible when a background refresh fails", () => {
    const error = new Error("refresh failed");
    expect(pullRequestQueryErrorState({ data: { items: [] }, error, isError: true })).toEqual({
      initialError: null,
      backgroundError: error,
    });
    expect(pullRequestQueryErrorState({ data: undefined, error, isError: true })).toEqual({
      initialError: error,
      backgroundError: null,
    });
  });
});

describe("GitHub issue queries", () => {
  const input = { projectId: "project-a" as ProjectId, repository: "acme/widgets", number: 7 };

  it("polls issue detail like pull request detail", () => {
    const options = githubIssueDetailQueryOptions(input);
    expect(options.staleTime).toBe(60_000);
    expect(options.refetchInterval).toBe(2 * 60_000);
    expect(githubIssueDetailQueryOptions(input, { pollingEnabled: false }).refetchInterval).toBe(
      false,
    );
  });

  it("refreshes the commented issue and both inbox lists after a comment", async () => {
    const queryClient = new QueryClient();
    const detailKey = githubIssueDetailQueryOptions(input).queryKey;
    const otherDetailKey = githubIssueDetailQueryOptions({ ...input, number: 8 }).queryKey;
    for (const key of [
      detailKey,
      otherDetailKey,
      githubInboxQueryKeys.list("open"),
      githubInboxQueryKeys.list("closed"),
      githubInboxQueryKeys.list("open", "updated"),
      githubInboxQueryKeys.list("closed", "updated"),
    ]) {
      queryClient.setQueryData(key, {});
    }
    const options = githubIssueCommentMutationOptions(queryClient);
    if (!options.onSettled) throw new Error("Comment onSettled hook is missing.");

    await Reflect.apply(options.onSettled, undefined, [
      {},
      null,
      { ...input, body: "Thanks" },
      undefined,
      undefined,
    ]);

    for (const state of ["open", "closed"] as const) {
      expect(
        queryClient.getQueryState(githubInboxQueryKeys.list(state, "updated"))?.isInvalidated,
      ).toBe(true);
    }
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDetailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(githubInboxQueryKeys.list("open"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(githubInboxQueryKeys.list("closed"))?.isInvalidated).toBe(
      true,
    );
  });
});
