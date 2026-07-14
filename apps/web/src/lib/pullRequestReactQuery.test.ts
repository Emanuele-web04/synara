import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidateOtherPullRequestQueries, pullRequestQueryKeys } from "./pullRequestReactQuery";

describe("invalidateOtherPullRequestQueries", () => {
  it("keeps the refreshed list current while invalidating sibling lists", async () => {
    const queryClient = new QueryClient();
    const refreshedKey = pullRequestQueryKeys.list({
      involvement: "all",
      state: "open",
      projectId: null,
    });
    const siblingKey = pullRequestQueryKeys.list({
      involvement: "reviewing",
      state: "open",
      projectId: null,
    });
    queryClient.setQueryData(refreshedKey, { entries: [] });
    queryClient.setQueryData(siblingKey, { entries: [] });

    await invalidateOtherPullRequestQueries(queryClient, refreshedKey);

    expect(queryClient.getQueryState(refreshedKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(siblingKey)?.isInvalidated).toBe(true);
  });
});
