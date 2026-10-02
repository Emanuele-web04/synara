import type {
  GitHubInboxItem,
  GitHubInboxListError,
  GitHubInboxListResult,
  GitHubInboxRepositoryBatch,
  OrchestrationProject,
} from "@synara/contracts";
import { pullRequestListProjectContexts } from "@synara/shared/githubRepository";
import { Effect, Layer, Scope, Stream } from "effect";

import type { GitHubCliError } from "../../git/Errors";
import { GITHUB_READ_SLOTS } from "../../git/githubReadGate";
import { GitCore } from "../../git/Services/GitCore";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubIssueDetailData,
  type GitHubRepositoryInboxLookup,
} from "../../git/Services/GitHubCli";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProjectPullRequestPins,
  type ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import {
  orderPullRequestListEntries,
  projectPullRequestIdentityKey,
} from "../../pullRequests.logic";
import { makeKeyedSingleFlightCache } from "../../pullRequests/KeyedSingleFlightCache";
import {
  isGlobalGitHubCliError,
  isLiveRepositoryProject,
  liveProjectFromShell,
  makeProjectRepositoryAccess,
} from "../../pullRequests/projectRepositoryAccess";
import {
  cleanupUnconfiguredPullRequestPins,
  indexProjectRepositoryInventories,
  resolveProjectRepositoryInventories,
  type ProjectRepositoryResolution,
} from "../../pullRequests/projectRepositoryInventory";
import { recoverPinnedInboxItems } from "../../pullRequests/pullRequestPinRecovery";
import {
  resolveGitHubRepositories,
  type GitHubRepositoryInventory,
} from "../../pullRequests/repositoryResolution";
import { ServerSettingsService } from "../../serverSettings";
import {
  GITHUB_INBOX_SNAPSHOT_TTL_MS,
  GITHUB_ITEM_DETAIL_CACHE_TTL_MS,
  buildGitHubInboxItem,
  githubItemCacheKey,
  summarizeGitHubInboxError,
  type GitHubInboxRowContext,
} from "../githubInbox.logic";
import {
  makeGitHubInboxSnapshotStore,
  type GitHubInboxSnapshotEntry,
  type GitHubInboxSnapshotLoad,
} from "../githubInboxSnapshotStore";
import {
  GitHubInboxRateLimitedError,
  GitHubInboxService,
  type GitHubInboxServiceShape,
} from "../Services/GitHubInboxService";

const GITHUB_REPOSITORY_CACHE_MAX_ENTRIES = 256;
/** Local git config rarely changes; project add/remove/edit events invalidate it explicitly. */
const GITHUB_REPOSITORY_CACHE_TTL_MS = 5 * 60_000;
const PIN_RECOVERY_CACHE_MAX_ENTRIES = 64;
const ISSUE_DETAIL_CACHE_MAX_ENTRIES = 64;

export interface GitHubInboxServiceDependencies {
  readonly github: GitHubCliShape;
  readonly pins: ProjectPullRequestPinsShape;
  /**
   * Live (non-soft-deleted) projects. Deliberately not the full read model: hydrating every
   * thread body for a poll blocked the whole SQLite connection for seconds.
   */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProject>, unknown>;
  readonly resolveRepositories: (
    project: OrchestrationProject,
  ) => Effect.Effect<GitHubRepositoryInventory, unknown>;
  /** Server setting `githubInboxIncludeUpstreams`. */
  readonly includeUpstreams: () => Effect.Effect<boolean>;
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

function belongsToRepository(key: string, repository: string): boolean {
  return key.startsWith(`${repository.trim().toLowerCase()}\u0000`);
}

/** The inbox lists one repository per project (the preferred remote) unless the user opted
 * into every GitHub remote. Pin cleanup and access checks still use the full inventory. */
function scopeInboxRepositories(
  resolved: ReadonlyArray<ProjectRepositoryResolution>,
  includeUpstreams: boolean,
): ReadonlyArray<ProjectRepositoryResolution> {
  if (includeUpstreams) return resolved;
  return resolved.map((item) => ({
    ...item,
    inventory: { ...item.inventory, repositories: item.inventory.repositories.slice(0, 1) },
  }));
}

function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

type RepositoryLoad = {
  readonly repository: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly load: GitHubInboxSnapshotLoad;
};

function loadedEntry(load: GitHubInboxSnapshotLoad): GitHubInboxSnapshotEntry | null {
  return load.entry;
}

export const makeGitHubInboxService = (
  dependencies: GitHubInboxServiceDependencies,
): Effect.Effect<
  GitHubInboxServiceShape & { readonly invalidateRepositoryInventories: Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // The read queue belongs to the `gh` boundary, so inbox, detail, and git status share it.
    const withGitHubRead = dependencies.github.withRead;
    const repositoryCache = yield* makeKeyedSingleFlightCache<GitHubRepositoryInventory, unknown>({
      maxEntries: GITHUB_REPOSITORY_CACHE_MAX_ENTRIES,
      ttlMs: GITHUB_REPOSITORY_CACHE_TTL_MS,
    });
    const snapshots = yield* makeGitHubInboxSnapshotStore({
      github: dependencies.github,
      withGitHubRead,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    // Keyed by repository, state, snapshot read time, and the numbers asked for, so a pinned item
    // beyond the list cap costs one lookup per snapshot rather than one per client poll.
    const pinRecoveryCache = yield* makeKeyedSingleFlightCache<
      ReadonlyMap<number, GitHubRepositoryInboxLookup>,
      GitHubCliError
    >({ maxEntries: PIN_RECOVERY_CACHE_MAX_ENTRIES, ttlMs: GITHUB_INBOX_SNAPSHOT_TTL_MS });
    const issueDetailCache = yield* makeKeyedSingleFlightCache<
      GitHubIssueDetailData,
      GitHubCliError
    >({ maxEntries: ISSUE_DETAIL_CACHE_MAX_ENTRIES, ttlMs: GITHUB_ITEM_DETAIL_CACHE_TTL_MS });

    const resolveProjectRepositories = (project: OrchestrationProject) =>
      repositoryCache.get(project.workspaceRoot, dependencies.resolveRepositories(project));
    const access = makeProjectRepositoryAccess({
      listProjects: dependencies.listProjects,
      resolveProjectRepositories,
    });

    const invalidateRepository: GitHubInboxServiceShape["invalidateRepository"] = (repository) =>
      Effect.uninterruptible(
        Effect.all(
          [
            snapshots.invalidateRepository(repository),
            pinRecoveryCache.invalidateWhere((key) => belongsToRepository(key, repository)),
            issueDetailCache.invalidateWhere((key) => belongsToRepository(key, repository)),
          ],
          { concurrency: 3, discard: true },
        ),
      );

    const list: GitHubInboxServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        const forceRefresh = input.forceRefresh === true;
        const includeUpstreams = yield* dependencies.includeUpstreams();
        const projects = (yield* dependencies.listProjects()).filter(isLiveRepositoryProject);
        const projectById = new Map(projects.map((project) => [project.id, project]));
        if (forceRefresh) {
          yield* Effect.forEach(
            projects,
            (project) => repositoryCache.invalidate(project.workspaceRoot),
            { concurrency: "unbounded", discard: true },
          );
        }

        const [resolved, pinnedRows] = yield* Effect.all(
          [
            resolveProjectRepositoryInventories({ projects, resolve: resolveProjectRepositories }),
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
        const { errors: inventoryErrors, repositoryKeysByProject } =
          indexProjectRepositoryInventories(resolved);
        const { uniqueRepositories } = indexProjectRepositoryInventories(
          scopeInboxRepositories(resolved, includeUpstreams),
        );
        const cleanupErrors = yield* cleanupUnconfiguredPullRequestPins({
          pins: dependencies.pins,
          pinnedRows,
          projectById,
          repositoryKeysByProject,
          resolved,
        });
        const errors: GitHubInboxListError[] = [...inventoryErrors, ...cleanupErrors];
        const inventoryIncomplete = resolved.some(
          (item) => item.error !== null || !item.inventory.authoritative,
        );
        if (uniqueRepositories.size === 0) {
          return {
            viewer: null,
            items: [],
            errors,
            repositoryBatches: [],
            rateLimit: snapshots.rateLimit(),
            reviewRequestedCount: 0,
            reviewRequestedCountIncomplete: inventoryIncomplete,
          } satisfies GitHubInboxListResult;
        }

        const loads: ReadonlyArray<RepositoryLoad> = yield* Effect.forEach(
          uniqueRepositories.values(),
          ({ projects: repositoryProjects, repository }) =>
            snapshots
              .load({
                cwd: repositoryProjects[0]!.workspaceRoot,
                repository: repository.nameWithOwner,
                state: input.state,
                sort: input.sort ?? "updated",
                forceRefresh,
              })
              .pipe(
                Effect.map(
                  (load): RepositoryLoad => ({
                    repository: repository.nameWithOwner,
                    projects: repositoryProjects,
                    load,
                  }),
                ),
              ),
          { concurrency: GITHUB_READ_SLOTS },
        );

        // Nothing to show and GitHub's budget is the reason: one clear state for the whole view.
        if (
          loads.every(
            ({ load }) =>
              load._tag === "stale" && load.entry === null && load.error.reason === "rate-limited",
          )
        ) {
          const retryAt = Math.max(
            ...loads.map(({ load }) => (load._tag === "stale" ? (load.retryAt ?? 0) : 0)),
          );
          return yield* Effect.fail(
            new GitHubInboxRateLimitedError({ retryAt: new Date(retryAt).toISOString() }),
          );
        }

        const rowContexts = new Map<string, GitHubInboxRowContext>();
        const items: GitHubInboxItem[] = [];
        const repositoryBatches: GitHubInboxRepositoryBatch[] = [];
        let viewer: string | null = null;
        let reviewRequestedCount = 0;
        let reviewRequestedCountIncomplete = inventoryIncomplete;
        for (const { repository, projects: repositoryProjects, load } of loads) {
          const entry = loadedEntry(load);
          if (load._tag === "stale") {
            for (const project of repositoryProjects) {
              errors.push({
                projectId: project.id,
                projectTitle: project.title,
                repository,
                message: summarizeGitHubInboxError(load.error),
                reason: load.error.reason === "rate-limited" ? "rate-limited" : "unavailable",
                retryAt: toIso(load.retryAt),
                showingCachedData: entry !== null,
              });
            }
            if (!entry) reviewRequestedCountIncomplete = true;
          }
          if (!entry) continue;
          const { snapshot } = entry;
          viewer ??= snapshot.viewer;
          const context: GitHubInboxRowContext = {
            repository,
            projects: repositoryProjects,
            viewer: snapshot.viewer,
            involvedNumbers: new Set(snapshot.involvedNumbers),
            reviewRequestedNumbers: new Set(snapshot.reviewRequestedNumbers),
            pinnedKeys,
          };
          rowContexts.set(repository.toLowerCase(), context);
          for (const pullRequest of snapshot.pullRequests) {
            items.push(buildGitHubInboxItem(context, { kind: "pullRequest", item: pullRequest }));
          }
          for (const issue of snapshot.issues) {
            items.push(buildGitHubInboxItem(context, { kind: "issue", item: issue }));
          }
          repositoryBatches.push({
            repository,
            projectIds: repositoryProjects.map((project) => project.id),
            truncatedPullRequests: snapshot.truncatedPullRequests,
            truncatedIssues: snapshot.truncatedIssues,
            totalPullRequests: snapshot.totalPullRequests,
            totalIssues: snapshot.totalIssues,
            fetchedAt: new Date(entry.fetchedAt).toISOString(),
          });
          if (input.state === "open") reviewRequestedCount += snapshot.reviewRequestedCount;
        }

        const presentKeys = new Set(
          items.flatMap((item) =>
            pullRequestListProjectContexts(item).map((context) =>
              projectPullRequestIdentityKey({
                projectId: context.projectId,
                repository: item.repository,
                number: item.number,
              }),
            ),
          ),
        );
        const recovery = yield* recoverPinnedInboxItems({
          state: input.state,
          pins: pinnedRows,
          pinStore: dependencies.pins,
          presentKeys,
          recoveryContexts: loads.flatMap(({ repository, projects: repositoryProjects, load }) => {
            const entry = loadedEntry(load);
            return entry
              ? [
                  {
                    cwd: repositoryProjects[0]!.workspaceRoot,
                    repository,
                    projects: repositoryProjects,
                    truncated:
                      entry.snapshot.truncatedPullRequests || entry.snapshot.truncatedIssues,
                    fetchedAt: entry.fetchedAt,
                  },
                ]
              : [];
          }),
          repositoryKeysByProject,
          projectById,
          isGlobalError: isGlobalGitHubCliError,
          loadItems: (context, numbers) =>
            pinRecoveryCache.get(
              [
                context.repository.toLowerCase(),
                input.state,
                String(context.fetchedAt),
                numbers.join(","),
              ].join("\u0000"),
              withGitHubRead(
                dependencies.github.getRepositoryInboxItems({
                  cwd: context.cwd,
                  repository: context.repository,
                  numbers,
                }),
              ),
            ),
          buildItem: (context, lookup) =>
            buildGitHubInboxItem(rowContexts.get(context.repository.toLowerCase())!, lookup.item),
          describeError: summarizeGitHubInboxError,
        });

        return {
          viewer,
          items: orderPullRequestListEntries([...items, ...recovery.items]),
          errors: [...errors, ...recovery.errors],
          repositoryBatches,
          rateLimit: snapshots.rateLimit(),
          reviewRequestedCount,
          reviewRequestedCountIncomplete,
        } satisfies GitHubInboxListResult;
      });

    const issueDetail: GitHubInboxServiceShape["issueDetail"] = (input) =>
      Effect.gen(function* () {
        const project = yield* access.findProject(input.projectId);
        const repository = yield* access.validateProjectRepository(project, input.repository);
        const key = githubItemCacheKey(repository, input.number);
        if (input.forceRefresh === true) yield* issueDetailCache.invalidate(key);
        const detail = yield* issueDetailCache.get(
          key,
          withGitHubRead(
            dependencies.github.getIssueDetail({
              cwd: project.workspaceRoot,
              repository,
              number: input.number,
            }),
          ),
        );
        return {
          projectId: project.id,
          projectTitle: project.title,
          workspaceRoot: project.workspaceRoot,
          repository,
          number: detail.number,
          title: detail.title,
          url: detail.url,
          author: detail.author,
          state: detail.state,
          stateReason: detail.stateReason,
          labels: detail.labels,
          assignees: detail.assignees,
          commentCount: detail.commentCount,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          closedAt: detail.closedAt,
          body: detail.body,
          comments: detail.comments,
          commentsTruncated: detail.commentsTruncated,
        };
      });

    const issueComment: GitHubInboxServiceShape["issueComment"] = (input) =>
      Effect.gen(function* () {
        const project = yield* access.findProject(input.projectId);
        const repository = yield* access.validateProjectRepository(project, input.repository);
        yield* dependencies.github
          .commentOnIssue({
            cwd: project.workspaceRoot,
            repository,
            number: input.number,
            body: input.body,
          })
          .pipe(Effect.ensuring(invalidateRepository(repository)));
        return {
          projectId: project.id,
          repository,
          number: input.number,
          workspaceRoot: project.workspaceRoot,
        };
      });

    return {
      list,
      issueDetail,
      issueComment,
      resolveProjectRepositories,
      withGitHubRead,
      invalidateRepository,
      invalidateRepositoryInventories: repositoryCache.invalidateAll,
    };
  });

export const GitHubInboxServiceLive = Layer.effect(
  GitHubInboxService,
  Effect.gen(function* () {
    const git = yield* GitCore;
    const github = yield* GitHubCli;
    const pins = yield* ProjectPullRequestPins;
    const projection = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const service = yield* makeGitHubInboxService({
      github,
      pins,
      listProjects: () =>
        projection
          .getShellSnapshot()
          .pipe(Effect.map((snapshot) => snapshot.projects.map(liveProjectFromShell))),
      resolveRepositories: (project) => resolveGitHubRepositories(git, project.workspaceRoot),
      includeUpstreams: () =>
        settings.getSettings.pipe(
          Effect.map((current) => current.githubInboxIncludeUpstreams),
          Effect.catch(() => Effect.succeed(false)),
        ),
    });
    // Adding, removing, or re-rooting a project changes which repositories the inbox reads.
    // Project events are rare, so dropping the whole (local git config) inventory cache is cheap.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "project.created" ||
        event.type === "project.meta-updated" ||
        event.type === "project.deleted"
          ? service.invalidateRepositoryInventories
          : Effect.void,
      ),
    );
    return service;
  }),
);
