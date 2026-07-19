import {
  ProjectId,
  type GitHubAccountSelection,
  type OrchestrationProject,
} from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { GitHubPullRequestDetailData } from "../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh } from "../git/testing/fakeGitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { makePullRequestOperations } from "./pullRequestOperations";

const now = "2026-07-15T00:00:00.000Z";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-detail"),
  kind: "project",
  title: "Detail",
  workspaceRoot: "/tmp/detail",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const detail: GitHubPullRequestDetailData = {
  number: 42,
  title: "Parallel detail",
  body: "",
  url: "https://github.com/acme/widgets/pull/42",
  author: null,
  state: "open",
  isDraft: false,
  mergeable: null,
  mergeability: "unknown",
  mergeStateStatus: null,
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: now,
  updatedAt: now,
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commits: [],
};

describe("makePullRequestOperations", () => {
  it("rejects native merge actions before invoking GitHub", async () => {
    let actionCalls = 0;
    let capabilityCalls = 0;
    const base = createGitHubCliWithFakeGh().service;
    const operations = makePullRequestOperations({
      github: {
        ...base,
        runPullRequestAction: () =>
          Effect.sync(() => {
            actionCalls += 1;
          }),
      },
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: () => Effect.void,
      },
      findProject: () => Effect.succeed(project),
      validateRepository: (repository) => Effect.succeed(repository),
      validateProjectRepository: (_project, repository) => Effect.succeed(repository),
      loadMergeCapabilities: () =>
        Effect.sync(() => {
          capabilityCalls += 1;
          return {
            merge: true,
            squash: true,
            rebase: true,
            deleteBranchOnMerge: false,
          };
        }),
      withGitHubRead: (effect) => effect,
      finalizeMutationCaches: () => Effect.void,
    });

    await expect(
      Effect.runPromise(
        operations.action({
          projectId: project.id,
          repository: "acme/widgets",
          number: 42,
          action: "merge",
          mergeMethod: "squash",
        }),
      ),
    ).rejects.toThrow("Merge this pull request on GitHub");
    expect(actionCalls).toBe(0);
    expect(capabilityCalls).toBe(0);
  });

  it("uses the project's selected account for every GitHub-backed operation", async () => {
    const account: GitHubAccountSelection = { host: "enterprise.example.com", login: "alice" };
    const accountProject = { ...project, githubAccount: account };
    const receivedAccounts: Array<GitHubAccountSelection | undefined> = [];
    const finalizedAccounts: Array<GitHubAccountSelection | undefined> = [];
    const base = createGitHubCliWithFakeGh().service;
    const pins: ProjectPullRequestPinsShape = {
      listByProjectIds: () => Effect.succeed([]),
      setPinned: () => Effect.void,
    };
    const operations = makePullRequestOperations({
      github: {
        ...base,
        getPullRequestDetail: ({ account: received }) => {
          receivedAccounts.push(received);
          return Effect.succeed(detail);
        },
        getPullRequestReviewComments: ({ account: received }) => {
          receivedAccounts.push(received);
          return Effect.succeed({ comments: [], truncated: false });
        },
        getPullRequestDiff: ({ account: received }) => {
          receivedAccounts.push(received);
          return Effect.succeed({ patch: "diff", truncated: false });
        },
        runPullRequestAction: ({ account: received }) => {
          receivedAccounts.push(received);
          return Effect.void;
        },
        commentOnPullRequest: ({ account: received }) => {
          receivedAccounts.push(received);
          return Effect.void;
        },
      },
      pins,
      findProject: () => Effect.succeed(accountProject),
      validateRepository: (repository) => Effect.succeed(repository),
      validateProjectRepository: (_project, repository) => Effect.succeed(repository),
      loadMergeCapabilities: (_cwd, _repository, received) => {
        receivedAccounts.push(received);
        return Effect.succeed({
          merge: true,
          squash: true,
          rebase: true,
          deleteBranchOnMerge: false,
        });
      },
      withGitHubRead: (effect) => effect,
      finalizeMutationCaches: (_repository, _number, _options, received) =>
        Effect.sync(() => {
          finalizedAccounts.push(received);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* operations.detail({
          projectId: accountProject.id,
          repository: "acme/widgets",
          number: 42,
        });
        yield* operations.diff({
          projectId: accountProject.id,
          repository: "acme/widgets",
          number: 42,
        });
        yield* operations.action({
          projectId: accountProject.id,
          repository: "acme/widgets",
          number: 42,
          action: "close",
        });
        yield* operations.comment({
          projectId: accountProject.id,
          repository: "acme/widgets",
          number: 42,
          body: "Looks good",
        });
      }),
    );

    expect(receivedAccounts).toEqual([account, account, account, account, account, account]);
    expect(finalizedAccounts).toEqual([account, account]);
  });

  it("starts detail, merge-capability, and review-comment reads together", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const detailStarted = yield* Deferred.make<void>();
          const capabilitiesStarted = yield* Deferred.make<void>();
          const commentsStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waitForRelease = <A>(started: Deferred.Deferred<void>, value: A) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return value;
            });
          const base = createGitHubCliWithFakeGh().service;
          const pins: ProjectPullRequestPinsShape = {
            listByProjectIds: () => Effect.succeed([]),
            setPinned: () => Effect.void,
          };
          const operations = makePullRequestOperations({
            github: {
              ...base,
              getPullRequestDetail: () => waitForRelease(detailStarted, detail),
              getPullRequestReviewComments: () =>
                waitForRelease(commentsStarted, { comments: [], truncated: false }),
            },
            pins,
            findProject: () => Effect.succeed(project),
            validateRepository: (repository) => Effect.succeed(repository),
            validateProjectRepository: (_project, repository) => Effect.succeed(repository),
            loadMergeCapabilities: () =>
              waitForRelease(capabilitiesStarted, {
                merge: true,
                squash: true,
                rebase: true,
                deleteBranchOnMerge: false,
              }),
            withGitHubRead: (effect) => effect,
            finalizeMutationCaches: () => Effect.void,
          });

          const fiber = yield* operations
            .detail({ projectId: project.id, repository: "acme/widgets", number: 42 })
            .pipe(Effect.forkChild);
          yield* Effect.all([Deferred.await(detailStarted), Deferred.await(capabilitiesStarted)], {
            concurrency: 2,
          });
          yield* Effect.yieldNow;

          expect(yield* Deferred.isDone(commentsStarted)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(fiber)).number).toBe(42);
        }),
      ),
    );
  });
});
