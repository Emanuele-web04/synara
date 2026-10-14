import { ProjectId } from "@synara/contracts";
import type { OrchestrationProject } from "@synara/contracts";
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
});
