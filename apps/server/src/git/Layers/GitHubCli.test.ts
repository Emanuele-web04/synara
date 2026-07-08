import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli, PULL_REQUEST_SUMMARY_JSON_FIELDS } from "../Services/GitHubCli.ts";
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
          isDraft: true,
          mergeable: "CONFLICTING",
          additions: 38,
          deletions: 36,
          changedFiles: 3,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/codething-mvp",
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
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
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

  it.effect("normalizes check runs and status contexts from the rollup", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Snapshot PR",
          url: "https://github.com/o/r/pull/42",
          baseRefName: "main",
          headRefName: "feature/snapshot",
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
      // Fields gh did not report normalize to safe fallbacks, not fabricated values.
      assert.strictEqual(result.summary.isDraft, false);
      assert.strictEqual(result.summary.mergeability, "unknown");
      assert.strictEqual(result.summary.additions, null);
      assert.strictEqual(result.summary.deletions, null);
      assert.strictEqual(result.summary.changedFiles, null);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["pr", "view", "42", "--json", `${PULL_REQUEST_SUMMARY_JSON_FIELDS},statusCheckRollup`],
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
});
