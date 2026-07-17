import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { createGitHubCliWithFakeGh } from "./fakeGitHubCli";

describe("fakeGitHubCli pull request surface", () => {
  it("supports viewer, repository list, diff, and action calls", async () => {
    const { service, ghCalls } = createGitHubCliWithFakeGh({
      viewerLogin: "octocat",
      repositoryPullRequestListJson: JSON.stringify([
        {
          number: 2,
          title: "Fake PR",
          url: "https://github.com/acme/app/pull/2",
          headRefName: "fake",
          baseRefName: "main",
          state: "OPEN",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ]),
      pullRequestDiff: { patch: "diff --git a/a b/a", truncated: false },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const viewer = yield* service.getViewerLogin({ cwd: "/repo" });
        const batch = yield* service.listRepositoryPullRequests({
          cwd: "/repo",
          repository: "acme/app",
          state: "open",
          involvement: "reviewing",
          viewer,
        });
        const diff = yield* service.getPullRequestDiff({
          cwd: "/repo",
          repository: "acme/app",
          number: 2,
        });
        yield* service.runPullRequestAction({
          cwd: "/repo",
          repository: "acme/app",
          number: 2,
          action: "close",
        });
        return { viewer, batch, diff };
      }),
    );

    expect(result.viewer).toBe("octocat");
    expect(result.batch.entries).toHaveLength(1);
    expect(result.batch.rawCount).toBe(1);
    expect(result.diff.patch).toContain("diff --git");
    expect(
      ghCalls.some((call) => call.includes("--search review-requested:octocat --state open")),
    ).toBe(true);
    expect(ghCalls.some((call) => call.includes("pr action close 2"))).toBe(true);
  });
});
