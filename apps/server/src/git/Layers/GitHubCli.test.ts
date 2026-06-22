import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          state: "OPEN",
          mergedAt: null,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/codething-mvp",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }),
  );

  it.effect("lists repository pull requests with server-side filters", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: "Speed up review board",
            url: "https://github.com/octocat/demo/pull/42",
            baseRefName: "main",
            headRefName: "review-perf",
            headRepositoryOwner: { login: "alice" },
            author: { login: "alice", avatarUrl: "https://avatars.example/alice.png" },
            updatedAt: "2026-06-16T12:00:00Z",
            state: "OPEN",
            mergedAt: null,
            reviewDecision: "REVIEW_REQUIRED",
            isDraft: false,
            additions: 12,
            deletions: 4,
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            reviewRequests: [{ login: "tyler", avatarUrl: "https://avatars.example/tyler.png" }],
            labels: [{ name: "bug", color: "d73a4a" }],
            assignees: [{ login: "alice", avatarUrl: "https://avatars.example/alice.png" }],
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "all",
          limit: 25,
          search: "review board",
          author: "alice",
          assignee: "alice",
          baseBranch: "main",
          headBranch: "review-perf",
          label: "bug",
          reviewRequested: "tyler",
          draft: true,
          checksStatuses: ["passing", "failing"],
          reviewStatus: "changes-requested",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 42,
          title: "Speed up review board",
          url: "https://github.com/octocat/demo/pull/42",
          baseRefName: "main",
          headRefName: "review-perf",
          headRepositoryOwnerLogin: "alice",
          author: "alice",
          authorAvatarUrl: "https://avatars.example/alice.png",
          updatedAt: "2026-06-16T12:00:00Z",
          state: "open",
          reviewDecision: "REVIEW_REQUIRED",
          isDraft: false,
          additions: 12,
          deletions: 4,
          checksStatus: "passing",
          reviewRequests: ["tyler"],
          labels: ["bug"],
          assignees: ["alice"],
        },
      ]);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "all",
          "--limit",
          "25",
          "--author",
          "alice",
          "--assignee",
          "alice",
          "--base",
          "main",
          "--head",
          "review-perf",
          "--label",
          "bug",
          "--draft",
          "--search",
          "review board review-requested:tyler (status:failure OR status:success) review:changes_requested",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees,reviewRequests",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("routes owner-qualified head selectors through search syntax", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          headBranch: "octocat:review-perf",
        });
      });

      assert.deepStrictEqual(result, []);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--search",
          "head:octocat:review-perf",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("routes multi-label OR filters through search syntax", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          limit: 50,
          search: "review board",
          labels: ["priority 1", "bug"],
        });
      });

      assert.deepStrictEqual(result, []);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--search",
          'review board label:"bug","priority 1"',
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("routes pending check filters through search syntax", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          checksStatuses: ["pending", "passing"],
        });
      });

      assert.deepStrictEqual(result, []);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--search",
          "(status:pending OR status:success)",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("routes plural author/base/head/assignee filters through grouped search syntax", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          limit: 50,
          search: "review board",
          authors: ["bob", "alice"],
          baseBranches: ["release", "main"],
          headBranches: ["octocat:feature/shared", "feature/shared"],
          assignees: ["bob", "alice"],
          checksStatuses: ["passing", "failing"],
          reviewStatus: "approved",
        });
      });

      assert.deepStrictEqual(result, []);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--search",
          "review board (author:alice OR author:bob) (base:main OR base:release) (head:feature/shared OR head:octocat:feature/shared) (assignee:alice OR assignee:bob) (status:failure OR status:success) review:approved",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("merges singular and plural list filters before choosing flags or search", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "[]",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          author: "alice",
          authors: ["bob", "alice"],
          baseBranch: "main",
          baseBranches: ["release"],
          headBranch: "feature/shared",
          headBranches: ["octocat:feature/shared"],
          assignee: "alice",
          assignees: ["bob"],
        });
      });

      assert.deepStrictEqual(result, []);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--search",
          "(author:alice OR author:bob) (base:main OR base:release) (head:feature/shared OR head:octocat:feature/shared) (assignee:alice OR assignee:bob)",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("omits review request payloads unless reviewer filtering needs them", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 43,
            title: "Searchable review board",
            url: "https://github.com/octocat/demo/pull/43",
            baseRefName: "main",
            headRefName: "review-search",
            author: { login: "alice", avatarUrl: "https://avatars.example/alice.png" },
            updatedAt: "2026-06-16T12:00:00Z",
            state: "OPEN",
            mergedAt: null,
            reviewDecision: null,
            isDraft: false,
            additions: 2,
            deletions: 1,
            statusCheckRollup: [],
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listRepositoryPullRequests({
          cwd: "/repo",
          state: "open",
          limit: 50,
          search: "review",
          author: "alice",
        });
      });

      assert.deepStrictEqual(result[0]?.reviewRequests, []);
      assert.deepStrictEqual(result[0]?.labels, []);
      assert.deepStrictEqual(result[0]?.assignees, []);
      const jsonFieldsArg = mockedRunProcess.mock.calls[0]?.[1]?.at(-1);
      expect(jsonFieldsArg).not.toContain("reviewRequests");
      expect(jsonFieldsArg).not.toContain("body");
      expect(jsonFieldsArg).not.toContain("comments");
      expect(jsonFieldsArg).not.toContain("reviews");
      expect(jsonFieldsArg).not.toContain("commits");
      expect(jsonFieldsArg).not.toContain("latestReviews");
      expect(jsonFieldsArg).not.toContain("milestone");
      expect(jsonFieldsArg).not.toContain("changedFiles");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--author",
          "alice",
          "--search",
          "review",
          "--json",
          "number,title,author,updatedAt,state,mergedAt,reviewDecision,baseRefName,headRefName,headRepositoryOwner,url,isDraft,additions,deletions,statusCheckRollup,labels,assignees",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("loads lightweight review headers without commits reviews or checks", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 42,
            title: "Fast PR header",
            url: "https://github.com/octocat/demo/pull/42",
            state: "OPEN",
            isDraft: false,
            author: { login: "alice" },
            body: "Header body",
            baseRefName: "main",
            headRefName: "feature/review-header",
            createdAt: "2026-06-07T11:00:00Z",
            updatedAt: "2026-06-07T12:00:00Z",
            mergedAt: null,
            additions: 10,
            deletions: 2,
            changedFiles: 3,
            reviewDecision: null,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            milestone: null,
            labels: [],
            assignees: [],
            reviewRequests: [{ login: "bob" }, { name: "Review team", slug: "review-team" }],
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewRequests: {
                    nodes: [
                      {
                        requestedReviewer: {
                          __typename: "User",
                          login: "bob",
                          avatarUrl: "https://avatars.example/bob.png",
                        },
                      },
                      {
                        requestedReviewer: {
                          __typename: "Team",
                          name: "Review team",
                          slug: "review-team",
                          avatarUrl: "https://avatars.example/review-team.png",
                        },
                      },
                    ],
                  },
                  latestReviews: {
                    nodes: [],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "https://avatars.example/alice.png\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getReviewPullRequestHeader({ cwd: "/repo", reference: "42" });
      });

      const jsonFieldsArg = mockedRunProcess.mock.calls[0]?.[1]?.at(-1);
      expect(jsonFieldsArg).not.toContain("latestReviews");
      expect(jsonFieldsArg).not.toContain("commits");
      expect(jsonFieldsArg).not.toContain("statusCheckRollup");
      expect(result.detail.title).toBe("Fast PR header");
      expect(result.detail.commitsCount).toBeUndefined();
      expect(result.detail.checksStatus).toBeUndefined();
      expect(result.detail.authorAvatarUrl).toBe("https://avatars.example/alice.png");
      expect(result.detail.reviewers).toEqual([
        {
          login: "bob",
          avatarUrl: "https://avatars.example/bob.png",
          state: "REVIEW_REQUIRED",
        },
        {
          login: "Review team",
          avatarUrl: "https://avatars.example/review-team.png",
          state: "REVIEW_REQUIRED",
        },
      ]);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining([
          "api",
          "graphql",
          "-F",
          "owner=octocat",
          "-F",
          "name=demo",
          "-F",
          "number=42",
        ]),
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["api", "users/alice", "--jq", ".avatar_url"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(mockedRunProcess).not.toHaveBeenCalledWith(
        "gh",
        ["api", "users/bob", "--jq", ".avatar_url"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("enriches review conversation authors with GitHub avatars", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            comments: [
              {
                author: { login: "vercel" },
                body: "Deploy preview is ready.",
                createdAt: "2026-06-07T12:00:00Z",
                url: "https://github.com/octocat/demo/pull/42#issuecomment-1",
              },
            ],
            reviews: [
              {
                author: { login: "copilot-pull-request-reviewer" },
                body: "Potential issue found.",
                state: "COMMENTED",
                submittedAt: "2026-06-07T12:01:00Z",
                url: "https://github.com/octocat/demo/pull/42#pullrequestreview-1",
              },
            ],
            commits: [],
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "https://avatars.githubusercontent.com/u/14985020?v=4\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "https://avatars.githubusercontent.com/u/213165537?v=4\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getReviewConversation({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          kind: "comment",
          id: "comment-0",
          author: "vercel",
          authorAvatarUrl: "https://avatars.githubusercontent.com/u/14985020?v=4",
          body: "Deploy preview is ready.",
          createdAt: "2026-06-07T12:00:00Z",
          url: "https://github.com/octocat/demo/pull/42#issuecomment-1",
        },
        {
          kind: "review",
          id: "review-0",
          author: "copilot-pull-request-reviewer",
          authorAvatarUrl: "https://avatars.githubusercontent.com/u/213165537?v=4",
          state: "COMMENTED",
          body: "Potential issue found.",
          createdAt: "2026-06-07T12:01:00Z",
          url: "https://github.com/octocat/demo/pull/42#pullrequestreview-1",
        },
      ]);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["api", "users/vercel", "--jq", ".avatar_url"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["api", "users/copilot-pull-request-reviewer", "--jq", ".avatar_url"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );

  it.effect("paginates review timeline events", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: "https://github.com/octocat/demo/pull/42\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  timelineItems: {
                    pageInfo: { hasNextPage: true, endCursor: "timeline-cursor-1" },
                    nodes: [
                      {
                        __typename: "LabeledEvent",
                        actor: { login: "alice" },
                        createdAt: "2026-06-07T12:00:00Z",
                        label: { name: "bug" },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  timelineItems: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        __typename: "ClosedEvent",
                        actor: { login: "bob" },
                        createdAt: "2026-06-07T12:01:00Z",
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getReviewTimeline({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          kind: "labeled",
          actor: "alice",
          label: "bug",
          added: true,
          createdAt: "2026-06-07T12:00:00Z",
        },
        {
          kind: "closed",
          actor: "bob",
          createdAt: "2026-06-07T12:01:00Z",
        },
      ]);
      expect(mockedRunProcess).toHaveBeenCalledTimes(3);
      expect(mockedRunProcess).toHaveBeenNthCalledWith(
        2,
        "gh",
        expect.not.arrayContaining(["-F", "timelineCursor=timeline-cursor-1"]),
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(mockedRunProcess).toHaveBeenNthCalledWith(
        3,
        "gh",
        expect.arrayContaining(["-F", "timelineCursor=timeline-cursor-1"]),
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("paginates review threads and nested comments", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: "https://github.com/octocat/demo/pull/42\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: true, endCursor: "thread-cursor-1" },
                    nodes: [
                      {
                        id: "PRRT_1",
                        isResolved: false,
                        path: "src/app.ts",
                        line: 12,
                        diffSide: "RIGHT",
                        comments: {
                          pageInfo: { hasNextPage: true, endCursor: "comment-cursor-1" },
                          nodes: [
                            {
                              author: { login: "alice", avatarUrl: null },
                              body: "first",
                              createdAt: "2026-06-07T12:00:00Z",
                              url: "https://github.com/octocat/demo/pull/42#discussion_r1",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              node: {
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { login: "bob", avatarUrl: "https://avatars.example/bob.png" },
                      body: "second",
                      createdAt: "2026-06-07T12:01:00Z",
                      url: "https://github.com/octocat/demo/pull/42#discussion_r2",
                    },
                  ],
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "PRRT_2",
                        isResolved: true,
                        path: "src/old.ts",
                        line: 5,
                        diffSide: "LEFT",
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              author: { login: "carol", avatarUrl: null },
                              body: "third",
                              createdAt: "2026-06-07T12:02:00Z",
                              url: "https://github.com/octocat/demo/pull/42#discussion_r3",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequestThreads({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          id: "PRRT_1",
          isResolved: false,
          path: "src/app.ts",
          line: 12,
          side: "RIGHT",
          comments: [
            {
              author: "alice",
              body: "first",
              createdAt: "2026-06-07T12:00:00Z",
              url: "https://github.com/octocat/demo/pull/42#discussion_r1",
            },
            {
              author: "bob",
              authorAvatarUrl: "https://avatars.example/bob.png",
              body: "second",
              createdAt: "2026-06-07T12:01:00Z",
              url: "https://github.com/octocat/demo/pull/42#discussion_r2",
            },
          ],
        },
        {
          id: "PRRT_2",
          isResolved: true,
          path: "src/old.ts",
          line: 5,
          side: "LEFT",
          comments: [
            {
              author: "carol",
              body: "third",
              createdAt: "2026-06-07T12:02:00Z",
              url: "https://github.com/octocat/demo/pull/42#discussion_r3",
            },
          ],
        },
      ]);

      expect(mockedRunProcess).toHaveBeenCalledTimes(4);
      expect(mockedRunProcess).toHaveBeenNthCalledWith(
        3,
        "gh",
        expect.arrayContaining(["-F", "threadId=PRRT_1", "-F", "commentsCursor=comment-cursor-1"]),
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(mockedRunProcess).toHaveBeenNthCalledWith(
        4,
        "gh",
        expect.arrayContaining(["-F", "threadsCursor=thread-cursor-1"]),
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );
});
