import { GitHubCliError } from "../../git/Errors";
import type {
  OrchestrationProject,
  PullRequestDetail,
  WorkItemAuthStatus,
  WorkItemSearchResult,
} from "@synara/contracts";
import { Effect, Layer, Scope } from "effect";

import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli";
import {
  GITHUB_ITEM_DETAIL_CACHE_TTL_MS,
  githubItemCacheKey,
} from "../../githubInbox/githubInbox.logic";
import {
  GitHubInboxService,
  type GitHubInboxSharedReads,
} from "../../githubInbox/Services/GitHubInboxService";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProjectPullRequestPins,
  type ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import { makeKeyedSingleFlightCache } from "../KeyedSingleFlightCache";
import { liveProjectFromShell, makeProjectRepositoryAccess } from "../projectRepositoryAccess";
import { makePullRequestOperations } from "../pullRequestOperations";
import { PullRequestService, type PullRequestServiceShape } from "../Services/PullRequestService";

const PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES = 64;
const PULL_REQUEST_DETAIL_CACHE_MAX_ENTRIES = 64;

export interface PullRequestServiceDependencies {
  readonly github: GitHubCliShape;
  readonly pins: ProjectPullRequestPinsShape;
  /** Live (non-soft-deleted) projects; see `GitHubInboxServiceDependencies.listProjects`. */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProject>, unknown>;
  /** Repository inventory, read queue, and snapshot invalidation shared with the inbox. */
  readonly inbox: GitHubInboxSharedReads;
}

export const makePullRequestService = (
  dependencies: PullRequestServiceDependencies,
): Effect.Effect<PullRequestServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mergeCapabilitiesCache = yield* makeKeyedSingleFlightCache<
      PullRequestDetail["mergeCapabilities"],
      unknown
    >({ maxEntries: PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES, ttlMs: 5 * 60_000 });
    // Keyed by repository, number, then project, so a mutation can drop one pull request (or a
    // whole repository after a stacked merge) across every project that shows it.
    const detailCache = yield* makeKeyedSingleFlightCache<PullRequestDetail, unknown>({
      maxEntries: PULL_REQUEST_DETAIL_CACHE_MAX_ENTRIES,
      ttlMs: GITHUB_ITEM_DETAIL_CACHE_TTL_MS,
    });
    const access = makeProjectRepositoryAccess({
      listProjects: dependencies.listProjects,
      resolveProjectRepositories: dependencies.inbox.resolveProjectRepositories,
    });

    const finalizeMutationCaches = (
      repository: string,
      number: number,
      options: { readonly wholeRepository: boolean },
    ) => {
      const prefix = options.wholeRepository
        ? `${repository.trim().toLowerCase()}\u0000`
        : `${githubItemCacheKey(repository, number)}\u0000`;
      return Effect.uninterruptible(
        Effect.all(
          [
            dependencies.inbox.invalidateRepository(repository),
            detailCache.invalidateWhere((key) => key.startsWith(prefix)),
          ],
          { concurrency: 2, discard: true },
        ),
      );
    };

    const loadMergeCapabilities = (cwd: string, repository: string) =>
      mergeCapabilitiesCache.get(
        repository.toLowerCase(),
        dependencies.inbox.withGitHubRead(
          dependencies.github.getRepositoryMergeCapabilities({ cwd, repository }),
        ),
      );

    const workItemSearchCache = yield* makeKeyedSingleFlightCache<
      WorkItemSearchResult,
      GitHubCliError
    >({
      maxEntries: 128,
      // Unavailable and degraded results must not pin the failure for the full
      // TTL: a user who runs `gh auth login` mid-session would otherwise keep
      // seeing the cached unavailable state. TTL 0 still lets concurrent
      // identical searches join one gh round trip, but the next request
      // immediately hits gh fresh.
      ttlMs: (result) => (result.available && result.errorHint === null ? 30_000 : 0),
    });

    const operations = makePullRequestOperations({
      github: dependencies.github,
      pins: dependencies.pins,
      findProject: access.findProject,
      validateRepository: access.validateRepository,
      validateProjectRepository: access.validateProjectRepository,
      loadMergeCapabilities,
      withGitHubRead: dependencies.inbox.withGitHubRead,
      cacheDetail: (input, load) => {
        const key = `${githubItemCacheKey(input.repository, input.number)}\u0000${input.projectId}`;
        return (input.forceRefresh ? detailCache.invalidate(key) : Effect.void).pipe(
          Effect.andThen(detailCache.get(key, load)),
        );
      },
      finalizeMutationCaches,
    });

    const searchWorkItems: PullRequestServiceShape["searchWorkItems"] = (input) => {
      const query = input.query ?? "";
      const limit = input.limit ?? 20;
      // One cache entry per repository+query+limit: repeat composer searches within
      // the TTL reuse the same gh result, and concurrent identical searches join a
      // single gh round trip instead of racing duplicate subprocesses.
      const cacheKey = `${input.cwd}\u0000${input.repository.trim().toLowerCase()}\u0000${query}\u0000${limit}`;
      return workItemSearchCache.get(
        cacheKey,
        dependencies.inbox.withGitHubRead(
          dependencies.github.searchWorkItems({
            ...input,
            query,
            limit,
          }),
        ),
      );
    };

    const workItemsAuthStatus: PullRequestServiceShape["workItemsAuthStatus"] = (input) =>
      dependencies.inbox
        .withGitHubRead(dependencies.github.getViewerLogin({ cwd: input.cwd }))
        .pipe(
          Effect.map(() => ({ status: "ready" as const, hint: null })),
          Effect.catch((error: unknown) =>
            Effect.succeed(
              ((): WorkItemAuthStatus => {
                if (error instanceof GitHubCliError) {
                  if (error.reason === "not-installed") {
                    return { status: "gh-not-installed", hint: error.detail };
                  }
                  if (error.reason === "not-authenticated") {
                    return { status: "gh-not-authenticated", hint: error.detail };
                  }
                }
                // Unclassifiable probe failures must not hide the menu item: the
                // search dialog surfaces the real error with a retry when it runs.
                return { status: "ready", hint: null };
              })(),
            ),
          ),
        );

    return {
      searchWorkItems,
      workItemsAuthStatus,
      ...operations,
    } satisfies PullRequestServiceShape;
  });

export const PullRequestServiceLive = Layer.effect(
  PullRequestService,
  Effect.gen(function* () {
    const github = yield* GitHubCli;
    const pins = yield* ProjectPullRequestPins;
    const projection = yield* ProjectionSnapshotQuery;
    const inbox = yield* GitHubInboxService;
    return yield* makePullRequestService({
      github,
      pins,
      listProjects: () =>
        projection
          .getShellSnapshot()
          .pipe(Effect.map((snapshot) => snapshot.projects.map(liveProjectFromShell))),
      inbox,
    });
  }),
);
