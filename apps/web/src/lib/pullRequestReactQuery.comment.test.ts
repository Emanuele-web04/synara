import type { ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  githubInboxQueryKeys,
  pullRequestCommentMutationOptions,
  pullRequestQueryKeys,
} from "./pullRequestReactQuery";

describe("pullRequestCommentMutationOptions", () => {
  it("invalidates the list holding the repository and the commented detail only", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      body: "Looks good",
    } as const;
    const openListKey = githubInboxQueryKeys.list("open");
    const closedListKey = githubInboxQueryKeys.list("closed");
    const detailKey = pullRequestQueryKeys.detail(input);
    const otherDetailKey = pullRequestQueryKeys.detail({ ...input, number: 43 });
    const diffKey = pullRequestQueryKeys.diff(input);
    queryClient.setQueryData(openListKey, { items: [] });
    queryClient.setQueryData(closedListKey, {
      items: [{ projectId, repository: "other/repository", number: 7, isPinned: false }],
    });
    queryClient.setQueryData(detailKey, { state: "open" });
    queryClient.setQueryData(otherDetailKey, { state: "open" });
    queryClient.setQueryData(diffKey, {});
    const options = pullRequestCommentMutationOptions(queryClient);
    if (!options.onSettled) throw new Error("Comment onSettled hook is missing.");

    await Reflect.apply(options.onSettled, undefined, [{}, null, input, undefined, undefined]);

    // The detail state (open) names the list a new comment can reorder or pull in.
    expect(queryClient.getQueryState(openListKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(closedListKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDetailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(false);
  });
});
