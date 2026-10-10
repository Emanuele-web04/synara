import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli, PULL_REQUEST_SUMMARY_JSON_FIELDS } from "../Services/GitHubCli.ts";
import {
  fakeInboxGraphQlJson,
  fakeInboxIssueNode,
  fakeInboxPullRequestNode,
} from "../testing/fakeGitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";
import { GITHUB_READ_SLOTS } from "../githubReadGate";

const mockedRunProcess = vi.mocked(runProcess);

const processResult = (stdout: string, overrides: { code?: number; stderr?: string } = {}) => ({
  stdout,
  stderr: overrides.stderr ?? "",
  code: overrides.code ?? 0,
  signal: null,
  timedOut: false,
});
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
  vi.unstubAllEnvs();
});

layer("GitHubCliLive", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/example-org/sample-repo/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          state: "OPEN",
          mergedAt: null,
          isDraft: true,
          mergeable: "CONFLICTING",
          additions: 38,
          deletions: 36,
          changedFiles: 3,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/sample-repo",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
          updatedAt: "2026-07-05T09:30:00Z",
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
        url: "https://github.com/example-org/sample-repo/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/sample-repo",
        headRepositoryOwnerLogin: "octocat",
        updatedAt: "2026-07-05T09:30:00Z",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["pr", "view", "#42", "--json", PULL_REQUEST_SUMMARY_JSON_FIELDS],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("serves repeated pull request lookups from cache until a mutation", () =>
    Effect.gen(function* () {
      const processResult = (stdout: string) => ({
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const viewOutput = JSON.stringify({
        number: 77,
        title: "Cached lookup",
        url: "https://github.com/example-org/sample-repo/pull/77",
        baseRefName: "main",
        headRefName: "feature/cached-lookup",
        state: "OPEN",
      });
      mockedRunProcess.mockResolvedValue(processResult(viewOutput));
      const gh = yield* GitHubCli;
      const lookup = gh.getPullRequest({ cwd: "/repo-cache", reference: "#77" });

      yield* lookup;
      yield* lookup;
      expect(mockedRunProcess).toHaveBeenCalledTimes(1);

      mockedRunProcess.mockResolvedValueOnce(processResult(""));
      yield* gh.createPullRequest({
        cwd: "/repo-cache",
        baseBranch: "main",
        headSelector: "feature/other",
        title: "Other",
        bodyFile: "/tmp/body.md",
      });
      yield* lookup;
      expect(mockedRunProcess).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("lists any-state pull requests with the shared field list", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 7,
            title: "Merged work",
            url: "https://github.com/o/r/pull/7",
            baseRefName: "main",
            headRefName: "feature/merged-work",
            state: "MERGED",
            mergedAt: "2026-07-01T08:00:00Z",
            updatedAt: "2026-07-01T08:00:00Z",
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listPullRequests({ cwd: "/repo", headSelector: "feature/merged-work" });
      });

      assert.equal(result.length, 1);
      assert.equal(result[0]?.state, "merged");
      assert.equal(result[0]?.updatedAt, "2026-07-01T08:00:00Z");
      assert.equal(result[0]?.mergeability, "unknown");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "list",
          "--head",
          "feature/merged-work",
          "--state",
          "all",
          "--limit",
          "20",
          "--json",
          PULL_REQUEST_SUMMARY_JSON_FIELDS,
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("skips malformed list entries instead of hiding the healthy ones", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { number: -1, title: "", url: "" },
          {
            number: 8,
            title: "Healthy PR",
            url: "https://github.com/o/r/pull/8",
            baseRefName: "main",
            headRefName: "feature/healthy",
            state: "OPEN",
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listPullRequests({ cwd: "/repo", headSelector: "feature/healthy" });
      });

      assert.equal(result.length, 1);
      assert.equal(result[0]?.number, 8);
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/sample-repo",
          url: "https://github.com/octocat/sample-repo",
          sshUrl: "git@github.com:octocat/sample-repo.git",
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
          repository: "octocat/sample-repo",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/sample-repo",
        url: "https://github.com/octocat/sample-repo",
        sshUrl: "git@github.com:octocat/sample-repo.git",
      });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining(["repo", "view", "octocat/sample-repo"]),
      );
    }),
  );

  it.effect("normalizes check runs and status contexts from the rollup", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Snapshot PR",
          url: "https://github.com/o/r/pull/42",
          baseRefName: "main",
          headRefName: "feature/snapshot",
          headRefOid: "abc123",
          state: "OPEN",
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "Format, Lint, Typecheck",
              status: "IN_PROGRESS",
              conclusion: "",
              detailsUrl: "https://github.com/o/r/actions/runs/1",
            },
            {
              __typename: "CheckRun",
              name: "Sync PR size labels",
              status: "COMPLETED",
              conclusion: "SKIPPED",
              detailsUrl: null,
            },
            {
              __typename: "CheckRun",
              name: "Release Smoke",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/o/r/actions/runs/2",
            },
            {
              __typename: "StatusContext",
              context: "ci/legacy",
              state: "FAILURE",
              targetUrl: "https://ci.example/build/3",
            },
          ],
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequestWithChecks({ cwd: "/repo", reference: "42" });
      });

      assert.deepStrictEqual(result.checks, [
        {
          name: "Format, Lint, Typecheck",
          status: "pending",
          url: "https://github.com/o/r/actions/runs/1",
        },
        { name: "Sync PR size labels", status: "skipped", url: null },
        {
          name: "Release Smoke",
          status: "success",
          url: "https://github.com/o/r/actions/runs/2",
        },
        { name: "ci/legacy", status: "failure", url: "https://ci.example/build/3" },
      ]);
      assert.strictEqual(result.summary.number, 42);
      assert.strictEqual(result.summary.state, "open");
      assert.strictEqual(result.headSha, "abc123");
      // Fields gh did not report normalize to safe fallbacks, not fabricated values.
      assert.strictEqual(result.summary.isDraft, false);
      assert.strictEqual(result.summary.mergeability, "unknown");
      assert.strictEqual(result.summary.additions, null);
      assert.strictEqual(result.summary.deletions, null);
      assert.strictEqual(result.summary.changedFiles, null);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "42",
          "--json",
          `${PULL_REQUEST_SUMMARY_JSON_FIELDS},headRefOid,statusCheckRollup`,
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("returns root comments of unresolved review threads only", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_11",
                            body: "Avoid returning shims directly",
                            path: "CursorAcpCommand.ts",
                            url: "https://github.com/o/r/pull/42#discussion_r11",
                            createdAt: "2026-07-01T10:00:00Z",
                            author: { login: "codex-bot" },
                          },
                        ],
                      },
                    },
                    {
                      isResolved: true,
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_12",
                            body: "Already handled",
                            path: "CursorAcpCommand.ts",
                            url: "https://github.com/o/r/pull/42#discussion_r12",
                            createdAt: "2026-07-01T09:00:00Z",
                            author: { login: "codex-bot" },
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      comments: { nodes: [] },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
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
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.example.test",
          owner: "o",
          repo: "r",
          number: 42,
        });
      });

      assert.deepStrictEqual(result.comments, [
        {
          id: "PRRC_11",
          author: "codex-bot",
          body: "Avoid returning shims directly",
          path: "CursorAcpCommand.ts",
          url: "https://github.com/o/r/pull/42#discussion_r11",
          createdAt: "2026-07-01T10:00:00Z",
        },
      ]);
      assert.equal(result.truncated, false);

      const [command, args, options] = mockedRunProcess.mock.calls[0] ?? [];
      expect(command).toBe("gh");
      expect(options).toEqual(expect.objectContaining({ cwd: "/repo" }));
      expect(args).toEqual(
        expect.arrayContaining([
          "api",
          "graphql",
          "--hostname",
          "github.example.test",
          "-F",
          "owner=o",
          "-F",
          "repo=r",
          "-F",
          "number=42",
        ]),
      );
      expect(args?.some((arg) => arg.includes("reviewThreads(first: $first, after: $after)"))).toBe(
        true,
      );
      expect(args).toEqual(expect.arrayContaining(["-F", "first=50"]));
    }),
  );

  it.effect("paginates unresolved review threads", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: "PRRC_1",
                              body: "First page",
                              path: "a.ts",
                              url: "https://github.com/o/r/pull/42#discussion_r1",
                              createdAt: "2026-07-01T10:00:00Z",
                              author: { login: "bot" },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "cursor-1",
                    },
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
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: "PRRC_2",
                              body: "Second page",
                              path: "b.ts",
                              url: "https://github.com/o/r/pull/42#discussion_r2",
                              createdAt: "2026-07-01T10:01:00Z",
                              author: { login: "bot" },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
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
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.com",
          owner: "o",
          repo: "r",
          number: 42,
        });
      });

      assert.deepStrictEqual(
        result.comments.map((comment) => comment.body),
        ["First page", "Second page"],
      );
      assert.equal(result.truncated, false);
      expect(mockedRunProcess).toHaveBeenCalledTimes(2);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining(["-F", "after=cursor-1"]),
      );
    }),
  );

  it.effect("marks one-page review-comment overflow as truncated", () =>
    Effect.gen(function* () {
      const unresolvedThreads = Array.from({ length: 21 }, (_, index) => ({
        isResolved: false,
        comments: {
          nodes: [
            {
              id: `PRRC_${index}`,
              body: `Finding ${index}`,
              path: "bounded.ts",
              url: `https://github.com/o/r/pull/42#discussion_r${index}`,
              createdAt: "2026-07-01T10:00:00Z",
              author: { login: "bot" },
            },
          ],
        },
      }));
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: unresolvedThreads,
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
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
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.com",
          owner: "o",
          repo: "r",
          number: 42,
        });
      });

      assert.equal(result.comments.length, 20);
      assert.equal(result.truncated, true);
      expect(mockedRunProcess).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("marks truncation when more pages exist but no cursor is returned", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_1",
                            body: "Finding",
                            path: "cursorless.ts",
                            url: "https://github.com/o/r/pull/42#discussion_r1",
                            createdAt: "2026-07-01T10:00:00Z",
                            author: { login: "bot" },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: null,
                  },
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
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.com",
          owner: "o",
          repo: "r",
          number: 42,
        });
      });

      assert.equal(result.comments.length, 1);
      assert.equal(result.truncated, true);
      expect(mockedRunProcess).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("stops review-thread pagination at the page-count limit", () =>
    Effect.gen(function* () {
      for (let page = 1; page <= 5; page += 1) {
        mockedRunProcess.mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: true,
                        comments: {
                          nodes: [
                            {
                              id: `PRRC_resolved_${page}`,
                              body: `Already handled ${page}`,
                              path: "bounded.ts",
                              url: `https://github.com/o/r/pull/42#discussion_r${page}`,
                              createdAt: "2026-07-01T10:00:00Z",
                              author: { login: "bot" },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: `cursor-${page}`,
                    },
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
      }

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.com",
          owner: "o",
          repo: "r",
          number: 42,
        });
      });

      assert.deepStrictEqual(result.comments, []);
      assert.equal(result.truncated, true);
      expect(mockedRunProcess).toHaveBeenCalledTimes(5);
      expect(mockedRunProcess.mock.calls[4]?.[1]).toEqual(
        expect.arrayContaining(["-F", "after=cursor-4"]),
      );
    }),
  );

  it.effect("surfaces GraphQL errors from review-thread queries", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          errors: [{ message: "Field 'reviewThreads' does not exist" }],
          data: {
            repository: {
              pullRequest: null,
            },
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequestReviewComments({
          cwd: "/repo",
          host: "github.com",
          owner: "o",
          repo: "r",
          number: 42,
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("GitHub GraphQL returned errors"), true);
      assert.equal(error.message.includes("Field 'reviewThreads' does not exist"), true);
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

  it.effect(
    "reads a repository's inbox lists in one GraphQL call without the involvement search",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("GH_HOST", "enterprise.example.com");
        mockedRunProcess.mockResolvedValueOnce(
          processResult(
            fakeInboxGraphQlJson({
              viewer: "octocat",
              pullRequests: [
                fakeInboxPullRequestNode(9, {
                  reviewRequests: {
                    nodes: [
                      { requestedReviewer: { __typename: "User", login: "reviewer" } },
                      { requestedReviewer: { __typename: "Team", slug: "platform" } },
                    ],
                  },
                  labels: { nodes: [{ name: "ready", color: "00ff00" }] },
                  assignees: {
                    nodes: [{ login: "octocat", avatarUrl: null, url: null, name: null }],
                  },
                  comments: { totalCount: 3 },
                  stackEntry: { position: 2 },
                  stack: { number: 4, size: 3, baseRefName: "main" },
                }),
                { __typename: "PullRequest", number: "broken" },
              ],
              pullRequestTotalCount: 120,
              issues: [fakeInboxIssueNode(12, { comments: { totalCount: 5 } })],
              // Ignored by the lists decoder: the involvement document reads it.
              mine: [fakeInboxIssueNode(3)],
              reviewRequested: [9],
              reviewRequestedCount: 60,
              rateLimit: { cost: 5, remaining: 4_321, resetAt: "2026-07-15T01:00:00Z" },
            }),
          ),
        );

        const gh = yield* GitHubCli;
        const snapshot = yield* gh.listRepositoryInbox({
          cwd: "/repo",
          repository: "acme/app",
          state: "open",
          sort: "created",
        });

        assert.equal(mockedRunProcess.mock.calls.length, 1);
        assert.equal(snapshot.viewer, "octocat");
        assert.deepStrictEqual(
          snapshot.pullRequests.map((pullRequest) => pullRequest.number),
          [9],
        );
        assert.deepStrictEqual(
          snapshot.issues.map((issue) => issue.number),
          [12],
        );
        const pullRequest = snapshot.pullRequests[0]!;
        assert.deepStrictEqual(pullRequest.reviewRequestLogins, ["reviewer"]);
        assert.deepStrictEqual(pullRequest.labels, [{ name: "ready", color: "00ff00" }]);
        assert.equal(pullRequest.commentCount, 3);
        assert.deepStrictEqual(
          pullRequest.assignees.map((assignee) => assignee.login),
          ["octocat"],
        );
        assert.deepStrictEqual(pullRequest.stack, {
          number: 4,
          size: 3,
          position: 2,
          baseBranch: "main",
        });
        assert.equal(snapshot.issues[0]?.commentCount, 5);
        assert.equal(snapshot.truncatedPullRequests, true);
        assert.equal(snapshot.truncatedIssues, false);
        assert.deepStrictEqual(snapshot.reviewRequestedNumbers, [9]);
        assert.equal(snapshot.reviewRequestedCount, 60);
        assert.deepStrictEqual(snapshot.rateLimit, {
          cost: 5,
          remaining: 4_321,
          resetAt: "2026-07-15T01:00:00Z",
        });
        const [command, args, options] = mockedRunProcess.mock.calls[0]!;
        assert.equal(command, "gh");
        const query = (args as string[]).find((arg) => arg.startsWith("query=")) ?? "";
        expect(query.match(/orderBy: \{field: CREATED_AT, direction: DESC\}/g)).toHaveLength(2);
        expect(query).not.toContain("mine:");
        expect(query).not.toContain("$mineQuery");
        expect((args as string[]).some((arg) => arg.startsWith("mineQuery="))).toBe(false);
        expect(args).toEqual(
          expect.arrayContaining([
            "api",
            "graphql",
            "--hostname",
            "github.com",
            expect.stringContaining("reviewRequested: search(query: $reviewQuery"),
            "owner=acme",
            "name=app",
            "prStates[]=OPEN",
            "issueStates[]=OPEN",
            "reviewQuery=repo:acme/app is:pr is:open review-requested:@me",
            "includeReview=true",
          ]),
        );
        expect(options).toEqual(
          expect.objectContaining({ env: expect.objectContaining({ GH_HOST: "github.com" }) }),
        );
      }),
  );

  it.effect("reads the involvement search as its own document with full row fields", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          fakeInboxGraphQlJson({
            mine: [
              fakeInboxIssueNode(3, { title: "Old issue" }),
              fakeInboxPullRequestNode(9),
              fakeInboxIssueNode(3),
              { __typename: "PullRequest", number: 11, title: null },
              { __typename: "Discussion", number: 4 },
            ],
            rateLimit: { cost: 2, remaining: 4_300, resetAt: "2026-07-15T01:00:00Z" },
          }),
        ),
      );

      const gh = yield* GitHubCli;
      const involvement = yield* gh.listRepositoryInboxInvolvement({
        cwd: "/repo",
        repository: "acme/app",
        state: "closed",
      });

      // #11 is malformed, so it has no row, but it still marks the viewer as involved.
      assert.deepStrictEqual(involvement.involvedNumbers, [3, 9, 11]);
      assert.deepStrictEqual(
        involvement.items.map((remote) => [remote.kind, remote.item.number, remote.item.title]),
        [
          ["issue", 3, "Old issue"],
          ["pullRequest", 9, "PR 9"],
          ["issue", 3, "Issue 3"],
        ],
      );
      assert.equal(involvement.rateLimit?.remaining, 4_300);
      const args = mockedRunProcess.mock.calls[0]?.[1] as string[];
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      expect(query).toContain(
        "issueCount nodes { __typename ...InboxPullRequestFields ...InboxIssueFields }",
      );
      expect(query).not.toContain("repository(");
      expect(args).toEqual(
        expect.arrayContaining([
          "graphql",
          "mineQuery=repo:acme/app is:closed involves:@me sort:updated-desc",
        ]),
      );
    }),
  );

  it.effect("drops the stack fields from both inbox documents after either is rejected", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "gh api graphql failed (code=1, signal=null). gh: Field 'stackEntry' doesn't exist on type 'PullRequest'",
        ),
      );
      mockedRunProcess.mockResolvedValue(processResult(fakeInboxGraphQlJson({})));

      // A fresh layer: the shared one may already have turned the stack fields off.
      yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        const input = { cwd: "/repo", repository: "acme/app", state: "open" } as const;
        yield* gh.listRepositoryInboxInvolvement(input);
        yield* gh.listRepositoryInbox(input);
        yield* gh.listRepositoryInboxInvolvement(input);
      }).pipe(Effect.provide(Layer.fresh(GitHubCliLive)));

      const queries = mockedRunProcess.mock.calls.map(
        (call) => (call[1] as string[]).find((arg) => arg.startsWith("query=")) ?? "",
      );
      assert.equal(queries.length, 4);
      expect(queries[0]).toContain("stackEntry");
      expect(queries[0]).toContain("mine:");
      expect(queries[1]).toContain("mine:");
      for (const query of queries.slice(1)) expect(query).not.toContain("stackEntry");
      expect(queries[2]).toContain("repository(");
    }),
  );

  it.effect("reads closed and merged items together and skips the review search", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          fakeInboxGraphQlJson({
            pullRequests: [
              fakeInboxPullRequestNode(5, { state: "MERGED", mergedAt: "2026-07-03T00:00:00Z" }),
              fakeInboxPullRequestNode(6, { state: "CLOSED" }),
            ],
            issues: [
              fakeInboxIssueNode(7, { state: "CLOSED", stateReason: "NOT_PLANNED" }),
              fakeInboxIssueNode(8, { state: "CLOSED", stateReason: "DUPLICATE" }),
            ],
            reviewRequested: null,
          }),
        ),
      );

      const gh = yield* GitHubCli;
      const snapshot = yield* gh.listRepositoryInbox({
        cwd: "/repo",
        repository: "acme/app",
        state: "closed",
      });

      assert.deepStrictEqual(
        snapshot.pullRequests.map((pullRequest) => pullRequest.state),
        ["merged", "closed"],
      );
      assert.deepStrictEqual(
        snapshot.issues.map((issue) => issue.stateReason),
        ["not-planned", "duplicate"],
      );
      assert.equal(snapshot.reviewRequestedCount, 0);
      const args = mockedRunProcess.mock.calls[0]?.[1];
      expect(args).toEqual(
        expect.arrayContaining([
          "prStates[]=CLOSED",
          "prStates[]=MERGED",
          "issueStates[]=CLOSED",
          "includeReview=false",
        ]),
      );
      expect(args).not.toContain("prStates[]=OPEN");
    }),
  );

  it.effect("drops the optional stack fields once GitHub rejects them", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "gh api graphql failed (code=1, signal=null). gh: Field 'stackEntry' doesn't exist on type 'PullRequest'",
        ),
      );
      mockedRunProcess.mockResolvedValue(processResult(fakeInboxGraphQlJson({})));

      const gh = yield* GitHubCli;
      yield* gh.listRepositoryInbox({ cwd: "/repo", repository: "acme/app", state: "open" });
      yield* gh.listRepositoryInbox({ cwd: "/repo", repository: "acme/app", state: "open" });

      const queries = mockedRunProcess.mock.calls.map((call) =>
        (call[1] as string[]).find((arg) => arg.startsWith("query=")),
      );
      assert.equal(queries.length, 3);
      expect(queries[0]).toContain("stackEntry");
      expect(queries[1]).not.toContain("stackEntry");
      expect(queries[2]).not.toContain("stackEntry");
    }),
  );

  it.effect("classifies GitHub rate limits separately from other failures", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "gh api graphql -f query=query { rateLimit { cost } } failed (code=1, signal=null). gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        ),
      );
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "gh api graphql -f query=query { rateLimit { cost } } failed (code=1, signal=null). gh: Something went wrong (HTTP 502)",
        ),
      );
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          fakeInboxGraphQlJson({
            errors: [{ type: "RATE_LIMITED", message: "API rate limit already exceeded" }],
          }),
        ),
      );

      const gh = yield* GitHubCli;
      const read = () =>
        gh
          .listRepositoryInbox({ cwd: "/repo", repository: "acme/app", state: "open" })
          .pipe(Effect.flip);
      assert.equal((yield* read()).reason, "rate-limited");
      assert.equal((yield* read()).reason, "other");
      assert.equal((yield* read()).reason, "rate-limited");
    }),
  );

  it.effect("probes for changes with a conditional request that a 304 answers for free", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-Ratelimit-Remaining: 4999\r\n\r\n[{"number":1}]',
        ),
      );
      mockedRunProcess.mockResolvedValueOnce(
        processResult('HTTP/2.0 304 Not Modified\r\nEtag: "abc"\r\n\r\n', {
          code: 1,
          stderr: "gh: HTTP 304",
        }),
      );
      mockedRunProcess.mockResolvedValueOnce(
        processResult("HTTP/2.0 403 Forbidden\r\n\r\n", {
          code: 1,
          stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        }),
      );

      const gh = yield* GitHubCli;
      const first = yield* gh.probeRepositoryInboxChanges({
        cwd: "/repo",
        repository: "acme/app",
        etag: null,
      });
      const second = yield* gh.probeRepositoryInboxChanges({
        cwd: "/repo",
        repository: "acme/app",
        etag: 'W/"abc"',
      });
      const limited = yield* gh
        .probeRepositoryInboxChanges({ cwd: "/repo", repository: "acme/app", etag: 'W/"abc"' })
        .pipe(Effect.flip);

      assert.deepStrictEqual(first, { changed: true, etag: 'W/"abc"' });
      assert.deepStrictEqual(second, { changed: false });
      assert.equal(limited.reason, "rate-limited");
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "api",
        "--hostname",
        "github.com",
        "-i",
        "repos/acme/app/issues?state=all&sort=updated&direction=desc&per_page=1",
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining(["-H", 'If-None-Match: W/"abc"']),
      );
      expect(mockedRunProcess.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({ allowNonZeroExit: true }),
      );
    }),
  );

  it.effect("looks up pinned items by number and treats only GitHub's NOT_FOUND as missing", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            data: {
              repository: {
                item_4: fakeInboxIssueNode(4),
                item_9: fakeInboxPullRequestNode(9),
                item_99: null,
              },
            },
            errors: [
              {
                type: "NOT_FOUND",
                path: ["repository", "item_99"],
                message: "Could not resolve to an issue or pull request with the number of 99.",
              },
            ],
          }),
          { code: 1, stderr: "gh: Could not resolve to an issue or pull request" },
        ),
      );
      mockedRunProcess.mockResolvedValueOnce(
        processResult("", { code: 1, stderr: "gh: HTTP 502: Bad Gateway" }),
      );

      const gh = yield* GitHubCli;
      const results = yield* gh.getRepositoryInboxItems({
        cwd: "/repo",
        repository: "acme/app",
        numbers: [4, 9, 99],
      });
      const failure = yield* gh
        .getRepositoryInboxItems({ cwd: "/repo", repository: "acme/app", numbers: [5] })
        .pipe(Effect.flip);

      const kindOf = (number: number) => {
        const lookup = results.get(number);
        return lookup?._tag === "found" ? lookup.item.kind : null;
      };
      assert.equal(kindOf(4), "issue");
      assert.equal(kindOf(9), "pullRequest");
      assert.deepStrictEqual(results.get(99), { _tag: "not-found" });
      assert.equal(failure.reason, "other");
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("item_99: issueOrPullRequest(number: 99)"),
        ]),
      );
    }),
  );

  for (const [totalCount, missingDate, expectedTruncated] of [
    [100, false, false],
    [101, false, true],
    [100, true, true],
  ] as const) {
    it.effect(
      `preserves issue comment total ${totalCount} and completeness (missing date: ${missingDate})`,
      () =>
        Effect.gen(function* () {
          mockedRunProcess.mockResolvedValueOnce(
            processResult(
              JSON.stringify({
                data: {
                  repository: {
                    issue: {
                      number: 1,
                      title: "Issue with comments",
                      url: "https://github.com/acme/app/issues/1",
                      createdAt: "2026-07-01T00:00:00Z",
                      updatedAt: "2026-07-03T00:00:00Z",
                      assignees: { nodes: [] },
                      labels: { nodes: [] },
                      comments: {
                        totalCount,
                        pageInfo: { hasNextPage: totalCount > 100 },
                        nodes: Array.from({ length: 100 }, (_, index) => ({
                          id: `IC_${index}`,
                          body: "Comment",
                          ...(missingDate && index === 0
                            ? {}
                            : { createdAt: "2026-07-02T00:00:00Z" }),
                        })),
                      },
                    },
                  },
                },
              }),
            ),
          );
          const gh = yield* GitHubCli;
          const detail = yield* gh.getIssueDetail({
            cwd: "/repo",
            repository: "acme/app",
            number: 1,
          });
          assert.equal(detail.commentCount, totalCount);
          assert.equal(detail.comments.length, missingDate ? 99 : 100);
          assert.equal(detail.commentsTruncated, expectedTruncated);
        }),
    );
  }

  it.effect("reads issue detail and posts issue comments over stdin", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            data: {
              repository: {
                issue: {
                  number: 1374,
                  title: "Feature request",
                  url: "https://github.com/acme/app/issues/1374",
                  body: "Details",
                  state: "CLOSED",
                  stateReason: "COMPLETED",
                  author: { login: "alex", name: "Alex" },
                  assignees: { nodes: [] },
                  labels: { nodes: [{ name: "kind:feature", color: "0969da" }] },
                  comments: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        id: "IC_2",
                        author: { login: "b" },
                        body: "second",
                        createdAt: "2026-07-03T00:00:00Z",
                      },
                      {
                        id: "IC_1",
                        author: { login: "a" },
                        body: "first",
                        createdAt: "2026-07-02T00:00:00Z",
                      },
                    ],
                  },
                  createdAt: "2026-07-01T00:00:00Z",
                  updatedAt: "2026-07-03T00:00:00Z",
                  closedAt: "2026-07-03T00:00:00Z",
                },
              },
            },
          }),
        ),
      );
      mockedRunProcess.mockResolvedValueOnce(processResult(""));

      const gh = yield* GitHubCli;
      const detail = yield* gh.getIssueDetail({
        cwd: "/repo",
        repository: "acme/app",
        number: 1374,
      });
      yield* gh.commentOnIssue({
        cwd: "/repo",
        repository: "acme/app",
        number: 1374,
        body: "private text",
      });

      assert.equal(detail.state, "closed");
      assert.equal(detail.stateReason, "completed");
      assert.deepStrictEqual(
        detail.comments.map((comment) => [comment.id, comment.kind]),
        [
          ["IC_1", "issue-comment"],
          ["IC_2", "issue-comment"],
        ],
      );
      assert.equal(detail.commentsTruncated, false);
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        expect.stringContaining("comments(first: 100)"),
        "-F",
        "owner=acme",
        "-F",
        "name=app",
        "-F",
        "number=1374",
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "issue",
        "comment",
        "1374",
        "--repo",
        "github.com/acme/app",
        "--body-file",
        "-",
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[1]).not.toContain("private text");
      expect(mockedRunProcess.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({ stdin: "private text" }),
      );
    }),
  );

  it.effect("accepts commits with empty or missing headlines and omits the files field", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 9,
          title: "Empty commit messages",
          url: "https://github.com/acme/app/pull/9",
          headRefName: "empty-message",
          baseRefName: "main",
          state: "OPEN",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
          commits: [
            {
              oid: "abc",
              messageHeadline: "",
              committedDate: "2026-07-01T01:00:00Z",
            },
            { oid: "def", committedDate: "2026-07-01T02:00:00Z" },
          ],
          reviews: [
            {
              id: "pending-review",
              body: "Draft feedback",
              state: "PENDING",
              updatedAt: "2026-07-01T03:00:00Z",
              author: { login: "reviewer" },
            },
          ],
          reviewRequests: [{ __typename: "Team", name: "Platform", slug: "platform" }],
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const gh = yield* GitHubCli;
      const detail = yield* gh.getPullRequestDetail({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
      });
      assert.deepStrictEqual(
        detail.commits.map((commit) => commit.messageHeadline),
        ["", ""],
      );
      // avatars derive from real user logins only — a team slug could show an unrelated user with the same name
      assert.deepStrictEqual(detail.reviewers, [
        {
          login: "platform",
          name: "Platform",
          avatarUrl: null,
          url: null,
        },
        {
          login: "reviewer",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/reviewer?size=64",
          url: null,
        },
      ]);
      expect(detail.comments).toContainEqual(
        expect.objectContaining({
          id: "pending-review",
          body: "Draft feedback",
          createdAt: "2026-07-01T03:00:00Z",
          reviewState: "PENDING",
        }),
      );
      const detailFields = mockedRunProcess.mock.calls[0]?.[1]?.at(-1) ?? "";
      expect(detailFields).not.toContain("files");
      expect(detailFields).not.toMatch(
        /headRepository|latestReviews|milestone|assignees|autoMergeRequest/,
      );
    }),
  );

  for (const { label, login } of [
    { label: "empty", login: "" },
    { label: "null", login: null },
    { label: "whitespace-only", login: " \t " },
    { label: "missing", login: undefined },
  ]) {
    it.effect(`tolerates commit authors with ${label} GitHub login`, () =>
      Effect.gen(function* () {
        mockedRunProcess.mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 1016,
            title: "fix(models): normalize provider model display names",
            url: "https://github.com/acme/app/pull/1016",
            headRefName: "fix/normalize-model-display-names",
            baseRefName: "main",
            state: "MERGED",
            mergedAt: "2026-09-08T13:33:01Z",
            createdAt: "2026-09-07T05:30:14Z",
            updatedAt: "2026-09-08T13:33:01Z",
            commits: [
              {
                oid: "31967670e7d8ac8e6271187cf91e3d08ed48dc96",
                messageHeadline: "fix(models): normalize provider model display names",
                committedDate: "2026-09-07T05:16:29Z",
                authors: [
                  { login: " SHLE1 ", name: " SHLE1 " },
                  {
                    login,
                    name: " Local co-author ",
                    avatarUrl: "https://avatars.githubusercontent.com/unrelated",
                    url: "https://github.com/unrelated",
                  },
                  { login, name: " ", slug: "not-a-user" },
                ],
              },
              {
                oid: "5a554f9e40043fba3184182c22f7f4bab617fc19",
                messageHeadline: "fix(models): ignore inherited display-name tokens",
                committedDate: "2026-09-08T13:18:37Z",
                // `gh` emits empty-string logins for local-git authors — must not fail the whole payload
                authors: [{ id: "", login, name: "Emanuele Di Pietro" }],
              },
            ],
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
        const gh = yield* GitHubCli;
        const detail = yield* gh.getPullRequestDetail({
          cwd: "/repo",
          repository: "acme/app",
          number: 1016,
        });
        assert.equal(detail.commits[1]?.oid, "5a554f9e40043fba3184182c22f7f4bab617fc19");
        assert.equal(
          detail.commits[1]?.messageHeadline,
          "fix(models): ignore inherited display-name tokens",
        );
        assert.deepStrictEqual(
          detail.commits.map((commit) => commit.authors),
          [
            [
              {
                login: "SHLE1",
                name: "SHLE1",
                avatarUrl: "https://avatars.githubusercontent.com/SHLE1?size=64",
                url: "https://github.com/SHLE1",
              },
              { login: null, name: "Local co-author", avatarUrl: null, url: null },
            ],
            [{ login: null, name: "Emanuele Di Pietro", avatarUrl: null, url: null }],
          ],
        );
      }),
    );
  }

  it.effect("does not synthesize profile links for GitHub App commit authors", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 17,
          title: "App-authored commit",
          url: "https://github.com/acme/app/pull/17",
          headRefName: "app-commit",
          baseRefName: "main",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
          commits: [
            {
              oid: "app123",
              committedDate: "2026-07-01T00:00:00Z",
              authors: [{ login: "app/dependabot", name: "dependabot[bot]" }],
            },
          ],
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const gh = yield* GitHubCli;
      const detail = yield* gh.getPullRequestDetail({
        cwd: "/repo",
        repository: "acme/app",
        number: 17,
      });
      assert.deepStrictEqual(detail.commits[0]?.authors, [
        {
          login: "app/dependabot",
          name: "dependabot[bot]",
          avatarUrl: null,
          url: null,
        },
      ]);
    }),
  );

  for (const invalidAuthor of [{ login: 123 }, { login: null, name: false }]) {
    it.effect(`rejects malformed commit author ${JSON.stringify(invalidAuthor)}`, () =>
      Effect.gen(function* () {
        mockedRunProcess.mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 9,
            title: "Malformed author",
            url: "https://github.com/acme/app/pull/9",
            headRefName: "malformed-author",
            baseRefName: "main",
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-02T00:00:00Z",
            commits: [
              {
                oid: "abc123",
                committedDate: "2026-07-01T00:00:00Z",
                authors: [invalidAuthor],
              },
            ],
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
        const gh = yield* GitHubCli;
        const error = yield* gh
          .getPullRequestDetail({
            cwd: "/repo",
            repository: "acme/app",
            number: 9,
          })
          .pipe(Effect.flip);
        expect(error.detail).toContain("invalid pull request detail JSON");
      }),
    );
  }

  it.effect("normalizes actors without losing comments or treating teams as users", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 9,
          title: "Nullable actors",
          url: "https://github.com/acme/app/pull/9",
          headRefName: "nullable-actors",
          baseRefName: "main",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
          author: { login: "local-author", name: "Local author" },
          reviewRequests: [
            { login: " reviewer ", slug: "unused" },
            { __typename: "Team", slug: " platform " },
            { __typename: "Team", slug: "security" },
            { __typename: "Team", slug: "infra" },
          ],
          comments: [
            {
              id: "comment",
              body: "Keep this comment",
              createdAt: "2026-07-01T01:00:00Z",
              author: { login: "former-user", name: "Former user" },
            },
          ],
          reviews: [
            {
              id: "review",
              body: "Keep this review",
              submittedAt: "2026-07-01T02:00:00Z",
              state: "APPROVED",
              author: { login: "reviewer" },
            },
          ],
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const gh = yield* GitHubCli;
      const detail = yield* gh.getPullRequestDetail({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
      });

      assert.equal(detail.author?.login, "local-author");
      assert.deepStrictEqual(detail.reviewers, [
        {
          login: "reviewer",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/reviewer?size=64",
          url: null,
        },
        { login: "platform", name: null, avatarUrl: null, url: null },
        { login: "security", name: null, avatarUrl: null, url: null },
        { login: "infra", name: null, avatarUrl: null, url: null },
      ]);
      assert.deepStrictEqual(
        detail.comments.map(({ id, body, author, reviewState }) => ({
          id,
          body,
          author,
          reviewState,
        })),
        [
          {
            id: "comment",
            body: "Keep this comment",
            author: {
              login: "former-user",
              name: "Former user",
              avatarUrl: "https://avatars.githubusercontent.com/former-user?size=64",
              url: null,
            },
            reviewState: null,
          },
          {
            id: "review",
            body: "Keep this review",
            author: {
              login: "reviewer",
              name: null,
              avatarUrl: "https://avatars.githubusercontent.com/reviewer?size=64",
              url: null,
            },
            reviewState: "APPROVED",
          },
        ],
      );
    }),
  );

  it.effect("loads bounded diffs and runs merge actions", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: true,
          stderrTruncated: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            status: "merged",
            details: { message: "Pull request was merged." },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      const diff = yield* gh.getPullRequestDiff({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
      });
      const action = yield* gh.runPullRequestAction({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
        action: "merge",
        mergeMethod: "squash",
      });

      assert.equal(diff.truncated, true);
      assert.deepStrictEqual(action, { mergeOutcome: "merged" });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining(["pr", "diff", "9", "--repo", "github.com/acme/app", "--patch"]),
      );
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "PUT",
        "repos/acme/app/pulls/9/merge-async",
        "--input",
        "-",
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          allowNonZeroExit: true,
          stdin: JSON.stringify({ merge_method: "squash", merge_action: "default" }),
        }),
      );
    }),
  );

  it.effect("loads full stack metadata in bottom-to-top order", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                stackEntry: { position: 2 },
                stack: {
                  number: 17,
                  size: 2,
                  baseRefName: "main",
                  entries: {
                    totalCount: 2,
                    nodes: [
                      {
                        position: 2,
                        pullRequest: {
                          number: 12,
                          title: "UI layer",
                          url: "https://github.com/acme/app/pull/12",
                          headRefName: "feature/ui",
                          baseRefName: "feature/api",
                          state: "OPEN",
                          isDraft: false,
                          mergedAt: null,
                          mergeable: "UNKNOWN",
                          mergeStateStatus: "UNKNOWN",
                        },
                      },
                      {
                        position: 1,
                        pullRequest: {
                          number: 11,
                          title: "API layer",
                          url: "https://github.com/acme/app/pull/11",
                          headRefName: "feature/api",
                          baseRefName: "main",
                          state: "MERGED",
                          isDraft: false,
                          mergedAt: "2026-08-10T10:00:00Z",
                          mergeable: "MERGEABLE",
                          mergeStateStatus: "CLEAN",
                        },
                      },
                    ],
                  },
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

      const gh = yield* GitHubCli;
      const result = yield* gh.getPullRequestStack({
        cwd: "/repo",
        repository: "acme/app",
        number: 12,
      });

      expect(result).toMatchObject({
        number: 17,
        size: 2,
        position: 2,
        baseBranch: "main",
      });
      expect(result?.entries.map((entry) => [entry.position, entry.number, entry.state])).toEqual([
        [1, 11, "merged"],
        [2, 12, "open"],
      ]);
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([
          "api",
          "graphql",
          "--hostname",
          "github.com",
          "-F",
          "number=12",
          "-F",
          "first=100",
        ]),
      );
    }),
  );

  it.effect("paginates stacks larger than the GraphQL page size", () =>
    Effect.gen(function* () {
      const makeEntry = (position: number) => ({
        position,
        pullRequest: {
          number: 1_000 + position,
          title: `Stack entry ${position}`,
          url: `https://github.com/acme/app/pull/${1_000 + position}`,
          headRefName: `feature/stack-${position}`,
          baseRefName: position === 1 ? "main" : `feature/stack-${position - 1}`,
          state: "OPEN",
          isDraft: false,
          mergedAt: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        },
      });
      const makeResponse = (
        nodes: ReadonlyArray<ReturnType<typeof makeEntry>>,
        pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null },
      ) =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                stackEntry: { position: 101 },
                stack: {
                  number: 29,
                  size: 101,
                  baseRefName: "main",
                  entries: { totalCount: 101, nodes, pageInfo },
                },
              },
            },
          },
        });

      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: makeResponse(
            Array.from({ length: 100 }, (_, index) => makeEntry(index + 1)),
            { hasNextPage: true, endCursor: "cursor-100" },
          ),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: makeResponse([makeEntry(101)], { hasNextPage: false, endCursor: null }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      const result = yield* gh.getPullRequestStack({
        cwd: "/repo",
        repository: "acme/app",
        number: 1_101,
      });

      expect(result?.entries).toHaveLength(101);
      expect(result?.entries.at(-1)).toMatchObject({ position: 101, number: 1_101 });
      expect(mockedRunProcess).toHaveBeenCalledTimes(2);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining(["-F", "after=cursor-100"]),
      );
    }),
  );

  it.effect("falls back to the legacy merge path when async merge is unavailable", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)",
          code: 1,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      const result = yield* gh.runPullRequestAction({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
        action: "merge",
        mergeMethod: "rebase",
      });

      expect(result).toEqual({ mergeOutcome: "merged" });
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "pr",
        "merge",
        "9",
        "--repo",
        "github.com/acme/app",
        "--rebase",
      ]);
    }),
  );

  it.effect("polls a pending stack merge until GitHub enqueues it", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            status: "pending",
            details: { message: "Merge request enqueued.", uuid: "merge-request-1" },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            status: "enqueued",
            details: { message: "Pull request was added to the merge queue." },
          }),
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      const mergeFiber = yield* gh
        .runPullRequestAction({
          cwd: "/repo",
          repository: "acme/app",
          number: 12,
          action: "merge",
          mergeMethod: "merge",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(mergeFiber);

      expect(result).toEqual({ mergeOutcome: "enqueued" });
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "api",
        "--hostname",
        "github.com",
        "repos/acme/app/pulls/12/merge-async/merge-request-1",
      ]);
    }),
  );

  it.effect("falls back to a local merge-base git diff when GitHub rejects oversized diffs", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockRejectedValueOnce(
          new Error(
            "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).",
          ),
        )
        .mockResolvedValueOnce({
          stdout: "main 1111111111111111 2222222222222222\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      const gh = yield* GitHubCli;
      const diff = yield* gh.getPullRequestDiff({
        cwd: "/repo",
        repository: "acme/app",
        number: 357,
      });
      assert.equal(diff.patch, "diff --git a/a.ts b/a.ts\n");
      assert.equal(diff.truncated, false);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "api",
        "--hostname",
        "github.com",
        "repos/acme/app/pulls/357",
        "--jq",
        '[.base.ref, .base.sha, .head.sha] | join(" ")',
      ]);
      expect(mockedRunProcess.mock.calls[2]?.[0]).toBe("git");
      expect(mockedRunProcess.mock.calls[2]?.[1]).toEqual([
        "diff",
        "--no-color",
        "1111111111111111...2222222222222222",
      ]);
    }),
  );

  it.effect("fetches missing fallback-diff commits through the matching configured remote", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockRejectedValueOnce(new Error("HTTP 406: diff exceeded the maximum number of files"))
        .mockResolvedValueOnce({
          stdout: "main 1111111111111111 2222222222222222\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockRejectedValueOnce(new Error("fatal: bad object 2222222222222222"))
        .mockResolvedValueOnce({
          stdout:
            "origin\thttps://oauth2:super-secret@github.com/acme/app.git (fetch)\n" +
            "origin\thttps://oauth2:super-secret@github.com/acme/app.git (push)\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "false\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
        .mockResolvedValueOnce({
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      const gh = yield* GitHubCli;
      const diff = yield* gh.getPullRequestDiff({
        cwd: "/repo",
        repository: "acme/app",
        number: 357,
      });
      assert.equal(diff.patch, "diff --git a/a.ts b/a.ts\n");
      // Git resolves the remote name itself — a token-bearing URL never enters argv or process-runner errors
      expect(mockedRunProcess.mock.calls[5]?.[1]).toEqual([
        "fetch",
        "--quiet",
        "--",
        "origin",
        "refs/pull/357/head",
        "main",
      ]);
      expect(mockedRunProcess.mock.calls[5]?.[1]?.join(" ")).not.toContain("super-secret");
    }),
  );

  it.effect("keeps a leading-dash remote name out of fallback fetch argv", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockRejectedValueOnce(new Error("HTTP 406: diff exceeded the maximum number of files"))
        .mockResolvedValueOnce({
          stdout: "main 1111111111111111 2222222222222222\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockRejectedValueOnce(new Error("fatal: bad object 2222222222222222"))
        .mockResolvedValueOnce({
          stdout:
            "--upload-pack=/tmp/attacker\tgit@github.com:acme/app.git (fetch)\n" +
            "--upload-pack=/tmp/attacker\tgit@github.com:acme/app.git (push)\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "false\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
        .mockResolvedValueOnce({
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      yield* gh.getPullRequestDiff({ cwd: "/repo", repository: "acme/app", number: 357 });

      const fetchArgs = mockedRunProcess.mock.calls[5]?.[1];
      expect(fetchArgs).toEqual([
        "fetch",
        "--quiet",
        "--",
        "https://github.com/acme/app.git",
        "refs/pull/357/head",
        "main",
      ]);
      expect(fetchArgs).not.toContain("--upload-pack=/tmp/attacker");
    }),
  );

  it.effect("deepens shallow fallback-diff history in bounded increments", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockRejectedValueOnce(new Error("HTTP 406: diff exceeded the maximum number of files"))
        .mockResolvedValueOnce({
          stdout: "main 1111111111111111 2222222222222222\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockRejectedValueOnce(new Error("fatal: no merge base"))
        .mockResolvedValueOnce({
          stdout: "origin\tgit@github.com:acme/app.git (fetch)\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({
          stdout: "true\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
        .mockRejectedValueOnce(new Error("fatal: no merge base"))
        .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
        .mockResolvedValueOnce({
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });

      const gh = yield* GitHubCli;
      const diff = yield* gh.getPullRequestDiff({
        cwd: "/repo",
        repository: "acme/app",
        number: 357,
      });

      assert.equal(diff.patch, "diff --git a/a.ts b/a.ts\n");
      expect(mockedRunProcess.mock.calls[4]?.[1]).toEqual(["rev-parse", "--is-shallow-repository"]);
      expect(mockedRunProcess.mock.calls[5]?.[1]).toEqual([
        "fetch",
        "--quiet",
        "--deepen=64",
        "--",
        "origin",
        "refs/pull/357/head",
        "main",
      ]);
      expect(mockedRunProcess.mock.calls[7]?.[1]).toEqual([
        "fetch",
        "--quiet",
        "--deepen=256",
        "--",
        "origin",
        "refs/pull/357/head",
        "main",
      ]);
      expect(mockedRunProcess.mock.calls.flatMap((call) => call[1])).not.toContain("--unshallow");
    }),
  );

  it.effect("stops shallow fallback-diff recovery after the bounded deepen budget", () =>
    Effect.gen(function* () {
      const success = { stdout: "", stderr: "", code: 0, signal: null, timedOut: false } as const;
      mockedRunProcess
        .mockRejectedValueOnce(new Error("HTTP 406: diff exceeded the maximum number of files"))
        .mockResolvedValueOnce({ ...success, stdout: "main base-sha head-sha\n" })
        .mockRejectedValueOnce(new Error("fatal: no merge base"))
        .mockResolvedValueOnce({
          ...success,
          stdout: "origin\thttps://github.com/acme/app.git (fetch)\n",
        })
        .mockResolvedValueOnce({ ...success, stdout: "true\n" })
        .mockResolvedValueOnce(success)
        .mockRejectedValueOnce(new Error("fatal: no merge base"))
        .mockResolvedValueOnce(success)
        .mockRejectedValueOnce(new Error("fatal: no merge base"))
        .mockResolvedValueOnce(success)
        .mockRejectedValueOnce(new Error("fatal: no merge base"));

      const gh = yield* GitHubCli;
      const error = yield* gh
        .getPullRequestDiff({ cwd: "/repo", repository: "acme/app", number: 357 })
        .pipe(Effect.flip);

      assert.equal(error.detail.includes("no merge base"), true);
      expect(
        mockedRunProcess.mock.calls
          .map((call) => call[1].find((argument) => argument.startsWith("--deepen=")))
          .filter((argument): argument is string => argument !== undefined),
      ).toEqual(["--deepen=64", "--deepen=256", "--deepen=1024"]);
      expect(mockedRunProcess.mock.calls.flatMap((call) => call[1])).not.toContain("--unshallow");
    }),
  );

  it.effect("posts pull request comments through gh pr comment", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const gh = yield* GitHubCli;
      yield* gh.commentOnPullRequest({
        cwd: "/repo",
        repository: "acme/app",
        number: 9,
        body: "Looks good!\n\nShipping it.",
      });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "pr",
        "comment",
        "9",
        "--repo",
        "github.com/acme/app",
        "--body-file",
        "-",
      ]);
      // the body must never appear in argv — it travels over stdin
      expect(mockedRunProcess.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ stdin: "Looks good!\n\nShipping it." }),
      );
    }),
  );

  it.effect("classifies missing and unauthenticated gh failures structurally", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockRejectedValueOnce(new Error("Command not found: gh"))
        .mockRejectedValueOnce(new Error("not logged in; run gh auth login"))
        .mockRejectedValueOnce(new Error("gh: Bad credentials (HTTP 401)"));
      const gh = yield* GitHubCli;
      const missing = yield* gh.getViewerLogin({ cwd: "/repo" }).pipe(Effect.flip);
      const unauthenticated = yield* gh.getViewerLogin({ cwd: "/repo" }).pipe(Effect.flip);
      const badCredentials = yield* gh.getViewerLogin({ cwd: "/repo" }).pipe(Effect.flip);
      assert.equal(missing.reason, "not-installed");
      assert.equal(unauthenticated.reason, "not-authenticated");
      assert.equal(badCredentials.reason, "not-authenticated");
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "api",
        "user",
        "--hostname",
        "github.com",
        "--jq",
        ".login",
      ]);
    }),
  );

  it.effect("rejects invalid repository identities before spawning gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli;
      const error = yield* gh
        .getPullRequestDiff({ cwd: "/repo", repository: "owner/repo/extra", number: 1 })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Invalid GitHub repository identity"), true);
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }),
  );
});

// Own layer: the pause is wall-clock state that would leak into the shared layer's later tests.
it.effect("pauses background lookups after a rate limit while mutations keep running", () =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli;
    mockedRunProcess.mockRejectedValueOnce(
      new Error("gh pr view failed (code=1, signal=null). gh: API rate limit exceeded (HTTP 403)"),
    );
    const limited = yield* gh.getPullRequest({ cwd: "/repo", reference: "#1" }).pipe(Effect.flip);
    assert.equal(limited.reason, "rate-limited");
    expect(mockedRunProcess).toHaveBeenCalledTimes(1);

    const lookup = yield* gh
      .listPullRequests({ cwd: "/repo", headSelector: "feature/paused" })
      .pipe(Effect.flip);
    const queued = yield* gh.withRead(gh.getViewerLogin({ cwd: "/repo" })).pipe(Effect.flip);
    assert.equal(lookup.reason, "rate-limited");
    assert.equal(queued.reason, "rate-limited");
    expect(mockedRunProcess).toHaveBeenCalledTimes(1);

    mockedRunProcess.mockResolvedValue(processResult("[]"));
    yield* gh.listOpenPullRequests({ cwd: "/repo", headSelector: "feature/paused" });
    yield* gh.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/paused",
      title: "Paused",
      bodyFile: "/tmp/body.md",
    });
    expect(mockedRunProcess).toHaveBeenCalledTimes(3);
  }).pipe(Effect.provide(GitHubCliLive)),
);

// Exercise the real cache and read gate together, with only the gh process stubbed.
it.effect("serves cached background PR lookups while paused and gates only misses", () =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli;
    const output = JSON.stringify({
      number: 77,
      title: "Cached lookup",
      url: "https://github.com/acme/app/pull/77",
      baseRefName: "main",
      headRefName: "feature",
      state: "OPEN",
    });
    mockedRunProcess.mockResolvedValue(processResult(output));
    const lookup = gh.getPullRequest({ cwd: "/paused-cache", reference: "#77", background: true });
    const cached = yield* lookup;
    mockedRunProcess.mockRejectedValueOnce(new Error("gh: API rate limit exceeded (HTTP 403)"));
    yield* gh.execute({ cwd: "/paused-cache", args: ["api", "user"] }).pipe(Effect.flip);
    expect(yield* lookup).toEqual(cached);
    expect(mockedRunProcess).toHaveBeenCalledTimes(2);
    const miss = yield* gh
      .getPullRequest({ cwd: "/paused-cache", reference: "#78", background: true })
      .pipe(Effect.result);
    expect(miss._tag).toBe("Failure");
    if (miss._tag === "Failure") expect(miss.failure.reason).toBe("rate-limited");
    expect(mockedRunProcess).toHaveBeenCalledTimes(2);
    // Mutation-required lookups retain their existing ungated path.
    yield* gh.getPullRequest({ cwd: "/paused-cache", reference: "#78" });
    expect(mockedRunProcess).toHaveBeenCalledTimes(3);
  }).pipe(Effect.provide(GitHubCliLive)),
);

it.effect("keeps mutation lookups independent of background gate admission", () =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli;
    const occupied = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let started = 0;
    const holders = yield* Effect.forEach(Array.from({ length: GITHUB_READ_SLOTS }), () =>
      gh
        .withRead(
          Effect.gen(function* () {
            started += 1;
            if (started === GITHUB_READ_SLOTS) yield* Deferred.succeed(occupied, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild),
    );
    yield* Deferred.await(occupied);
    mockedRunProcess.mockImplementation(async (_command, args) => {
      if (args[0] === "api") throw new Error("gh: API rate limit exceeded (HTTP 403)");
      return processResult(
        JSON.stringify({
          number: 78,
          title: "Interactive lookup",
          url: "https://github.com/acme/app/pull/78",
          baseRefName: "main",
          headRefName: "feature",
          state: "OPEN",
        }),
      );
    });
    const input = { cwd: "/queued-lookup", reference: "#78" };
    const background = yield* gh
      .getPullRequest({ ...input, background: true })
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    const interactive = yield* gh.getPullRequest(input).pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* gh.execute({ cwd: input.cwd, args: ["api", "user"] }).pipe(Effect.flip);
    yield* Deferred.succeed(release, undefined);
    yield* Effect.forEach(holders, Fiber.join);
    const direct = yield* Fiber.join(interactive);
    const polled = yield* Fiber.join(background);
    expect(direct._tag).toBe("Success");
    if (direct._tag === "Success") expect(direct.success.number).toBe(78);
    expect(polled._tag).toBe("Failure");
    if (polled._tag === "Failure") expect(polled.failure.reason).toBe("rate-limited");
    // The result is shared across modes even though gate admission was not.
    expect((yield* gh.getPullRequest({ ...input, background: true })).number).toBe(78);
    expect(mockedRunProcess).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(GitHubCliLive)),
);
