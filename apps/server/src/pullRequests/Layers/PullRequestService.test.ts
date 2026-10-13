import { ProjectId } from "@synara/contracts";
import type { OrchestrationProject, WorkItemSearchResult } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubCliError } from "../../git/Errors";
import { makeGitHubReadGate } from "../../git/githubReadGate";
import { decodeRepositoryInboxJson } from "../../git/Layers/GitHubCli";
import type { GitHubCliShape, GitHubPullRequestDetailData } from "../../git/Services/GitHubCli";
import {
  createGitHubCliWithFakeGh,
  fakeInboxGraphQlJson,
  fakeInboxPullRequestNode,
} from "../../git/testing/fakeGitHubCli";
import { makeGitHubInboxService } from "../../githubInbox/Layers/GitHubInboxService";
import type { ProjectPullRequestPinsShape } from "../../persistence/Services/ProjectPullRequestPins";
import type { PullRequestServiceShape } from "../Services/PullRequestService";
import { makePullRequestService } from "./PullRequestService";

const now = "2026-07-15T00:00:00.000Z";

function makeProject(id: string, title: string, workspaceRoot: string): OrchestrationProject {
  return {
    id: ProjectId.makeUnsafe(id),
    kind: "project",
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function makeDetail(number: number, repository: string): GitHubPullRequestDetailData {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    url: `https://github.com/${repository}/pull/${number}`,
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
    headBranch: `feature-${number}`,
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
}

const noPins: ProjectPullRequestPinsShape = {
  listByProjectIds: () => Effect.succeed([]),
  setPinned: () => Effect.void,
};

/** Build the pull request service on top of a real inbox, as the server layer does. */
function runServices<A, E>(
  input: {
    projects: OrchestrationProject[];
    repositories: ReadonlyMap<ProjectId, string>;
    github: GitHubCliShape;
    pins?: ProjectPullRequestPinsShape;
  },
  body: (services: {
    pullRequests: PullRequestServiceShape;
    inbox: Effect.Success<ReturnType<typeof makeGitHubInboxService>>;
  }) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listProjects = () => Effect.succeed(input.projects);
        const inbox = yield* makeGitHubInboxService({
          github: input.github,
          pins: input.pins ?? noPins,
          listProjects,
          resolveRepositories: (project) => {
            const repository = input.repositories.get(project.id);
            return Effect.succeed({
              repositories: repository
                ? [{ nameWithOwner: repository, url: `https://github.com/${repository}` }]
                : [],
              authoritative: true,
            });
          },
          includeUpstreams: () => Effect.succeed(false),
        });
        const pullRequests = yield* makePullRequestService({
          github: input.github,
          pins: input.pins ?? noPins,
          listProjects,
          inbox,
        });
        return yield* body({ pullRequests, inbox });
      }),
    ),
  );
}

function makeTestPullRequestService(input: Parameters<typeof runServices>[0]) {
  return Effect.gen(function* () {
    const listProjects = () => Effect.succeed(input.projects);
    const inbox = yield* makeGitHubInboxService({
      github: input.github,
      pins: input.pins ?? noPins,
      listProjects,
      resolveRepositories: (project) => {
        const repository = input.repositories.get(project.id);
        return Effect.succeed({
          repositories: repository
            ? [{ nameWithOwner: repository, url: `https://github.com/${repository}` }]
            : [],
          authoritative: true,
        });
      },
      includeUpstreams: () => Effect.succeed(false),
    });
    return yield* makePullRequestService({
      github: input.github,
      pins: input.pins ?? noPins,
      listProjects,
      inbox,
    });
  });
}

/** A `gh` that counts inbox reads per repository and detail reads per number. */
function countingGitHub(overrides: Partial<GitHubCliShape> = {}) {
  const base = createGitHubCliWithFakeGh().service;
  const inboxReads = new Map<string, number>();
  const detailReads: number[] = [];
  const github: GitHubCliShape = {
    ...base,
    listRepositoryInbox: ({ repository }) =>
      Effect.suspend(() => {
        inboxReads.set(repository, (inboxReads.get(repository) ?? 0) + 1);
        return decodeRepositoryInboxJson(
          fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1)] }),
        );
      }),
    getPullRequestDetail: ({ number, repository }) =>
      Effect.sync(() => {
        detailReads.push(number);
        return makeDetail(number, repository);
      }),
    ...overrides,
  };
  return { github, inboxReads, detailReads };
}

describe("PullRequestService", () => {
  it.each([false, true])(
    "keeps merge prerequisites outside a read pause (cached capabilities: %s)",
    async (warmCapabilities) => {
      const project = makeProject("project-paused-merge", "Merge", "/tmp/paused-merge");
      const gate = makeGitHubReadGate();
      const { service: base, ghCalls } = createGitHubCliWithFakeGh({
        pullRequestDetail: makeDetail(42, "acme/app"),
      });
      await runServices(
        {
          projects: [project],
          repositories: new Map([[project.id, "acme/app"]]),
          github: { ...base, withRead: gate.withRead },
        },
        ({ pullRequests }) =>
          Effect.gen(function* () {
            if (warmCapabilities)
              yield* pullRequests.detail({
                projectId: project.id,
                repository: "acme/app",
                number: 42,
              });
            gate.noteFailure(
              new GitHubCliError({
                operation: "execute",
                detail: "GitHub rate limit",
                reason: "rate-limited",
              }),
            );
            yield* pullRequests.action({
              projectId: project.id,
              repository: "acme/app",
              number: 42,
              action: "merge",
              mergeMethod: "squash",
            });
          }),
      );
      expect(ghCalls.some((call) => call.includes("pr action merge"))).toBe(true);
    },
  );

  it("allows clearing a pin after its repository remote was removed", async () => {
    const project = makeProject("project-orphan", "Orphan", "/tmp/orphan");
    const writes: Array<{ repositoryKey: string; isPinned: boolean }> = [];
    const pins: ProjectPullRequestPinsShape = {
      listByProjectIds: () => Effect.succeed([]),
      setPinned: (input) =>
        Effect.sync(() => {
          writes.push({ repositoryKey: input.repositoryKey, isPinned: input.isPinned });
        }),
    };

    const result = await runServices(
      {
        projects: [project],
        repositories: new Map(),
        github: createGitHubCliWithFakeGh().service,
        pins,
      },
      ({ pullRequests }) =>
        pullRequests.setPinned({
          projectId: project.id,
          repository: " Acme/Removed ",
          number: 42,
          isPinned: false,
        }),
    );

    expect(result.repository).toBe("Acme/Removed");
    expect(writes).toEqual([{ repositoryKey: "acme/removed", isPinned: false }]);
  });

  it("forces a fresh inbox read for the mutated repository only", async () => {
    const projectA = makeProject("project-action-a", "Action A", "/tmp/action-a");
    const projectB = makeProject("project-action-b", "Action B", "/tmp/action-b");
    const { github, inboxReads } = countingGitHub();

    await runServices(
      {
        projects: [projectA, projectB],
        repositories: new Map([
          [projectA.id, "acme/one"],
          [projectB.id, "acme/two"],
        ]),
        github,
      },
      ({ pullRequests, inbox }) =>
        Effect.gen(function* () {
          yield* inbox.list({ state: "open" });
          yield* inbox.list({ state: "open" });
          yield* pullRequests.action({
            projectId: projectA.id,
            repository: "acme/one",
            number: 1,
            action: "close",
          });
          yield* inbox.list({ state: "open" });
        }),
    );

    expect(inboxReads.get("acme/one")).toBe(2);
    expect(inboxReads.get("acme/two")).toBe(1);
  });

  it("invalidates the repository when an in-flight action or comment is interrupted", async () => {
    const project = makeProject("project-cancel", "Cancelled", "/tmp/cancel");
    let actionStarted: Deferred.Deferred<void> | null = null;
    let commentStarted: Deferred.Deferred<void> | null = null;
    const { github, inboxReads } = countingGitHub({
      runPullRequestAction: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(actionStarted!, undefined);
          return yield* Effect.never;
        }),
      commentOnPullRequest: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(commentStarted!, undefined);
          return yield* Effect.never;
        }),
    });

    await runServices(
      { projects: [project], repositories: new Map([[project.id, "acme/cancelled"]]), github },
      ({ pullRequests, inbox }) =>
        Effect.gen(function* () {
          actionStarted = yield* Deferred.make<void>();
          commentStarted = yield* Deferred.make<void>();
          const identity = { projectId: project.id, repository: "acme/cancelled", number: 1 };
          yield* inbox.list({ state: "open" });
          const actionFiber = yield* pullRequests
            .action({ ...identity, action: "close" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(actionFiber);
          yield* inbox.list({ state: "open" });
          const commentFiber = yield* pullRequests
            .comment({ ...identity, body: "Looks good" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(commentStarted);
          yield* Fiber.interrupt(commentFiber);
          yield* inbox.list({ state: "open" });
        }),
    );

    expect(inboxReads.get("acme/cancelled")).toBe(3);
  });

  it("caches pull request detail briefly and drops it on mutation or forced refresh", async () => {
    const project = makeProject("project-detail", "Detail", "/tmp/detail");
    const { github, detailReads } = countingGitHub();
    const pr = (number: number) => ({ projectId: project.id, repository: "acme/app", number });

    await runServices(
      { projects: [project], repositories: new Map([[project.id, "acme/app"]]), github },
      ({ pullRequests }) =>
        Effect.gen(function* () {
          yield* pullRequests.detail(pr(1));
          yield* pullRequests.detail(pr(1));
          yield* pullRequests.detail(pr(2));
          // A comment on #1 drops only #1.
          yield* pullRequests.comment({ ...pr(1), body: "Thanks" });
          yield* pullRequests.detail(pr(1));
          yield* pullRequests.detail(pr(2));
          yield* pullRequests.detail({ ...pr(2), forceRefresh: true });
          // A (possibly stacked) merge drops every cached pull request in the repository.
          yield* pullRequests.action({ ...pr(1), action: "merge", mergeMethod: "squash" });
          yield* pullRequests.detail(pr(1));
          yield* pullRequests.detail(pr(2));
        }),
    );

    expect(detailReads).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it("searches work items through the bounded GitHub read path", async () => {
    const project = makeProject("project-work-items", "Work items", "/tmp/work-items");
    const workItem = {
      kind: "issue" as const,
      number: 5,
      title: "Issue five",
      state: "open" as const,
      url: "https://github.com/acme/shared/issues/5",
      bodyExcerpt: "body",
      createdAt: now,
      updatedAt: now,
    };
    const github = createGitHubCliWithFakeGh({ workItems: [workItem] }).service;

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeTestPullRequestService({
            projects: [project],
            repositories: new Map([[project.id, "acme/shared"]]),
            github,
          });
          return yield* service.searchWorkItems({
            cwd: "/tmp/work-items",
            repository: "acme/shared",
            query: "",
            limit: 20,
          });
        }),
      ),
    );

    expect(result.available).toBe(true);
    expect(result.errorHint).toBeNull();
    expect(result.items).toEqual([workItem]);
  });

  it("caches identical work item searches for the TTL and joins concurrent ones", async () => {
    const project = makeProject("project-work-items-cache", "Work items cache", "/tmp/work-items");
    const workItem = {
      kind: "pull-request" as const,
      number: 7,
      title: "PR seven",
      state: "open" as const,
      url: "https://github.com/acme/shared/pull/7",
      bodyExcerpt: "",
      createdAt: now,
      updatedAt: now,
    };
    const { service: base, ghCalls } = createGitHubCliWithFakeGh({ workItems: [workItem] });
    let searchReads = 0;
    const github: GitHubCliShape = {
      ...base,
      searchWorkItems: (input) =>
        Effect.suspend(() => {
          searchReads += 1;
          return base.searchWorkItems(input);
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeTestPullRequestService({
            projects: [project],
            repositories: new Map([[project.id, "acme/shared"]]),
            github,
          });
          const [first, secondConcurrent, thirdAfter, differentQuery] = yield* Effect.all(
            [
              service.searchWorkItems({
                cwd: "/tmp/work-items",
                repository: "acme/shared",
                query: "",
                limit: 20,
              }),
              service.searchWorkItems({
                cwd: "/tmp/work-items",
                repository: "acme/shared",
                query: "",
                limit: 20,
              }),
              Effect.flatMap(Effect.yieldNow, () =>
                service.searchWorkItems({
                  cwd: "/tmp/work-items",
                  repository: "acme/shared",
                  query: "",
                  limit: 20,
                }),
              ),
              service.searchWorkItems({
                cwd: "/tmp/work-items",
                repository: "acme/shared",
                query: "race",
                limit: 20,
              }),
            ],
            { concurrency: "unbounded" },
          );
          return { first, secondConcurrent, thirdAfter, differentQuery } as const;
        }),
      ),
    );

    // The two concurrent identical searches join one gh round trip; the third
    // reuses the 30s cache entry; the different query misses the cache.
    expect(searchReads).toBe(2);
    expect(results.first.items).toEqual([workItem]);
    expect(results.secondConcurrent.items).toEqual([workItem]);
    expect(results.thirdAfter.items).toEqual([workItem]);
    expect(results.differentQuery.items).toEqual([workItem]);
    expect(ghCalls.filter((call) => call.startsWith("workItem search"))).toHaveLength(2);
  });

  it("does not cache unavailable or degraded work item searches", async () => {
    const project = makeProject(
      "project-work-items-uncached",
      "Work items uncached",
      "/tmp/work-items",
    );
    const workItem = {
      kind: "issue" as const,
      number: 5,
      title: "Issue five",
      state: "open" as const,
      url: "https://github.com/acme/shared/issues/5",
      bodyExcerpt: "body",
      createdAt: now,
      updatedAt: now,
    };
    const base = createGitHubCliWithFakeGh().service;
    const responses: WorkItemSearchResult[] = [
      { available: false, errorHint: "gh is not installed.", items: [] },
      {
        available: true,
        errorHint: "Some GitHub results may be missing because a search request failed.",
        items: [],
      },
      { available: true, errorHint: null, items: [workItem] },
    ];
    let searchReads = 0;
    const github: GitHubCliShape = {
      ...base,
      searchWorkItems: () =>
        Effect.sync(() => {
          const response = responses[Math.min(searchReads, responses.length - 1)]!;
          searchReads += 1;
          return response;
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeTestPullRequestService({
            projects: [project],
            repositories: new Map([[project.id, "acme/shared"]]),
            github,
          });
          const search = () =>
            service.searchWorkItems({
              cwd: "/tmp/work-items",
              repository: "acme/shared",
              query: "",
              limit: 20,
            });
          const first = yield* search();
          const second = yield* search();
          const third = yield* search();
          const fourth = yield* Effect.flatMap(Effect.yieldNow, search);
          return { first, second, third, fourth } as const;
        }),
      ),
    );

    // first is unavailable and second is degraded, so both must hit gh fresh;
    // third is healthy and fourth reuses its cache entry.
    expect(searchReads).toBe(3);
    expect(results.first.available).toBe(false);
    expect(results.second.errorHint).not.toBeNull();
    expect(results.third.errorHint).toBeNull();
    expect(results.third.items).toEqual([workItem]);
    expect(results.fourth.items).toEqual([workItem]);
  });

  it("maps gh availability for the composer attach affordance", async () => {
    const project = makeProject("project-work-items-auth", "Work items auth", "/tmp/work-items");
    const base = createGitHubCliWithFakeGh().service;
    let viewerLookup = 0;

    const readyGithub: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.sync(() => {
          viewerLookup += 1;
          return "viewer";
        }),
    };
    const notInstalledGithub: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getViewerLogin",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
            reason: "not-installed",
          }),
        ),
    };
    const notAuthenticatedGithub: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getViewerLogin",
            detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
            reason: "not-authenticated",
          }),
        ),
    };
    const otherFailureGithub: GitHubCliShape = {
      ...base,
      getViewerLogin: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getViewerLogin",
            detail: "network unreachable",
            reason: "other",
          }),
        ),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const build = (github: GitHubCliShape) =>
            Effect.flatMap(
              makeTestPullRequestService({
                projects: [project],
                repositories: new Map([[project.id, "acme/shared"]]),
                github,
              }),
              (service) => service.workItemsAuthStatus({ cwd: "/tmp/work-items" }),
            );
          return [
            yield* build(readyGithub),
            yield* build(notInstalledGithub),
            yield* build(notAuthenticatedGithub),
            yield* build(otherFailureGithub),
          ] as const;
        }),
      ),
    );

    expect(results[0]).toEqual({ status: "ready", hint: null });
    expect(results[1]).toEqual({
      status: "gh-not-installed",
      hint: "GitHub CLI (`gh`) is required but not available on PATH.",
    });
    expect(results[2]).toEqual({
      status: "gh-not-authenticated",
      hint: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
    });
    // Unclassifiable probe failures keep the item enabled; the search dialog
    // surfaces the real error with a retry.
    expect(results[3]).toEqual({ status: "ready", hint: null });
    expect(viewerLookup).toBe(1);
  });
});
