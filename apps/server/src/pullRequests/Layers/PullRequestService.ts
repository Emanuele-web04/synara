import {
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestDetail,
  type PullRequestInvolvement,
  type PullRequestListEntry,
  type PullRequestsListResult,
} from "@synara/contracts";
import { coalescePullRequestListEntries } from "@synara/shared/pullRequestList";
import { Effect, Layer, Scope, Semaphore } from "effect";

import { ServerConfig } from "../../config";
import { GitHostCliError } from "../../git/Errors";
import { GitCore } from "../../git/Services/GitCore";
import {
  GitHostCli,
  type GitHostCliRouterShape,
  type GitHostCliShape,
  type GitHostPullRequestListItem,
  type GitHostSelection,
} from "../../git/Services/GitHostCli";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProjectPullRequestPins,
  type ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import {
  buildPullRequestListEntry,
  isValidRepositoryReference,
  isViewerReviewRequested,
  orderPullRequestListEntries,
  projectPullRequestIdentityKey,
  pullRequestListCacheKey,
  pullRequestListForceRefreshCacheKeys,
  repositoryPullRequestIdentityKey,
  shouldLoadReviewingCompanion,
} from "../../pullRequests.logic";
import { makeKeyedSingleFlightCache } from "../KeyedSingleFlightCache";
import { PullRequestService, type PullRequestServiceShape } from "../Services/PullRequestService";
import { resolveRepositories, type RepositoryInventory } from "../../git/repositoryResolution";
import {
  cleanupUnconfiguredPullRequestPins,
  indexProjectRepositoryInventories,
  resolveProjectRepositoryInventories,
} from "../projectRepositoryInventory";
import { makePullRequestOperations } from "../pullRequestOperations";
import {
  PULL_REQUEST_REVIEW_MATCH_LIMIT,
  recoverPinnedPullRequests,
  type RecoveredPullRequest,
  type ReviewRequestedMatches,
} from "../pullRequestPinRecovery";

export { PULL_REQUEST_PIN_RECOVERY_LIMIT } from "../pullRequestPinRecovery";

const REPOSITORY_CACHE_MAX_ENTRIES = 256;
const PULL_REQUEST_LIST_CACHE_MAX_ENTRIES = 512;
const PULL_REQUEST_PIN_ITEM_CACHE_MAX_ENTRIES = 128;
const PULL_REQUEST_REVIEW_MATCH_CACHE_MAX_ENTRIES = 32;
const PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES = 64;
const VIEWER_CACHE_MAX_ENTRIES = 8;

type PullRequestListBatch = {
  readonly entries: ReadonlyArray<GitHostPullRequestListItem>;
  readonly truncated: boolean;
};

type PullRequestListError = PullRequestsListResult["errors"][number];

export interface PullRequestServiceDependencies {
  readonly homeDir: string;
  readonly gitHost: GitHostCliRouterShape;
  readonly pins: ProjectPullRequestPinsShape;
  /**
   * Live (non-soft-deleted) projects. Deliberately not the full read model: the PR
   * service only ever reads `snapshot.projects`, and hydrating every thread body for a
   * five-minute review-count poll blocked the whole SQLite connection for seconds.
   */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProject>, unknown>;
  readonly resolveRepositories: (
    project: OrchestrationProject,
  ) => Effect.Effect<RepositoryInventory, unknown>;
}

/**
 * The shell snapshot already excludes soft-deleted projects, so the field it omits is
 * known to be null. Restoring it keeps the shared PR helpers on one project type.
 */
export function liveProjectFromShell(shell: OrchestrationProjectShell): OrchestrationProject {
  return { ...shell, deletedAt: null };
}

/** Exact host error shape for a PR number that is known not to exist. Generic 404/auth failures
 * are deliberately not classified as absence, so permission and network failures remain visible. */
export function isDefinitivePullRequestNotFound(error: GitHostCliError): boolean {
  if (isGlobalGitHostCliError(error)) return false;
  // The glab layer classifies GitLab's 404 precisely, so it needs no message sniffing.
  if (error.reason === "not-found") return true;
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("could not resolve to a pullrequest") ||
    /pull request(?: with (?:the )?number)?[^\n]*(?:not found|does not exist)/i.test(
      error.detail,
    ) ||
    /no pull request[^\n]*found/i.test(error.detail)
  );
}

export function pullRequestCacheKeyBelongsToRepository(
  cacheKey: string,
  repository: string,
  separator: ":" | "\u0000" = ":",
): boolean {
  return cacheKey.startsWith(`${repository.trim().toLowerCase()}${separator}`);
}

// Boolean rather than a type predicate: it is called on values already typed
// GitHostCliError, where a predicate would narrow the false branch to `never`.
function isGlobalGitHostCliError(error: unknown): boolean {
  return (
    error instanceof GitHostCliError &&
    (error.reason === "not-installed" || error.reason === "not-authenticated")
  );
}

export const makePullRequestService = (
  dependencies: PullRequestServiceDependencies,
): Effect.Effect<PullRequestServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    // One server-wide PR service can receive overlapping all-project requests. Keep host reads
    // bounded across requests and cache keys, while mutations bypass this queue so user actions do
    // not wait behind background list warming.
    const hostReadSlots = yield* Semaphore.make(6);
    const withHostRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      hostReadSlots.withPermits(1)(effect);
    const repositoryCache = yield* makeKeyedSingleFlightCache<RepositoryInventory, unknown>({
      maxEntries: REPOSITORY_CACHE_MAX_ENTRIES,
      ttlMs: 30_000,
    });
    // One entry per selected host: a workspace mixing GitHub and GitLab remotes has two viewers.
    const viewerCache = yield* makeKeyedSingleFlightCache<string, GitHostCliError>({
      maxEntries: VIEWER_CACHE_MAX_ENTRIES,
      ttlMs: 5 * 60_000,
    });
    const listCache = yield* makeKeyedSingleFlightCache<PullRequestListBatch, GitHostCliError>({
      maxEntries: PULL_REQUEST_LIST_CACHE_MAX_ENTRIES,
      ttlMs: 30_000,
    });
    const itemCache = yield* makeKeyedSingleFlightCache<RecoveredPullRequest, GitHostCliError>({
      maxEntries: PULL_REQUEST_PIN_ITEM_CACHE_MAX_ENTRIES,
      ttlMs: (result) => (result._tag === "not-found" ? 30_000 : 15_000),
    });
    const reviewMatchCache = yield* makeKeyedSingleFlightCache<
      ReviewRequestedMatches,
      GitHostCliError
    >({ maxEntries: PULL_REQUEST_REVIEW_MATCH_CACHE_MAX_ENTRIES, ttlMs: 15_000 });
    const mergeCapabilitiesCache = yield* makeKeyedSingleFlightCache<
      PullRequestDetail["mergeCapabilities"],
      GitHostCliError
    >({ maxEntries: PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES, ttlMs: 5 * 60_000 });

    const pullRequestMutationCacheFinalizer = (
      repository: string,
      number: number,
      options: { readonly invalidateReviewMatches: boolean },
    ) =>
      Effect.uninterruptible(
        Effect.all(
          [
            listCache.invalidateWhere((key) =>
              pullRequestCacheKeyBelongsToRepository(key, repository),
            ),
            ...(options.invalidateReviewMatches
              ? [
                  reviewMatchCache.invalidateWhere((key) =>
                    pullRequestCacheKeyBelongsToRepository(key, repository),
                  ),
                ]
              : []),
            itemCache.invalidate(repositoryPullRequestIdentityKey({ repository, number })),
          ],
          { concurrency: 3, discard: true },
        ),
      );

    const resolveProjectRepositories = (project: OrchestrationProject) =>
      repositoryCache.get(project.workspaceRoot, dependencies.resolveRepositories(project));

    const loadViewer = (selection: GitHostSelection) =>
      viewerCache.get(
        `${selection.kind}\u0000${selection.host}`,
        withHostRead(
          selection.cli.getViewerLogin({ cwd: dependencies.homeDir, host: selection.host }),
        ),
      );

    /** Selection is a pure parse of the reference, so this only ever costs the viewer lookup. */
    const resolveHostContext = (repository: string) =>
      dependencies.gitHost
        .forRepository(repository)
        .pipe(
          Effect.flatMap((selection) =>
            loadViewer(selection).pipe(Effect.map((viewer) => ({ selection, viewer }))),
          ),
        );

    const loadRepositoryPullRequests = (
      cli: GitHostCliShape,
      cwd: string,
      repository: string,
      state: "open" | "closed" | "merged",
      involvement: PullRequestInvolvement,
      viewer: string,
    ) => {
      const cacheKey = pullRequestListCacheKey(repository, state, involvement, viewer);
      const limit = 50;
      return listCache.get(
        cacheKey,
        withHostRead(
          cli.listRepositoryPullRequests({
            cwd,
            repository,
            state,
            involvement,
            viewer,
            limit: limit + 1,
          }),
        ).pipe(
          Effect.map((batch) => ({
            entries: batch.entries.slice(0, limit),
            // Cardinality must be measured before tolerant decoding drops malformed entries.
            // Otherwise a raw 51-item response can look complete and strand a pin at the cap.
            truncated: batch.rawCount > limit,
          })),
        ),
      );
    };

    const loadPullRequestListItem = (
      cli: GitHostCliShape,
      cwd: string,
      repository: string,
      number: number,
    ) => {
      const key = repositoryPullRequestIdentityKey({ repository, number });
      return itemCache.get(
        key,
        withHostRead(cli.getPullRequestListItem({ cwd, repository, number })).pipe(
          Effect.map((item): RecoveredPullRequest => ({ _tag: "found", item })),
          Effect.catch((error) =>
            isDefinitivePullRequestNotFound(error)
              ? Effect.succeed<RecoveredPullRequest>({ _tag: "not-found" })
              : Effect.fail(error),
          ),
        ),
      );
    };

    const loadReviewRequestedPullRequestNumbers = (
      cli: GitHostCliShape,
      cwd: string,
      repository: string,
      viewer: string,
    ) => {
      const key = pullRequestListCacheKey(repository, "open", "reviewing", viewer);
      return reviewMatchCache.get(
        key,
        withHostRead(
          cli.listReviewRequestedPullRequestNumbers({
            cwd,
            repository,
            viewer,
            limit: PULL_REQUEST_REVIEW_MATCH_LIMIT,
          }),
        ).pipe(
          Effect.map(
            (numbers): ReviewRequestedMatches => ({
              numbers: new Set(numbers),
              incomplete: numbers.length >= PULL_REQUEST_REVIEW_MATCH_LIMIT,
            }),
          ),
        ),
      );
    };

    const findProject = (projectId: ProjectId) =>
      dependencies.listProjects().pipe(
        Effect.flatMap((allProjects) => {
          const project = allProjects.find(
            (candidate) =>
              candidate.id === projectId &&
              candidate.kind === "project" &&
              candidate.deletedAt === null,
          );
          return project ? Effect.succeed(project) : Effect.fail(new Error("Project not found."));
        }),
      );

    const validatePullRequestRepository = (repository: string) => {
      const normalized = repository.trim();
      return isValidRepositoryReference(normalized)
        ? Effect.succeed(normalized)
        : Effect.fail(new Error("Invalid repository identity."));
    };

    const validateProjectPullRequestRepository = (
      project: OrchestrationProject,
      repositoryInput: string,
    ) =>
      Effect.gen(function* () {
        const repository = yield* validatePullRequestRepository(repositoryInput);
        const inventory = yield* resolveProjectRepositories(project);
        if (!inventory.authoritative) {
          return yield* Effect.fail(new Error("Repository inventory is unavailable."));
        }
        const matched = inventory.repositories.find(
          (candidate) => candidate.reference.toLowerCase() === repository.toLowerCase(),
        );
        if (!matched) {
          return yield* Effect.fail(
            new Error("Repository does not belong to the selected project."),
          );
        }
        return matched.reference;
      });

    const loadMergeCapabilities = (cwd: string, repository: string) =>
      mergeCapabilitiesCache.get(
        repository.toLowerCase(),
        dependencies.gitHost
          .forRepository(repository)
          .pipe(
            Effect.flatMap((selection) =>
              withHostRead(selection.cli.getRepositoryMergeCapabilities({ cwd, repository })),
            ),
          ),
      );

    const list: PullRequestServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        const forceRefresh = input.forceRefresh === true;
        const involvement = input.involvement ?? "all";
        const projects = (yield* dependencies.listProjects()).filter(
          (project) =>
            project.deletedAt === null &&
            project.kind === "project" &&
            (input.projectId == null || project.id === input.projectId),
        );
        const projectById = new Map(projects.map((project) => [project.id, project]));
        if (forceRefresh) {
          // The viewer participates in involvement filtering and list cache keys. A manual refresh
          // must observe a recent `gh auth switch/login` instead of retaining the previous account
          // until the normal five-minute viewer TTL expires.
          yield* viewerCache.invalidateAll;
          yield* Effect.forEach(
            projects,
            (project) => repositoryCache.invalidate(project.workspaceRoot),
            { concurrency: "unbounded", discard: true },
          );
        }

        const [resolved, pinnedRows] = yield* Effect.all(
          [
            resolveProjectRepositoryInventories({
              projects,
              resolve: resolveProjectRepositories,
            }),
            dependencies.pins.listByProjectIds({
              projectIds: projects.map((project) => project.id),
            }),
          ],
          { concurrency: 2 },
        );
        const pinnedKeys = new Set(
          pinnedRows.map((row) =>
            projectPullRequestIdentityKey({
              projectId: row.projectId,
              repository: row.repositoryKey,
              number: row.number,
            }),
          ),
        );

        const {
          errors: inventoryErrors,
          repositoryKeysByProject,
          uniqueRepositories,
        } = indexProjectRepositoryInventories(resolved);
        const cleanupErrors = yield* cleanupUnconfiguredPullRequestPins({
          pins: dependencies.pins,
          pinnedRows,
          projectById,
          repositoryKeysByProject,
          resolved,
        });
        const errors: PullRequestListError[] = [...inventoryErrors, ...cleanupErrors];
        if (uniqueRepositories.size === 0) {
          return { viewer: null, entries: [], errors, repositoryBatches: [] };
        }

        // A workspace can mix hosts, so each repository is served by its own CLI and viewer. The
        // result's top-level viewer is the first repository's, which is what the client uses to
        // label "authored by me" groups; server-side involvement filtering stays per host.
        const primaryRepository = [...uniqueRepositories.values()][0]!.repository.reference;
        const viewer = (yield* resolveHostContext(primaryRepository)).viewer;

        const batches = yield* Effect.forEach(
          uniqueRepositories.values(),
          ({ projects: repositoryProjects, repository }) =>
            Effect.gen(function* () {
              const cwd = repositoryProjects[0]!.workspaceRoot;
              const host = yield* resolveHostContext(repository.reference);
              if (forceRefresh) {
                yield* Effect.forEach(
                  pullRequestListForceRefreshCacheKeys({
                    repository: repository.reference,
                    state: input.state,
                    viewer: host.viewer,
                  }),
                  (key) => listCache.invalidate(key),
                  { concurrency: "unbounded", discard: true },
                );
              }
              const [result, reviewingResult] = yield* Effect.all(
                [
                  loadRepositoryPullRequests(
                    host.selection.cli,
                    cwd,
                    repository.reference,
                    input.state,
                    involvement,
                    host.viewer,
                  ),
                  shouldLoadReviewingCompanion(input.state, involvement)
                    ? loadRepositoryPullRequests(
                        host.selection.cli,
                        cwd,
                        repository.reference,
                        input.state,
                        "reviewing",
                        host.viewer,
                      )
                    : Effect.succeed(null),
                ],
                { concurrency: 2 },
              );
              const reviewingNumbers = new Set(
                reviewingResult?.entries.map((pullRequest) => pullRequest.number) ?? [],
              );
              return {
                entries: repositoryProjects.flatMap((project) =>
                  result.entries.map(
                    (pullRequest): PullRequestListEntry =>
                      buildPullRequestListEntry({
                        project,
                        repository: repository.reference,
                        pullRequest,
                        viewerReviewRequested: isViewerReviewRequested(
                          pullRequest.author,
                          pullRequest.reviewRequestLogins,
                          host.viewer,
                          involvement === "reviewing" || reviewingNumbers.has(pullRequest.number),
                        ),
                        isPinned: pinnedKeys.has(
                          projectPullRequestIdentityKey({
                            projectId: project.id,
                            repository: repository.reference,
                            number: pullRequest.number,
                          }),
                        ),
                      }),
                  ),
                ),
                // The list cap belongs to the remote repository. Reporting one batch per local
                // worktree made the all-projects UI overcount truncated repositories.
                repositoryBatches: repositoryProjects.slice(0, 1).map((project) => ({
                  projectId: project.id,
                  projectTitle: project.title,
                  repository: repository.reference,
                  truncated: result.truncated,
                })),
                errors: [] as PullRequestListError[],
                recovery: {
                  cwd,
                  repository: repository.reference,
                  projects: repositoryProjects,
                  truncated: result.truncated,
                  reviewingNumbers,
                  reviewingTruncated: reviewingResult?.truncated === true,
                },
              };
            }).pipe(
              Effect.catch((error) =>
                isGlobalGitHostCliError(error)
                  ? Effect.fail(error)
                  : Effect.succeed({
                      entries: [] as PullRequestListEntry[],
                      repositoryBatches: [],
                      errors: repositoryProjects.map((project) => ({
                        projectId: project.id,
                        projectTitle: project.title,
                        message: error.message,
                      })),
                      recovery: null,
                    }),
              ),
            ),
          { concurrency: 6 },
        );
        const batchEntries = batches.flatMap((batch) => batch.entries);
        const recovery = yield* recoverPinnedPullRequests({
          state: input.state,
          involvement,
          viewer,
          forceRefresh,
          pins: pinnedRows,
          pinStore: dependencies.pins,
          batchEntries,
          recoveryContexts: batches.flatMap((batch) => (batch.recovery ? [batch.recovery] : [])),
          repositoryKeysByProject,
          projectById,
          isGlobalError: isGlobalGitHostCliError,
          invalidateReviewMatches: (repository, viewerLogin) =>
            reviewMatchCache.invalidate(
              pullRequestListCacheKey(repository, "open", "reviewing", viewerLogin),
            ),
          loadReviewMatches: (cwd, repository, viewerLogin) =>
            dependencies.gitHost
              .forRepository(repository)
              .pipe(
                Effect.flatMap((selection) =>
                  loadReviewRequestedPullRequestNumbers(
                    selection.cli,
                    cwd,
                    repository,
                    viewerLogin,
                  ),
                ),
              ),
          invalidateItem: (key) => itemCache.invalidate(key),
          loadItem: (cwd, repository, number) =>
            dependencies.gitHost
              .forRepository(repository)
              .pipe(
                Effect.flatMap((selection) =>
                  loadPullRequestListItem(selection.cli, cwd, repository, number),
                ),
              ),
        });

        const visibleEntries = coalescePullRequestListEntries([
          ...batchEntries,
          ...recovery.entries,
        ]);
        return {
          viewer,
          entries: orderPullRequestListEntries(visibleEntries),
          errors: [...errors, ...batches.flatMap((batch) => batch.errors), ...recovery.errors],
          repositoryBatches: batches.flatMap((batch) => batch.repositoryBatches),
        };
      });

    const reviewRequestCount: PullRequestServiceShape["reviewRequestCount"] = (input) =>
      Effect.gen(function* () {
        const projects = (yield* dependencies.listProjects()).filter(
          (project) =>
            project.deletedAt === null &&
            project.kind === "project" &&
            (input.projectId == null || project.id === input.projectId),
        );
        const resolved = yield* resolveProjectRepositoryInventories({
          projects,
          resolve: resolveProjectRepositories,
        });
        const { uniqueRepositories } = indexProjectRepositoryInventories(resolved);
        const inventoryIncomplete = resolved.some(
          (item) => item.error !== null || !item.inventory.authoritative,
        );
        if (uniqueRepositories.size === 0) {
          return { count: 0, incomplete: inventoryIncomplete };
        }

        const repositoryCounts = yield* Effect.forEach(
          uniqueRepositories.values(),
          ({ projects: repositoryProjects, repository }) =>
            resolveHostContext(repository.reference)
              .pipe(
                Effect.flatMap((host) =>
                  loadReviewRequestedPullRequestNumbers(
                    host.selection.cli,
                    repositoryProjects[0]!.workspaceRoot,
                    repository.reference,
                    host.viewer,
                  ),
                ),
              )
              .pipe(
                Effect.map((matches) => ({
                  count: matches.numbers.size,
                  incomplete: matches.incomplete,
                })),
                Effect.catch((error) =>
                  isGlobalGitHostCliError(error)
                    ? Effect.fail(error)
                    : Effect.succeed({ count: 0, incomplete: true }),
                ),
              ),
          { concurrency: 6 },
        );

        return {
          count: repositoryCounts.reduce((total, result) => total + result.count, 0),
          incomplete: inventoryIncomplete || repositoryCounts.some((result) => result.incomplete),
        };
      });

    const operations = makePullRequestOperations({
      gitHost: dependencies.gitHost,
      pins: dependencies.pins,
      findProject,
      validateRepository: validatePullRequestRepository,
      validateProjectRepository: validateProjectPullRequestRepository,
      loadMergeCapabilities,
      withHostRead,
      finalizeMutationCaches: pullRequestMutationCacheFinalizer,
    });

    return {
      list,
      reviewRequestCount,
      ...operations,
    } satisfies PullRequestServiceShape;
  });

export const PullRequestServiceLive = Layer.effect(
  PullRequestService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const git = yield* GitCore;
    const gitHost = yield* GitHostCli;
    const pins = yield* ProjectPullRequestPins;
    const projection = yield* ProjectionSnapshotQuery;
    return yield* makePullRequestService({
      homeDir: config.homeDir,
      gitHost,
      pins,
      listProjects: () =>
        projection
          .getShellSnapshot()
          .pipe(Effect.map((snapshot) => snapshot.projects.map(liveProjectFromShell))),
      resolveRepositories: (project) =>
        gitHost.knownGitLabHosts.pipe(
          Effect.flatMap((gitlabHosts) =>
            resolveRepositories(git, project.workspaceRoot, { gitlabHosts }),
          ),
        ),
    });
  }),
);
