import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitLabCli } from "../Services/GitLabCli.ts";
import { GitLabCliLive } from "./GitLabCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitLabCliLive);

const HOST = "gitlab.dotblocks.fr";
const REFERENCE = `${HOST}/dotblocks/platform/app`;
const PROJECT_API = "projects/dotblocks%2Fplatform%2Fapp";
const PROJECT_URL = `https://${HOST}/dotblocks/platform/app`;

function processResult(stdout: string, overrides: Record<string, unknown> = {}) {
  return { stdout, stderr: "", code: 0, signal: null, timedOut: false, ...overrides };
}

// Shaped after a real `glab mr view -F json` payload on gitlab.dotblocks.fr.
const REST_MERGE_REQUEST = {
  iid: 7,
  title: "Add GitLab support",
  web_url: `${PROJECT_URL}/-/merge_requests/7`,
  state: "opened",
  draft: false,
  merged_at: null,
  has_conflicts: false,
  detailed_merge_status: "mergeable",
  changes_count: "48",
  source_branch: "feat/gitlab",
  target_branch: "main",
  source_project_id: 44,
  target_project_id: 44,
  updated_at: "2026-09-01T10:00:00.000Z",
  merge_when_pipeline_succeeds: false,
  head_pipeline: { id: 1164, status: "success" },
};

// Shaped after a real GraphQL merge-request node on a self-hosted instance, where `avatarUrl`
// and `detailsPath` are host-relative.
const GRAPHQL_LIST_NODE = {
  iid: "7",
  title: "Add GitLab support",
  webUrl: `${PROJECT_URL}/-/merge_requests/7`,
  author: {
    username: "nouchetm",
    name: "Marius Nouchet",
    avatarUrl: "/uploads/-/system/user/avatar/24/avatar.png",
    webUrl: `https://${HOST}/nouchetm`,
  },
  sourceBranch: "feat/gitlab",
  targetBranch: "main",
  state: "opened",
  draft: false,
  conflicts: false,
  detailedMergeStatus: "MERGEABLE",
  approved: true,
  approvalsRequired: 1,
  diffStatsSummary: { additions: 2984, deletions: 49, fileCount: 48 },
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
  mergedAt: null,
  reviewers: { nodes: [{ username: "reviewer-1" }] },
  labels: { nodes: [{ title: "backend", color: "#428BCA" }] },
};

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitLabCliLive", (it) => {
  it.effect("reads the viewer login through the selected host", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(JSON.stringify({ username: "nouchetm" })),
      );

      const login = yield* (yield* GitLabCli).getViewerLogin({ cwd: "/repo", host: HOST });

      assert.equal(login, "nouchetm");
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "glab",
        ["api", "--hostname", HOST, "user"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("parses configured hosts from auth status across both streams", () =>
    Effect.gen(function* () {
      // `glab auth status --all` prints hosts to stderr and exits 1 when any host fails auth.
      mockedRunProcess.mockResolvedValueOnce(
        processResult("", {
          code: 1,
          stderr: [
            "gitlab.com",
            "  x gitlab.com: API call failed: 401 Unauthorized",
            "  ! No token found (checked config file, keyring, and environment variables).",
            "gitlab.dotblocks.fr",
            "  ✓ Logged in to gitlab.dotblocks.fr as nouchetm",
            "  X could not authenticate to one or more of the configured GitLab instances.",
          ].join("\n"),
        }),
      );

      const hosts = yield* (yield* GitLabCli).listConfiguredHosts({ cwd: "/home/user" });

      assert.deepStrictEqual([...hosts].toSorted(), ["gitlab.com", "gitlab.dotblocks.fr"]);
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(["auth", "status", "--all"]);
    }),
  );

  it.effect("reports no configured hosts when glab fails for a non-install reason", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(new Error("config file is corrupt"));

      const hosts = yield* (yield* GitLabCli).listConfiguredHosts({ cwd: "/home/user" });

      assert.deepStrictEqual([...hosts], []);
    }),
  );

  it.effect("propagates a missing glab binary from auth status", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(new Error("Command not found: glab"));

      const error = yield* (yield* GitLabCli)
        .listConfiguredHosts({ cwd: "/home/user" })
        .pipe(Effect.flip);

      assert.equal(error.reason, "not-installed");
      assert.equal(error.host, "gitlab");
    }),
  );

  it.effect("lists merge requests through GraphQL and absolutizes self-hosted URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            data: { project: { mergeRequests: { nodes: [GRAPHQL_LIST_NODE, { iid: "bad" }] } } },
          }),
        ),
      );

      const batch = yield* (yield* GitLabCli).listRepositoryPullRequests({
        cwd: "/repo",
        repository: REFERENCE,
        state: "open",
        involvement: "reviewing",
        viewer: "nouchetm",
        limit: 20,
      });

      // The malformed node is dropped but still counted, so truncation stays accurate.
      assert.equal(batch.rawCount, 2);
      assert.equal(batch.entries.length, 1);
      const entry = batch.entries[0]!;
      assert.equal(entry.number, 7);
      assert.equal(entry.headBranch, "feat/gitlab");
      assert.equal(entry.baseBranch, "main");
      assert.equal(entry.state, "open");
      assert.equal(entry.mergeability, "mergeable");
      assert.equal(entry.reviewDecision, "APPROVED");
      assert.deepStrictEqual(entry.reviewRequestLogins, ["reviewer-1"]);
      assert.deepStrictEqual(entry.labels, [{ name: "backend", color: "#428BCA" }]);
      assert.equal(entry.stack, null);
      assert.equal(
        entry.author?.avatarUrl,
        `https://${HOST}/uploads/-/system/user/avatar/24/avatar.png`,
      );

      const args = mockedRunProcess.mock.calls[0]?.[1] ?? [];
      expect(args.slice(0, 4)).toEqual(["api", "--hostname", HOST, "graphql"]);
      expect(args).toEqual(
        expect.arrayContaining([
          "-f",
          "fullPath=dotblocks/platform/app",
          "-f",
          "state=opened",
          "-f",
          "first=20",
          "-f",
          "viewer=nouchetm",
        ]),
      );
      expect(args.some((arg) => arg.includes("reviewerUsername: $viewer"))).toBe(true);
    }),
  );

  it.effect("omits the viewer variable when involvement is all", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(JSON.stringify({ data: { project: { mergeRequests: { nodes: [] } } } })),
      );

      yield* (yield* GitLabCli).listRepositoryPullRequests({
        cwd: "/repo",
        repository: REFERENCE,
        state: "merged",
        involvement: "all",
        viewer: "nouchetm",
      });

      const args = mockedRunProcess.mock.calls[0]?.[1] ?? [];
      expect(args).toEqual(expect.arrayContaining(["-f", "state=merged", "-f", "first=51"]));
      expect(args.some((arg) => arg.startsWith("viewer="))).toBe(false);
      expect(args.some((arg) => arg.includes("authorUsername"))).toBe(false);
    }),
  );

  it.effect("fails with not-found when the merge request does not exist", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(JSON.stringify({ data: { project: { mergeRequest: null } } })),
      );

      const error = yield* (yield* GitLabCli)
        .getPullRequestListItem({ cwd: "/repo", repository: REFERENCE, number: 7 })
        .pipe(Effect.flip);

      assert.equal(error.reason, "not-found");
      assert.equal(error.host, "gitlab");
    }),
  );

  it.effect("fails when GraphQL answers with errors", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(JSON.stringify({ errors: [{ message: "insufficient scope" }] })),
      );

      const error = yield* (yield* GitLabCli)
        .getPullRequestListItem({ cwd: "/repo", repository: REFERENCE, number: 7 })
        .pipe(Effect.flip);

      assert.equal(error.detail, "insufficient scope");
    }),
  );

  it.effect("builds detail from one GraphQL call and keeps job/note/commit shapes", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  ...GRAPHQL_LIST_NODE,
                  description: "Adds glab support.",
                  allowCollaboration: true,
                  closedAt: null,
                  headPipeline: {
                    status: "FAILED",
                    jobs: {
                      nodes: [
                        {
                          name: "lint",
                          status: "FAILED",
                          allowFailure: true,
                          startedAt: "2026-09-01T09:10:00Z",
                          finishedAt: "2026-09-01T09:12:00Z",
                          detailedStatus: {
                            label: "failed (allowed to fail)",
                            detailsPath: "/dotblocks/platform/app/-/jobs/1",
                          },
                        },
                        { name: "test", status: "RUNNING", allowFailure: false },
                      ],
                    },
                  },
                  notes: {
                    nodes: [
                      {
                        id: "gid://gitlab/Note/3255",
                        body: "approved this merge request",
                        system: true,
                        createdAt: "2026-09-01T09:20:00Z",
                        url: `${PROJECT_URL}/-/merge_requests/7#note_3255`,
                        author: { username: "reviewer-1" },
                        position: null,
                      },
                      {
                        id: "gid://gitlab/Note/3256",
                        body: "Please rename this.",
                        system: false,
                        createdAt: "2026-09-01T09:21:00Z",
                        url: `${PROJECT_URL}/-/merge_requests/7#note_3256`,
                        author: { username: "reviewer-1" },
                        position: { filePath: "src/index.ts" },
                      },
                    ],
                  },
                  commits: {
                    nodes: [
                      {
                        sha: "bd73862879f6f0237f624640960cae84736fa7b7",
                        title: "Add glab layer",
                        message: "Add glab layer\n\nWith REST and GraphQL paths.",
                        committedDate: "2026-09-01T09:00:00Z",
                        authorName: "Marius Nouchet",
                        author: null,
                      },
                    ],
                  },
                },
              },
            },
          }),
        ),
      );

      const detail = yield* (yield* GitLabCli).getPullRequestDetail({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
      });

      assert.equal(detail.body, "Adds glab support.");
      assert.equal(detail.changedFiles, 48);
      assert.equal(detail.maintainerCanModify, true);
      assert.equal(detail.mergeStateStatus, "MERGEABLE");
      assert.deepStrictEqual(detail.checks, [
        {
          name: "lint",
          // `allow_failure` failures do not gate the pipeline, so they are neutral, not failures.
          status: "neutral",
          description: "failed (allowed to fail)",
          url: `https://${HOST}/dotblocks/platform/app/-/jobs/1`,
          startedAt: "2026-09-01T09:10:00Z",
          completedAt: "2026-09-01T09:12:00Z",
        },
        {
          name: "test",
          status: "pending",
          description: null,
          url: null,
          startedAt: null,
          completedAt: null,
        },
      ]);
      // System notes are activity-feed entries, never comments.
      assert.equal(detail.comments.length, 1);
      assert.equal(detail.comments[0]?.kind, "review-comment");
      assert.equal(detail.comments[0]?.path, "src/index.ts");
      assert.deepStrictEqual(detail.commits, [
        {
          oid: "bd73862879f6f0237f624640960cae84736fa7b7",
          messageHeadline: "Add glab layer",
          messageBody: "With REST and GraphQL paths.",
          committedDate: "2026-09-01T09:00:00Z",
          authors: [
            { login: "Marius Nouchet", name: "Marius Nouchet", avatarUrl: null, url: null },
          ],
        },
      ]);
    }),
  );

  it.effect("reports no stack because GitLab has no stacked merge requests", () =>
    Effect.gen(function* () {
      const stack = yield* (yield* GitLabCli).getPullRequestStack({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
      });

      assert.equal(stack, null);
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }),
  );

  it.effect("derives merge capabilities from the project's merge method", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            path_with_namespace: "dotblocks/platform/app",
            ssh_url_to_repo: `git@${HOST}:dotblocks/platform/app.git`,
            http_url_to_repo: `${PROJECT_URL}.git`,
            merge_method: "ff",
            squash_option: "default_off",
            remove_source_branch_after_merge: true,
          }),
        ),
      );

      const capabilities = yield* (yield* GitLabCli).getRepositoryMergeCapabilities({
        cwd: "/repo",
        repository: REFERENCE,
      });

      // Fast-forward-only projects cannot take a merge commit but can rebase.
      assert.deepStrictEqual(capabilities, {
        merge: false,
        squash: true,
        rebase: true,
        deleteBranchOnMerge: true,
      });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(["api", "--hostname", HOST, PROJECT_API]);
    }),
  );

  it.effect("reads a raw merge-request diff and reports truncation", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult("diff --git a/a b/a\n", { stdoutTruncated: true }),
      );

      const diff = yield* (yield* GitLabCli).getPullRequestDiff({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
      });

      assert.deepStrictEqual(diff, { patch: "diff --git a/a b/a\n", truncated: true });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "mr",
        "diff",
        "7",
        "-R",
        PROJECT_URL,
        "--raw",
      ]);
    }),
  );

  it.effect("merges immediately when no pipeline is in flight", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)))
        .mockResolvedValueOnce(
          processResult(
            JSON.stringify({
              ...REST_MERGE_REQUEST,
              state: "merged",
              merged_at: "2026-09-01T11:00:00Z",
            }),
          ),
        );

      const result = yield* (yield* GitLabCli).runPullRequestAction({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      assert.deepStrictEqual(result, { mergeOutcome: "merged" });
      const mergeCall = mockedRunProcess.mock.calls[1];
      expect(mergeCall?.[1]).toEqual([
        "api",
        "--hostname",
        HOST,
        "-X",
        "PUT",
        `${PROJECT_API}/merge_requests/7/merge`,
        "--input",
        "-",
      ]);
      expect(mergeCall?.[2]).toEqual(
        expect.objectContaining({ stdin: JSON.stringify({ squash: true }) }),
      );
    }),
  );

  it.effect("enqueues the merge while a pipeline is still running", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce(
          processResult(
            JSON.stringify({ ...REST_MERGE_REQUEST, head_pipeline: { id: 1, status: "running" } }),
          ),
        )
        .mockResolvedValueOnce(
          processResult(
            JSON.stringify({ ...REST_MERGE_REQUEST, merge_when_pipeline_succeeds: true }),
          ),
        );

      const result = yield* (yield* GitLabCli).runPullRequestAction({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
        action: "merge",
        mergeMethod: "merge",
      });

      assert.deepStrictEqual(result, { mergeOutcome: "enqueued" });
      expect(mockedRunProcess.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          stdin: JSON.stringify({ squash: false, merge_when_pipeline_succeeds: true }),
        }),
      );
    }),
  );

  it.effect("fails when GitLab refuses the merge and leaves the MR open", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)))
        .mockResolvedValueOnce(
          processResult(
            JSON.stringify({
              ...REST_MERGE_REQUEST,
              detailed_merge_status: "discussions_not_resolved",
            }),
          ),
        );

      const error = yield* (yield* GitLabCli)
        .runPullRequestAction({
          cwd: "/repo",
          repository: REFERENCE,
          number: 7,
          action: "merge",
          mergeMethod: "merge",
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "GitLab did not merge the merge request: discussions_not_resolved",
      );
    }),
  );

  it.effect("rebases before merging and waits for GitLab to finish", () =>
    Effect.gen(function* () {
      mockedRunProcess
        // PUT .../rebase
        .mockResolvedValueOnce(processResult(JSON.stringify({ rebase_in_progress: true })))
        // first poll: still rebasing
        .mockResolvedValueOnce(
          processResult(JSON.stringify({ ...REST_MERGE_REQUEST, rebase_in_progress: true })),
        )
        // second poll: done
        .mockResolvedValueOnce(
          processResult(JSON.stringify({ ...REST_MERGE_REQUEST, rebase_in_progress: false })),
        )
        // pre-merge read
        .mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)))
        .mockResolvedValueOnce(
          processResult(JSON.stringify({ ...REST_MERGE_REQUEST, state: "merged" })),
        );

      const glab = yield* GitLabCli;
      const fiber = yield* Effect.forkChild(
        glab.runPullRequestAction({
          cwd: "/repo",
          repository: REFERENCE,
          number: 7,
          action: "merge",
          mergeMethod: "rebase",
        }),
      );
      yield* TestClock.adjust("3 seconds");

      assert.deepStrictEqual(yield* Fiber.join(fiber), { mergeOutcome: "merged" });
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "api",
        "--hostname",
        HOST,
        "-X",
        "PUT",
        `${PROJECT_API}/merge_requests/7/rebase`,
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "api",
        "--hostname",
        HOST,
        `${PROJECT_API}/merge_requests/7?include_rebase_in_progress=true`,
      ]);
    }),
  );

  it.effect("runs draft, ready, close, and reopen through the mr porcelain", () =>
    Effect.gen(function* () {
      const glab = yield* GitLabCli;
      for (const action of ["ready", "draft", "close", "reopen"] as const) {
        mockedRunProcess.mockResolvedValueOnce(processResult(""));
        const result = yield* glab.runPullRequestAction({
          cwd: "/repo",
          repository: REFERENCE,
          number: 7,
          action,
        });
        assert.deepStrictEqual(result, { mergeOutcome: null });
      }

      expect(mockedRunProcess.mock.calls.map((call) => call[1])).toEqual([
        ["mr", "update", "7", "-R", PROJECT_URL, "--ready"],
        ["mr", "update", "7", "-R", PROJECT_URL, "--draft"],
        ["mr", "close", "7", "-R", PROJECT_URL],
        ["mr", "reopen", "7", "-R", PROJECT_URL],
      ]);
    }),
  );

  it.effect("posts a comment body over stdin, never argv", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult("{}"));

      yield* (yield* GitLabCli).commentOnPullRequest({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
        body: "secret review note",
      });

      const [command, args, options] = mockedRunProcess.mock.calls[0] ?? [];
      expect(command).toBe("glab");
      expect(args).toEqual([
        "api",
        "--hostname",
        HOST,
        "-X",
        "POST",
        `${PROJECT_API}/merge_requests/7/notes`,
        "--input",
        "-",
      ]);
      expect(args?.some((arg) => arg.includes("secret review note"))).toBe(false);
      expect(options).toEqual(
        expect.objectContaining({ stdin: JSON.stringify({ body: "secret review note" }) }),
      );
    }),
  );

  it.effect("lists open merge requests for a branch and strips owner-style prefixes", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult(JSON.stringify([REST_MERGE_REQUEST])));

      const summaries = yield* (yield* GitLabCli).listOpenPullRequests({
        cwd: "/repo",
        headSelector: "fork-owner:feat/gitlab",
        limit: 5,
      });

      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]?.number, 7);
      assert.equal(summaries[0]?.headRefName, "feat/gitlab");
      assert.equal(summaries[0]?.changedFiles, 48);
      assert.equal(summaries[0]?.isCrossRepository, false);
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "mr",
        "list",
        "-F",
        "json",
        "--source-branch",
        "feat/gitlab",
        "--per-page",
        "5",
      ]);
    }),
  );

  it.effect("resolves a merge request from its web URL", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)));

      const summary = yield* (yield* GitLabCli).getPullRequest({
        cwd: "/repo",
        reference: `${PROJECT_URL}/-/merge_requests/7`,
      });

      assert.equal(summary.number, 7);
      assert.equal(summary.state, "open");
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "mr",
        "view",
        "7",
        "-R",
        PROJECT_URL,
        "-F",
        "json",
      ]);
    }),
  );

  it.effect("resolves a merge request from a bare number using the checkout's remote", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)));

      yield* (yield* GitLabCli).getPullRequest({ cwd: "/repo", reference: "7" });

      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(["mr", "view", "7", "-F", "json"]);
    }),
  );

  it.effect("attaches pipeline jobs as checks", () =>
    Effect.gen(function* () {
      mockedRunProcess
        .mockResolvedValueOnce(processResult(JSON.stringify(REST_MERGE_REQUEST)))
        .mockResolvedValueOnce(
          processResult(
            JSON.stringify([
              {
                name: "lint",
                status: "success",
                allow_failure: false,
                web_url: `${PROJECT_URL}/-/jobs/1`,
              },
              { name: "flaky", status: "failed", allow_failure: true, web_url: null },
            ]),
          ),
        );

      const { summary, checks } = yield* (yield* GitLabCli).getPullRequestWithChecks({
        cwd: "/repo",
        reference: `${PROJECT_URL}/-/merge_requests/7`,
      });

      assert.equal(summary.number, 7);
      assert.deepStrictEqual(checks, [
        { name: "lint", status: "success", url: `${PROJECT_URL}/-/jobs/1` },
        { name: "flaky", status: "neutral", url: null },
      ]);
      expect(mockedRunProcess.mock.calls[1]?.[1]).toEqual([
        "api",
        "--hostname",
        HOST,
        `${PROJECT_API}/pipelines/1164/jobs?per_page=100`,
      ]);
    }),
  );

  it.effect("keeps only unresolved diff discussions as review comments", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify([
            {
              notes: [
                {
                  id: 11,
                  body: "Avoid returning shims directly",
                  system: false,
                  resolvable: true,
                  resolved: false,
                  created_at: "2026-09-01T09:00:00Z",
                  author: { username: "reviewer-1" },
                  position: { new_path: "src/index.ts", old_path: "src/index.ts" },
                },
              ],
            },
            {
              notes: [{ id: 12, body: "Already handled", resolvable: true, resolved: true }],
            },
            { notes: [{ id: 13, body: "plain comment", resolvable: false }] },
          ]),
        ),
      );

      const result = yield* (yield* GitLabCli).getPullRequestReviewComments({
        cwd: "/repo",
        repository: REFERENCE,
        number: 7,
      });

      assert.equal(result.truncated, false);
      assert.deepStrictEqual(result.comments, [
        {
          id: "11",
          author: "reviewer-1",
          body: "Avoid returning shims directly",
          path: "src/index.ts",
          url: `${PROJECT_URL}/-/merge_requests/7#note_11`,
          createdAt: "2026-09-01T09:00:00Z",
        },
      ]);
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "api",
        "--hostname",
        HOST,
        `${PROJECT_API}/merge_requests/7/discussions?per_page=50&page=1`,
      ]);
    }),
  );

  it.effect("reads clone URLs from the project payload", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            path_with_namespace: "dotblocks/platform/app",
            ssh_url_to_repo: `git@${HOST}:dotblocks/platform/app.git`,
            http_url_to_repo: `${PROJECT_URL}.git`,
          }),
        ),
      );

      const urls = yield* (yield* GitLabCli).getRepositoryCloneUrls({
        cwd: "/repo",
        repository: REFERENCE,
      });

      assert.deepStrictEqual(urls, {
        nameWithOwner: "dotblocks/platform/app",
        url: `${PROJECT_URL}.git`,
        sshUrl: `git@${HOST}:dotblocks/platform/app.git`,
      });
    }),
  );

  it.effect("creates a merge request without opening an editor", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult(""));

      yield* (yield* GitLabCli).createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feat/gitlab",
        title: "Add GitLab support",
        bodyFile: "/tmp/body.md",
        draft: true,
      });

      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "mr",
        "create",
        "--source-branch",
        "feat/gitlab",
        "--target-branch",
        "main",
        "--title",
        "Add GitLab support",
        "--description-file",
        "/tmp/body.md",
        "--yes",
        "--no-editor",
        "--draft",
      ]);
      expect(mockedRunProcess.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ stdin: "" }));
    }),
  );

  it.effect("reads the default branch from the project view", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            path_with_namespace: "dotblocks/platform/app",
            ssh_url_to_repo: `git@${HOST}:dotblocks/platform/app.git`,
            http_url_to_repo: `${PROJECT_URL}.git`,
            default_branch: "dev",
          }),
        ),
      );

      const branch = yield* (yield* GitLabCli).getDefaultBranch({ cwd: "/repo" });

      assert.equal(branch, "dev");
      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual(["repo", "view", "-F", "json"]);
    }),
  );

  it.effect("checks out a merge request by URL against its own project", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce(processResult(""));

      yield* (yield* GitLabCli).checkoutPullRequest({
        cwd: "/repo",
        reference: `${PROJECT_URL}/-/merge_requests/7`,
        force: true,
      });

      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "mr",
        "checkout",
        "7",
        "-R",
        PROJECT_URL,
        "--force",
      ]);
    }),
  );

  it.effect("classifies missing binary, auth, and not-found failures", () =>
    Effect.gen(function* () {
      const glab = yield* GitLabCli;
      const read = () => glab.getViewerLogin({ cwd: "/repo", host: HOST }).pipe(Effect.flip);

      mockedRunProcess.mockRejectedValueOnce(new Error("Command not found: glab"));
      const missing = yield* read();
      mockedRunProcess.mockRejectedValueOnce(
        new Error("GET /user: 401 {message: 401 Unauthorized}"),
      );
      const unauthenticated = yield* read();
      mockedRunProcess.mockRejectedValueOnce(new Error("404 Not Found"));
      const notFound = yield* read();
      mockedRunProcess.mockRejectedValueOnce(new Error("connection reset by peer"));
      const other = yield* read();

      assert.deepStrictEqual(
        [missing.reason, unauthenticated.reason, notFound.reason, other.reason],
        ["not-installed", "not-authenticated", "not-found", "other"],
      );
      assert.deepStrictEqual(
        [missing.host, unauthenticated.host, notFound.host, other.host],
        ["gitlab", "gitlab", "gitlab", "gitlab"],
      );
      assert.equal(
        unauthenticated.detail,
        `GitLab CLI is not authenticated. Run \`glab auth login --hostname ${HOST}\` and retry.`,
      );
    }),
  );

  it.effect("rejects an invalid GitLab project identity before spawning glab", () =>
    Effect.gen(function* () {
      const error = yield* (yield* GitLabCli)
        .getPullRequestDiff({ cwd: "/repo", repository: "acme/app", number: 1 })
        .pipe(Effect.flip);

      assert.equal(error.detail, "Invalid GitLab project identity: acme/app");
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }),
  );
});
