import { ProjectId, type GitHubInboxSort, type OrchestrationProject } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubCliError } from "../../git/Errors";
import {
  decodeRepositoryInboxJson,
  decodeRepositoryInvolvementJson,
} from "../../git/Layers/GitHubCli";
import type { GitHubCliShape, GitHubRepositoryInboxLookup } from "../../git/Services/GitHubCli";
import {
  createGitHubCliWithFakeGh,
  fakeInboxGraphQlJson,
  fakeInboxIssueNode,
  fakeInboxPullRequestNode,
} from "../../git/testing/fakeGitHubCli";
import type {
  ProjectPullRequestPin,
  ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import { PULL_REQUEST_PIN_RECOVERY_LIMIT } from "../../pullRequests/pullRequestPinRecovery";
import {
  GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS,
  GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS,
  GITHUB_INBOX_MAX_PROBE_EXTENSION_MS,
  GITHUB_INBOX_SNAPSHOT_TTL_MS,
} from "../githubInbox.logic";
import { GitHubInboxRateLimitedError } from "../Services/GitHubInboxService";
import { makeGitHubInboxService } from "./GitHubInboxService";

const now = "2026-07-15T00:00:00.000Z";
const MINUTE = 60_000;

function makeProject(
  id: string,
  title: string,
  workspaceRoot = `/tmp/${id}`,
): OrchestrationProject {
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

type PinWrite = { projectId: ProjectId; repositoryKey: string; number: number; isPinned: boolean };

function makePins(
  rows: ReadonlyArray<ProjectPullRequestPin> = [],
  writes: PinWrite[] = [],
): ProjectPullRequestPinsShape {
  return {
    listByProjectIds: ({ projectIds }) =>
      Effect.succeed(rows.filter((row) => projectIds.includes(row.projectId))),
    setPinned: (input) => Effect.sync(() => void writes.push(input)),
  };
}

/** A scripted `gh` whose inbox answers and call counts are per repository and state. */
function makeGitHub(input: {
  inbox?: (repository: string, state: "open" | "closed", sort?: GitHubInboxSort) => string;
  failInbox?: (repository: string) => GitHubCliError | null;
  failInvolvement?: (repository: string) => GitHubCliError | null;
  /** Wraps every inbox GraphQL call, for timing and concurrency checks. */
  around?: <A, E>(call: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  probe?: () => { changed: false } | { changed: true; etag: string | null };
  items?: (numbers: ReadonlyArray<number>) => ReadonlyMap<number, GitHubRepositoryInboxLookup>;
  itemsError?: GitHubCliError;
}) {
  const base = createGitHubCliWithFakeGh().service;
  const inboxCalls: string[] = [];
  const involvementCalls: string[] = [];
  const around = input.around ?? (<A, E>(call: Effect.Effect<A, E>) => call);
  const probeCalls: Array<string | null> = [];
  const itemCalls: number[][] = [];
  let etagCounter = 0;
  const github: GitHubCliShape = {
    ...base,
    listRepositoryInbox: ({ repository, state, sort }) =>
      around(
        Effect.suspend(() => {
          inboxCalls.push(`${repository}:${state}`);
          const failure = input.failInbox?.(repository);
          if (failure) return Effect.fail(failure);
          return decodeRepositoryInboxJson(
            input.inbox?.(repository, state, sort) ?? fakeInboxGraphQlJson({}),
          );
        }),
      ),
    // The same fixture answers the involvement document; its decoder reads only `mine`.
    listRepositoryInboxInvolvement: ({ repository, state, sort }) =>
      around(
        Effect.suspend(() => {
          involvementCalls.push(`${repository}:${state}`);
          const failure = input.failInvolvement?.(repository);
          if (failure) return Effect.fail(failure);
          return decodeRepositoryInvolvementJson(
            input.inbox?.(repository, state, sort) ?? fakeInboxGraphQlJson({}),
          );
        }),
      ),
    probeRepositoryInboxChanges: ({ etag }) =>
      Effect.sync(() => {
        probeCalls.push(etag);
        if (etag && input.probe) return input.probe();
        return { changed: true as const, etag: `"etag-${++etagCounter}"` };
      }),
    getRepositoryInboxItems: ({ numbers }) =>
      Effect.suspend(() => {
        itemCalls.push([...numbers]);
        if (input.itemsError) return Effect.fail(input.itemsError);
        return Effect.succeed(
          input.items?.(numbers) ??
            new Map(numbers.map((number) => [number, { _tag: "not-found" as const }])),
        );
      }),
  };
  return { github, inboxCalls, involvementCalls, probeCalls, itemCalls };
}

function runInbox<A, E>(
  input: {
    projects: OrchestrationProject[];
    repositories: ReadonlyMap<ProjectId, ReadonlyArray<string>>;
    github: GitHubCliShape;
    pins?: ProjectPullRequestPinsShape;
    includeUpstreams?: boolean;
    clock?: { value: number };
    resolveCount?: { value: number };
    resolveFailure?: Error;
    nonAuthoritative?: boolean;
  },
  body: (service: Effect.Success<ReturnType<typeof makeGitHubInboxService>>) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeGitHubInboxService({
          github: input.github,
          pins: input.pins ?? makePins(),
          listProjects: () => Effect.succeed(input.projects),
          resolveRepositories: (project) =>
            Effect.suspend(() => {
              if (input.resolveCount) input.resolveCount.value += 1;
              if (input.resolveFailure) return Effect.fail(input.resolveFailure);
              const repositories = input.repositories.get(project.id) ?? [];
              return Effect.succeed({
                repositories: input.nonAuthoritative
                  ? []
                  : repositories.map((nameWithOwner) => ({
                      nameWithOwner,
                      url: `https://github.com/${nameWithOwner}`,
                    })),
                authoritative: input.nonAuthoritative !== true,
              });
            }),
          includeUpstreams: () => Effect.succeed(input.includeUpstreams === true),
          ...(input.clock ? { now: () => input.clock!.value } : {}),
        });
        return yield* body(service);
      }),
    ),
  );
}

describe("GitHubInboxService.list", () => {
  it("keeps sort snapshots separate and invalidates both after a repository mutation", async () => {
    const project = makeProject("project-sort", "App");
    let title = "Before mutation";
    const { github, inboxCalls } = makeGitHub({
      inbox: (_repository, _state, sort) =>
        fakeInboxGraphQlJson({
          pullRequests: [fakeInboxPullRequestNode(sort === "created" ? 2 : 1, { title })],
        }),
      probe: () => ({ changed: false }),
    });
    await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
      },
      (service) =>
        Effect.gen(function* () {
          const updated = yield* service.list({ state: "open", sort: "updated" });
          const created = yield* service.list({ state: "open", sort: "created" });
          const cached = yield* service.list({ state: "open", sort: "updated" });
          expect(updated.items.map((item) => item.number)).toEqual([1]);
          expect(created.items.map((item) => item.number)).toEqual([2]);
          expect(cached.items).toEqual(updated.items);
          expect(inboxCalls).toHaveLength(2);
          title = "After mutation";
          yield* service.invalidateRepository("acme/app");
          for (const sort of ["created", "updated"] as const) {
            const refreshed = yield* service.list({ state: "open", sort });
            expect(refreshed.items[0]?.title).toBe("After mutation");
          }
          expect(inboxCalls).toHaveLength(4);
        }),
    );
  });

  it("reads each unique repository once and fans shared rows out to every project", async () => {
    const projectA = makeProject("project-a", "App");
    const projectB = makeProject("project-b", "feature-1");
    const projectC = makeProject("project-c", "Docs");
    const { github, inboxCalls } = makeGitHub({
      inbox: (repository) =>
        fakeInboxGraphQlJson({
          pullRequests:
            repository === "acme/app"
              ? [fakeInboxPullRequestNode(1, { headRefName: "feature-1" })]
              : [],
          issues: [fakeInboxIssueNode(repository === "acme/app" ? 2 : 3)],
        }),
    });

    const result = await runInbox(
      {
        projects: [projectA, projectB, projectC],
        repositories: new Map([
          [projectA.id, ["acme/app"]],
          [projectB.id, ["acme/app"]],
          [projectC.id, ["acme/docs"]],
        ]),
        github,
      },
      (service) => service.list({ state: "open" }),
    );

    expect(inboxCalls.toSorted()).toEqual(["acme/app:open", "acme/docs:open"]);
    const pullRequest = result.items.find((item) => item.kind === "pullRequest");
    expect(pullRequest?.number).toBe(1);
    // The worktree project named after the head branch is the natural place to open the PR.
    expect(pullRequest?.projectId).toBe(projectB.id);
    expect(pullRequest?.projectContexts?.map((context) => context.projectId).toSorted()).toEqual(
      [projectA.id, projectB.id].toSorted(),
    );
    expect(
      result.items
        .filter((item) => item.kind === "issue")
        .map((item) => item.number)
        .toSorted(),
    ).toEqual([2, 3]);
    expect(result.repositoryBatches.map((batch) => batch.repository).toSorted()).toEqual([
      "acme/app",
      "acme/docs",
    ]);
  });

  it("reads only each project's preferred repository unless upstreams are included", async () => {
    const project = makeProject("project-fork", "Fork");
    const repositories = new Map([[project.id, ["me/app", "upstream/app"]]]);
    const primary = makeGitHub({});
    const withUpstreams = makeGitHub({});

    await runInbox({ projects: [project], repositories, github: primary.github }, (service) =>
      service.list({ state: "open" }),
    );
    await runInbox(
      { projects: [project], repositories, github: withUpstreams.github, includeUpstreams: true },
      (service) => service.list({ state: "open" }),
    );

    expect(primary.inboxCalls).toEqual(["me/app:open"]);
    expect(withUpstreams.inboxCalls.toSorted()).toEqual(["me/app:open", "upstream/app:open"]);
  });

  it("keeps pins on upstream repositories that the inbox does not read", async () => {
    const project = makeProject("project-upstream-pin", "Fork");
    const writes: PinWrite[] = [];
    const { github } = makeGitHub({});

    await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["me/app", "upstream/app"]]]),
        github,
        pins: makePins(
          [{ projectId: project.id, repositoryKey: "upstream/app", number: 5 }],
          writes,
        ),
      },
      (service) => service.list({ state: "open" }),
    );

    expect(writes).toEqual([]);
  });

  it("flags involvement and review requests, and counts review requests for open only", async () => {
    const project = makeProject("project-involvement", "App");
    const teammate = {
      __typename: "User",
      login: "teammate",
      avatarUrl: null,
      url: null,
      name: null,
    };
    const viewer = { __typename: "User", login: "Viewer", avatarUrl: null, url: null, name: null };
    const { github, itemCalls } = makeGitHub({
      inbox: (_repository, state) =>
        fakeInboxGraphQlJson({
          viewer: "viewer",
          pullRequests: [
            fakeInboxPullRequestNode(1, { author: viewer }),
            fakeInboxPullRequestNode(2, { author: teammate }),
            fakeInboxPullRequestNode(3, { author: teammate }),
          ],
          issues: [
            fakeInboxIssueNode(4, {
              author: teammate,
              assignees: { nodes: [{ login: "VIEWER", avatarUrl: null, url: null, name: null }] },
            }),
          ],
          // #5 is older than the list page but involves the viewer; #2 matched the search too.
          mine:
            state === "open"
              ? [fakeInboxIssueNode(5, { author: teammate }), fakeInboxPullRequestNode(2)]
              : [],
          reviewRequested: state === "open" ? [3] : null,
          reviewRequestedCount: state === "open" ? 7 : 0,
        }),
    });

    const [open, closed] = await runInbox(
      { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github },
      (service) => Effect.all([service.list({ state: "open" }), service.list({ state: "closed" })]),
    );

    const byNumber = new Map(open.items.map((item) => [item.number, item]));
    expect(open.viewer).toBe("viewer");
    expect(byNumber.get(1)?.viewerInvolvement).toEqual({
      authored: true,
      assigned: false,
      involved: true,
    });
    expect(byNumber.get(2)?.viewerInvolvement?.involved).toBe(true);
    expect(byNumber.get(4)?.viewerInvolvement).toEqual({
      authored: false,
      assigned: true,
      involved: true,
    });
    expect(byNumber.get(5)?.kind).toBe("issue");
    expect(byNumber.get(5)?.viewerInvolvement?.involved).toBe(true);
    expect(itemCalls).toEqual([]);
    const reviewFlag = (number: number) => {
      const item = byNumber.get(number);
      return item?.kind === "pullRequest" ? item.viewerReviewRequested : null;
    };
    expect(reviewFlag(3)).toBe(true);
    expect(reviewFlag(2)).toBe(false);
    expect(open.items.filter((item) => item.number === 2)).toHaveLength(1);
    expect(open.reviewRequestedCount).toBe(7);
    expect(open.reviewRequestedCountIncomplete).toBe(false);
    expect(closed.reviewRequestedCount).toBe(0);
  });

  it("serves a snapshot for four minutes, then asks GitHub with a free 304 probe", async () => {
    const project = makeProject("project-probe", "App");
    const clock = { value: Date.parse(now) };
    const { github, inboxCalls, probeCalls } = makeGitHub({
      inbox: () => fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1)] }),
      probe: () => ({ changed: false }),
    });

    const results = await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
        clock,
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.list({ state: "open" });
          clock.value += 2 * MINUTE;
          yield* service.list({ state: "open" });
          clock.value += GITHUB_INBOX_SNAPSHOT_TTL_MS;
          const probed = yield* service.list({ state: "open" });
          clock.value += GITHUB_INBOX_MAX_PROBE_EXTENSION_MS;
          yield* service.list({ state: "open" });
          return { first, probed };
        }),
    );

    // Initial read: an ETag probe, then GraphQL. Within the TTL: nothing. After the TTL: one
    // conditional probe answered 304. Past the probe-extension limit: a full read again.
    expect(probeCalls).toEqual([null, '"etag-1"', null]);
    expect(inboxCalls).toEqual(["acme/app:open", "acme/app:open"]);
    expect(results.probed.items.map((item) => item.number)).toEqual([1]);
    expect(results.probed.repositoryBatches[0]?.fetchedAt).toBe(
      results.first.repositoryBatches[0]?.fetchedAt,
    );
  });

  it.each(["304", "full read"] as const)(
    "keeps a manual refresh after an older %s request completes",
    async (olderRead) => {
      const project = makeProject("project-refresh-race", "App");
      const clock = { value: Date.parse(now) };
      const started = await Effect.runPromise(Deferred.make<void>());
      const release = await Effect.runPromise(Deferred.make<void>());
      let title = "Before refresh";
      const base = makeGitHub({
        inbox: () =>
          fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1, { title })] }),
      });
      const holdResult = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const result = yield* effect;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return result;
        });
      let fullReads = 0;
      const github: GitHubCliShape = {
        ...base.github,
        probeRepositoryInboxChanges: (input) =>
          olderRead === "304" && input.etag !== null
            ? holdResult(Effect.succeed({ changed: false as const }))
            : base.github.probeRepositoryInboxChanges(input),
        listRepositoryInbox: (input) => {
          const read = base.github.listRepositoryInbox(input);
          fullReads += 1;
          return olderRead === "full read" && fullReads === 2 ? holdResult(read) : read;
        },
      };

      const result = await runInbox(
        { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github, clock },
        (service) =>
          Effect.gen(function* () {
            yield* service.list({ state: "open" });
            clock.value += GITHUB_INBOX_SNAPSHOT_TTL_MS;
            const oldRequest = yield* service.list({ state: "open" }).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            title = "After refresh";
            const refreshed = yield* service.list({ state: "open", forceRefresh: true });
            yield* Deferred.succeed(release, undefined);
            const older = yield* Fiber.join(oldRequest);
            const cached = yield* service.list({ state: "open" });
            return { refreshed, older, cached };
          }),
      );

      expect(result.refreshed.items[0]?.title).toBe("After refresh");
      expect(result.older.items[0]?.title).toBe("Before refresh");
      expect(result.cached.items[0]?.title).toBe("After refresh");
      expect(base.inboxCalls).toHaveLength(olderRead === "304" ? 2 : 3);
    },
  );

  it.each(["success", "failure"] as const)(
    "preserves a refresh's failure backoff after an older %s completes",
    async (olderOutcome) => {
      const project = makeProject("project-refresh-backoff", "App");
      const clock = { value: Date.parse(now) };
      const started = await Effect.runPromise(Deferred.make<void>());
      const release = await Effect.runPromise(Deferred.make<void>());
      const base = makeGitHub({
        inbox: () => fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1)] }),
      });
      const oldError = new GitHubCliError({
        operation: "listRepositoryInbox",
        detail: "Older request failed",
        reason: "other",
      });
      const refreshError = new GitHubCliError({
        operation: "listRepositoryInbox",
        detail: "Refresh failed",
        reason: "other",
      });
      let fullReads = 0;
      const github: GitHubCliShape = {
        ...base.github,
        listRepositoryInbox: (input) => {
          fullReads += 1;
          if (fullReads === 2) {
            return Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* olderOutcome === "failure"
                ? Effect.fail(oldError)
                : base.github.listRepositoryInbox(input);
            });
          }
          if (fullReads === 3) return Effect.fail(refreshError);
          return base.github.listRepositoryInbox(input);
        },
      };

      const result = await runInbox(
        { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github, clock },
        (service) =>
          Effect.gen(function* () {
            yield* service.list({ state: "open" });
            clock.value += GITHUB_INBOX_SNAPSHOT_TTL_MS;
            const oldRequest = yield* service.list({ state: "open" }).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const refreshed = yield* service.list({ state: "open", forceRefresh: true });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(oldRequest);
            const backedOff = yield* service.list({ state: "open" });
            const readsDuringBackoff = fullReads;
            clock.value += GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS + 1;
            const recovered = yield* service.list({ state: "open" });
            return { refreshed, backedOff, readsDuringBackoff, recovered };
          }),
      );

      expect(result.refreshed.errors[0]?.message).toBe("Refresh failed");
      expect(result.backedOff.errors[0]?.message).toBe("Refresh failed");
      expect(result.readsDuringBackoff).toBe(3);
      expect(result.recovered.errors).toEqual([]);
      expect(fullReads).toBe(4);
    },
  );

  it("stops refetching below the rate-limit floor and shows the cached rows until the reset", async () => {
    const project = makeProject("project-floor", "App");
    const clock = { value: Date.parse(now) };
    const resetAt = new Date(clock.value + 30 * MINUTE).toISOString();
    const { github, inboxCalls, probeCalls } = makeGitHub({
      inbox: () =>
        fakeInboxGraphQlJson({
          pullRequests: [fakeInboxPullRequestNode(1)],
          rateLimit: { cost: 5, remaining: 150, resetAt },
        }),
    });

    const later = await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
        clock,
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.list({ state: "open" });
          clock.value += 10 * MINUTE;
          const paused = yield* service.list({ state: "open", forceRefresh: true });
          clock.value += 25 * MINUTE;
          yield* service.list({ state: "open" });
          return paused;
        }),
    );

    expect(later.items.map((item) => item.number)).toEqual([1]);
    expect(later.rateLimit).toEqual({ remaining: 150, resetAt });
    expect(later.errors).toEqual([
      expect.objectContaining({
        repository: "acme/app",
        reason: "rate-limited",
        retryAt: resetAt,
        showingCachedData: true,
      }),
    ]);
    // Paused reads cost nothing, a manual refresh included; after the reset reading resumes.
    expect(inboxCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(2);
  });

  it("fails the whole view with a retry time when every repository is rate-limited", async () => {
    const project = makeProject("project-limited", "App");
    const { github } = makeGitHub({
      failInbox: () =>
        new GitHubCliError({
          operation: "listRepositoryInbox",
          detail: "GitHub rate limit reached.",
          reason: "rate-limited",
        }),
    });

    const error = await runInbox(
      { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github },
      (service) => service.list({ state: "open" }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(GitHubInboxRateLimitedError);
    expect(Date.parse((error as GitHubInboxRateLimitedError).retryAt)).toBeGreaterThan(Date.now());
  });

  it("backs off a failing repository without hiding the others, and a manual refresh retries", async () => {
    const healthy = makeProject("project-healthy", "Healthy");
    const broken = makeProject("project-broken", "Broken");
    const clock = { value: Date.parse(now) };
    const { github, inboxCalls } = makeGitHub({
      inbox: () => fakeInboxGraphQlJson({ issues: [fakeInboxIssueNode(1)] }),
      failInbox: (repository) =>
        repository === "acme/broken"
          ? new GitHubCliError({
              operation: "execute",
              detail:
                "GitHub CLI command failed: gh api graphql -f query=... failed (code=1, signal=null). gh: Could not resolve to a Repository with the name 'acme/broken'.",
            })
          : null,
    });
    const brokenCalls = () => inboxCalls.filter((call) => call === "acme/broken:open").length;

    const first = await runInbox(
      {
        projects: [healthy, broken],
        repositories: new Map([
          [healthy.id, ["acme/healthy"]],
          [broken.id, ["acme/broken"]],
        ]),
        github,
        clock,
      },
      (service) =>
        Effect.gen(function* () {
          const result = yield* service.list({ state: "open" });
          clock.value += GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS - 1_000;
          yield* service.list({ state: "open" });
          const callsDuringBackoff = brokenCalls();
          clock.value += 2_000;
          yield* service.list({ state: "open" });
          const callsAfterBackoff = brokenCalls();
          // The second failure doubles the wait; a manual refresh skips it.
          clock.value += GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS + 1_000;
          yield* service.list({ state: "open" });
          const callsDuringDoubledBackoff = brokenCalls();
          yield* service.list({ state: "open", forceRefresh: true });
          return {
            result,
            callsDuringBackoff,
            callsAfterBackoff,
            callsDuringDoubledBackoff,
            callsAfterForce: brokenCalls(),
          };
        }),
    );

    expect(first.result.items.map((item) => item.repository)).toEqual(["acme/healthy"]);
    expect(first.result.errors).toEqual([
      expect.objectContaining({
        projectId: broken.id,
        repository: "acme/broken",
        reason: "unavailable",
        message: "Could not resolve to a Repository with the name 'acme/broken'.",
        showingCachedData: false,
      }),
    ]);
    expect(first.callsDuringBackoff).toBe(1);
    expect(first.callsAfterBackoff).toBe(2);
    expect(first.callsDuringDoubledBackoff).toBe(2);
    expect(first.callsAfterForce).toBe(3);
  });

  it("reuses the last full read for repeated manual refreshes", async () => {
    const project = makeProject("project-cooldown", "App");
    const clock = { value: Date.parse(now) };
    const { github, inboxCalls, probeCalls } = makeGitHub({});
    const calls = await runInbox(
      { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github, clock },
      (service) =>
        Effect.gen(function* () {
          const refresh = service.list({ state: "open", forceRefresh: true });
          yield* refresh;
          clock.value += GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS - 1;
          yield* refresh;
          const duringCooldown = inboxCalls.length;
          const probesDuringCooldown = probeCalls.length;
          // An action in between still makes the next refresh read GitHub.
          yield* service.invalidateRepository("acme/app");
          yield* refresh;
          const afterMutation = inboxCalls.length;
          clock.value += GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS;
          yield* refresh;
          return {
            duringCooldown,
            probesDuringCooldown,
            afterMutation,
            afterCooldown: inboxCalls.length,
          };
        }),
    );
    expect(calls).toEqual({
      duringCooldown: 1,
      probesDuringCooldown: 1,
      afterMutation: 2,
      afterCooldown: 3,
    });
  });

  it("fails the whole request on gh setup errors", async () => {
    const project = makeProject("project-auth", "App");
    const { github } = makeGitHub({
      failInbox: () =>
        new GitHubCliError({
          operation: "execute",
          detail: "GitHub CLI is not authenticated.",
          reason: "not-authenticated",
        }),
    });

    const error = await runInbox(
      { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github },
      (service) => service.list({ state: "open" }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ _tag: "GitHubCliError", reason: "not-authenticated" });
  });

  it("does not call gh when no project has a GitHub repository", async () => {
    const project = makeProject("project-empty", "Empty");
    const { github, inboxCalls, probeCalls } = makeGitHub({});

    const result = await runInbox(
      { projects: [project], repositories: new Map(), github },
      (service) => service.list({ state: "open" }),
    );

    expect(inboxCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(result).toMatchObject({ viewer: null, items: [], repositoryBatches: [] });
  });

  it("re-reads repository inventories after a project event invalidates them", async () => {
    const project = makeProject("project-inventory", "App");
    const resolveCount = { value: 0 };
    const { github } = makeGitHub({});

    await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
        resolveCount,
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.list({ state: "open" });
          yield* service.list({ state: "open" });
          yield* service.invalidateRepositoryInventories;
          yield* service.list({ state: "open" });
        }),
    );

    expect(resolveCount.value).toBe(2);
  });
});

describe("GitHubInboxService lists and involvement documents", () => {
  const project = makeProject("project-involved", "App");
  const repositories = new Map([[project.id, ["acme/app"]]]);
  const transientError = new GitHubCliError({
    operation: "execute",
    detail:
      "GitHub CLI command failed: gh api graphql -f query=... failed (code=1, signal=null). gh: HTTP 502: Bad Gateway",
  });

  it("sends both documents per full read, merges by number, and sends neither on a 304", async () => {
    const clock = { value: Date.parse(now) };
    const { github, inboxCalls, involvementCalls, itemCalls } = makeGitHub({
      inbox: () =>
        fakeInboxGraphQlJson({
          pullRequests: [fakeInboxPullRequestNode(1, { title: "From the list" })],
          pullRequestTotalCount: 80,
          issues: [fakeInboxIssueNode(2)],
          // #1 overlaps the list; #7 and #8 are older than the lists.
          mine: [
            fakeInboxPullRequestNode(1, { title: "From the search" }),
            fakeInboxPullRequestNode(7),
            fakeInboxIssueNode(8),
          ],
          rateLimit: { cost: 3, remaining: 4_000, resetAt: "2026-07-15T01:00:00Z" },
        }),
      probe: () => ({ changed: false }),
    });

    const [first, cached, probed] = await runInbox(
      { projects: [project], repositories, github, clock },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.list({ state: "open" });
          const cached = yield* service.list({ state: "open" });
          clock.value += GITHUB_INBOX_SNAPSHOT_TTL_MS;
          const probed = yield* service.list({ state: "open" });
          return [first, cached, probed] as const;
        }),
    );

    expect(inboxCalls).toEqual(["acme/app:open"]);
    expect(involvementCalls).toEqual(["acme/app:open"]);
    expect(itemCalls).toEqual([]);
    for (const result of [first, cached, probed]) {
      expect(result.errors).toEqual([]);
      expect(
        result.items
          .map((item) => [item.number, item.kind, item.title, item.viewerInvolvement?.involved])
          .toSorted((left, right) => Number(left[0]) - Number(right[0])),
      ).toEqual([
        [1, "pullRequest", "From the list", true],
        [2, "issue", "Issue 2", false],
        [7, "pullRequest", "PR 7", true],
        [8, "issue", "Issue 8", true],
      ]);
      expect(result.repositoryBatches[0]).toMatchObject({
        truncatedPullRequests: true,
        truncatedIssues: false,
      });
    }
  });

  it("keeps the lower remaining budget of the two documents", async () => {
    const involvementRateLimit = { cost: 2, remaining: 3_990, resetAt: "2026-07-15T01:00:00Z" };
    const { github } = makeGitHub({
      inbox: () =>
        fakeInboxGraphQlJson({
          rateLimit: { cost: 3, remaining: 3_993, resetAt: "2026-07-15T01:00:00Z" },
        }),
    });
    const withLowerSearchBudget: GitHubCliShape = {
      ...github,
      listRepositoryInboxInvolvement: (input) =>
        github
          .listRepositoryInboxInvolvement(input)
          .pipe(Effect.map((involvement) => ({ ...involvement, rateLimit: involvementRateLimit }))),
    };

    const result = await runInbox(
      { projects: [project], repositories, github: withLowerSearchBudget },
      (service) => service.list({ state: "open" }),
    );

    expect(result.rateLimit).toEqual({ remaining: 3_990, resetAt: "2026-07-15T01:00:00.000Z" });
  });

  it("fails the read like any full-read failure when the lists document fails", async () => {
    const { github } = makeGitHub({
      inbox: () => fakeInboxGraphQlJson({ mine: [fakeInboxIssueNode(8)] }),
      failInbox: () => transientError,
    });

    const result = await runInbox({ projects: [project], repositories, github }, (service) =>
      service.list({ state: "open" }),
    );

    expect(result.items).toEqual([]);
    expect(result.repositoryBatches).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        repository: "acme/app",
        reason: "unavailable",
        message: "HTTP 502: Bad Gateway",
        showingCachedData: false,
      }),
    ]);
  });

  it("keeps the list rows and reports a failed search, then retries in full after the backoff", async () => {
    const clock = { value: Date.parse(now) };
    const scripted: Parameters<typeof makeGitHub>[0] = {
      inbox: () =>
        fakeInboxGraphQlJson({
          pullRequests: [fakeInboxPullRequestNode(1)],
          mine: [fakeInboxPullRequestNode(1), fakeInboxIssueNode(8)],
        }),
      failInvolvement: () => transientError,
    };
    const { github, inboxCalls, involvementCalls, probeCalls } = makeGitHub(scripted);

    const results = await runInbox(
      { projects: [project], repositories, github, clock },
      (service) =>
        Effect.gen(function* () {
          const failed = yield* service.list({ state: "open" });
          clock.value += GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS - 1_000;
          const duringBackoff = yield* service.list({ state: "open" });
          delete scripted.failInvolvement;
          clock.value += 2_000;
          const recovered = yield* service.list({ state: "open" });
          return { failed, duringBackoff, recovered };
        }),
    );

    for (const result of [results.failed, results.duringBackoff]) {
      expect(result.items.map((item) => item.number)).toEqual([1]);
      expect(result.errors).toEqual([
        expect.objectContaining({
          projectId: project.id,
          repository: "acme/app",
          reason: "unavailable",
          message: "Older items involving you could not be loaded: HTTP 502: Bad Gateway",
          showingCachedData: true,
        }),
      ]);
    }
    expect(results.recovered.errors).toEqual([]);
    expect(results.recovered.items.map((item) => item.number).toSorted()).toEqual([1, 8]);
    // No ETag is kept for a partial snapshot, so the retry probes without one and reads both.
    expect(probeCalls).toEqual([null, null]);
    expect(inboxCalls).toEqual(["acme/app:open", "acme/app:open"]);
    expect(involvementCalls).toEqual(["acme/app:open", "acme/app:open"]);
  });

  it("fails the whole request when the search hits a gh setup error", async () => {
    const { github } = makeGitHub({
      failInvolvement: () =>
        new GitHubCliError({
          operation: "execute",
          detail: "GitHub CLI is not authenticated.",
          reason: "not-authenticated",
        }),
    });

    const error = await runInbox({ projects: [project], repositories, github }, (service) =>
      service.list({ state: "open" }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ _tag: "GitHubCliError", reason: "not-authenticated" });
  });

  it("finishes every read when repositories need more documents than there are read slots", async () => {
    const projects = Array.from({ length: 9 }, (_, index) =>
      makeProject(`project-slots-${index}`, `Repo ${index}`),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const { github, inboxCalls, involvementCalls } = makeGitHub({
      around: (call) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
          }),
          () => Effect.sleep("5 millis").pipe(Effect.andThen(call)),
          () => Effect.sync(() => void (inFlight -= 1)),
        ),
    });

    const result = await runInbox(
      {
        projects,
        repositories: new Map(projects.map((item, index) => [item.id, [`acme/repo-${index}`]])),
        github,
      },
      (service) => service.list({ state: "open" }).pipe(Effect.timeout("5 seconds")),
    );

    expect(result.errors).toEqual([]);
    expect(result.repositoryBatches).toHaveLength(9);
    expect(inboxCalls).toHaveLength(9);
    expect(involvementCalls).toHaveLength(9);
    // Both documents share the six read slots with every other GitHub read.
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("GitHubInboxService pins", () => {
  const truncatedInbox = () =>
    fakeInboxGraphQlJson({
      pullRequests: [fakeInboxPullRequestNode(1)],
      pullRequestTotalCount: 80,
      issues: [fakeInboxIssueNode(2)],
    });

  it("marks pinned issues and pull requests from the same pin table", async () => {
    const project = makeProject("project-pins", "App");
    const { github } = makeGitHub({
      inbox: () =>
        fakeInboxGraphQlJson({
          pullRequests: [fakeInboxPullRequestNode(1)],
          issues: [fakeInboxIssueNode(2), fakeInboxIssueNode(3)],
        }),
    });

    const result = await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
        pins: makePins([
          { projectId: project.id, repositoryKey: "acme/app", number: 1 },
          { projectId: project.id, repositoryKey: "acme/app", number: 2 },
        ]),
      },
      (service) => service.list({ state: "open" }),
    );

    expect(result.items.map((item) => [item.number, item.kind, item.isPinned])).toEqual([
      [1, "pullRequest", true],
      [2, "issue", true],
      [3, "issue", false],
    ]);
  });

  it("recovers a pinned issue beyond the list cap with one lookup per snapshot", async () => {
    const project = makeProject("project-recover", "App");
    const recovered = await decodeRepositoryInboxJson(
      fakeInboxGraphQlJson({ issues: [fakeInboxIssueNode(99)] }),
    ).pipe(Effect.runPromise);
    const { github, itemCalls } = makeGitHub({
      inbox: truncatedInbox,
      items: () =>
        new Map([[99, { _tag: "found", item: { kind: "issue", item: recovered.issues[0]! } }]]),
    });

    const results = await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github,
        pins: makePins([{ projectId: project.id, repositoryKey: "acme/app", number: 99 }]),
      },
      (service) => Effect.all([service.list({ state: "open" }), service.list({ state: "open" })]),
    );

    expect(itemCalls).toEqual([[99]]);
    for (const result of results) {
      expect(result.items[0]).toMatchObject({ number: 99, kind: "issue", isPinned: true });
    }
  });

  it("deletes a pin only when GitHub says the number does not exist", async () => {
    const project = makeProject("project-missing", "App");
    const deleted: PinWrite[] = [];
    const kept: PinWrite[] = [];
    const missing = makeGitHub({ inbox: truncatedInbox });
    const transient = makeGitHub({
      inbox: truncatedInbox,
      itemsError: new GitHubCliError({
        operation: "getRepositoryInboxItems",
        detail: "gh: HTTP 502",
      }),
    });
    const input = {
      projects: [project],
      repositories: new Map([[project.id, ["acme/app"]]]),
    };

    await runInbox(
      {
        ...input,
        github: missing.github,
        pins: makePins([{ projectId: project.id, repositoryKey: "acme/app", number: 99 }], deleted),
      },
      (service) => service.list({ state: "open" }),
    );
    const transientResult = await runInbox(
      {
        ...input,
        github: transient.github,
        pins: makePins([{ projectId: project.id, repositoryKey: "acme/app", number: 99 }], kept),
      },
      (service) => service.list({ state: "open" }),
    );

    expect(deleted).toEqual([
      { projectId: project.id, repositoryKey: "acme/app", number: 99, isPinned: false },
    ]);
    expect(kept).toEqual([]);
    expect(transientResult.errors.some((error) => error.message.includes("#99"))).toBe(true);
  });

  it("bounds recovery lookups and reports the overflow", async () => {
    const projectA = makeProject("project-bound-a", "A");
    const projectB = makeProject("project-bound-b", "B");
    const { github, itemCalls } = makeGitHub({ inbox: truncatedInbox });
    const pins = [projectA, projectB].flatMap((project, projectIndex) =>
      Array.from({ length: 15 }, (_, index) => ({
        projectId: project.id,
        repositoryKey: "acme/app",
        number: 100 + projectIndex * 15 + index,
      })),
    );

    const result = await runInbox(
      {
        projects: [projectA, projectB],
        repositories: new Map([
          [projectA.id, ["acme/app"]],
          [projectB.id, ["acme/app"]],
        ]),
        github,
        pins: makePins(pins),
      },
      (service) => service.list({ state: "open" }),
    );

    expect(itemCalls.flat()).toHaveLength(PULL_REQUEST_PIN_RECOVERY_LIMIT);
    expect(result.errors.some((error) => error.message.includes("recovery was limited"))).toBe(
      true,
    );
  });

  it("cleans pins for removed repositories but keeps them when inventory is uncertain", async () => {
    const project = makeProject("project-cleanup", "App");
    const removedWrites: PinWrite[] = [];
    const failedWrites: PinWrite[] = [];
    const unknownWrites: PinWrite[] = [];
    const pinRows = [
      { projectId: project.id, repositoryKey: "acme/removed", number: 9 },
      { projectId: project.id, repositoryKey: "acme/app", number: 10 },
    ];
    const base = {
      projects: [project],
      repositories: new Map([[project.id, ["acme/app"]]]),
    };

    await runInbox(
      { ...base, github: makeGitHub({}).github, pins: makePins(pinRows, removedWrites) },
      (service) => service.list({ state: "open" }),
    );
    const failed = await runInbox(
      {
        ...base,
        github: makeGitHub({}).github,
        pins: makePins(pinRows, failedWrites),
        resolveFailure: new Error("git config unavailable"),
      },
      (service) => service.list({ state: "open" }),
    );
    await runInbox(
      {
        ...base,
        github: makeGitHub({}).github,
        pins: makePins(pinRows, unknownWrites),
        nonAuthoritative: true,
      },
      (service) => service.list({ state: "open" }),
    );

    expect(removedWrites).toEqual([
      { projectId: project.id, repositoryKey: "acme/removed", number: 9, isPinned: false },
    ]);
    expect(failedWrites).toEqual([]);
    expect(unknownWrites).toEqual([]);
    expect(failed.errors).toEqual([
      expect.objectContaining({ repository: null, message: "git config unavailable" }),
    ]);
  });
});

describe("GitHubInboxService issues", () => {
  it("caches issue detail and drops it after commenting", async () => {
    const project = makeProject("project-issue", "App");
    const detailCalls: number[] = [];
    const base = createGitHubCliWithFakeGh().service;
    const github: GitHubCliShape = {
      ...base,
      getIssueDetail: ({ number }) =>
        Effect.sync(() => {
          detailCalls.push(number);
          return {
            number,
            title: "Issue",
            url: `https://github.com/acme/app/issues/${number}`,
            author: null,
            state: "open",
            stateReason: null,
            labels: [],
            assignees: [],
            commentCount: 0,
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            body: "Body",
            comments: [],
            commentsTruncated: false,
          };
        }),
    };
    const detailInput = { projectId: project.id, repository: "acme/app", number: 7 };

    const results = await runInbox(
      { projects: [project], repositories: new Map([[project.id, ["acme/app"]]]), github },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.issueDetail(detailInput);
          yield* service.issueDetail(detailInput);
          const comment = yield* service.issueComment({ ...detailInput, body: "Thanks" });
          yield* service.issueDetail(detailInput);
          yield* service.issueDetail({ ...detailInput, forceRefresh: true });
          return { first, comment };
        }),
    );

    expect(detailCalls).toEqual([7, 7, 7]);
    expect(results.first).toMatchObject({
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      repository: "acme/app",
      body: "Body",
    });
    expect(results.comment).toEqual({
      projectId: project.id,
      repository: "acme/app",
      number: 7,
      workspaceRoot: project.workspaceRoot,
    });
  });

  it("rejects an issue from a repository the project does not own", async () => {
    const project = makeProject("project-foreign", "App");
    const exit = await runInbox(
      {
        projects: [project],
        repositories: new Map([[project.id, ["acme/app"]]]),
        github: createGitHubCliWithFakeGh().service,
      },
      (service) =>
        service
          .issueDetail({ projectId: project.id, repository: "other/repo", number: 1 })
          .pipe(Effect.flip),
    );

    expect(String(exit)).toContain("does not belong to the selected project");
  });
});
