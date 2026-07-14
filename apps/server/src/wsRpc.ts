import { execFile } from "node:child_process";

import {
  CommandId,
  DEFAULT_TERMINAL_ID,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  WsRpcError,
  WsRpcGroup,
  PullRequestsUnavailableError,
  type OrchestrationProject,
  type ProjectId,
  type PullRequestDetail,
  type PullRequestInvolvement,
  type PullRequestListEntry,
  type GitActionProgressEvent,
  type OrchestrationEvent,
  type ProjectDevServerEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerDiagnosticsResult,
  type ServerLifecycleStreamEvent,
} from "@synara/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@synara/shared/githubRepository";
import { clamp } from "effect/Number";
import { Effect, FileSystem, Layer, Option, Path, Queue, Schema, Semaphore, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { AutomationService } from "./automation/Services/AutomationService";
import { authErrorResponse, makeEffectAuthRequest } from "./auth/http";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils";
import { ServerConfig } from "./config";
import { realpathNearestExisting } from "./realpathNearestExisting";
import { listStudioThreadOutputs } from "./studioOutputs";
import {
  ensureStudioWorkspaceInstructionsFiles,
  STUDIO_WORKSPACE_SUBDIRECTORIES,
} from "./studioWorkspaceScaffold";
import { DevServerManager, findProjectDevServerForLocalServer } from "./devServerManager";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { GitHubCli, type GitHubPullRequestListItem } from "./git/Services/GitHubCli";
import { GitHubCliError } from "./git/Errors";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { TextGeneration } from "./git/Services/TextGeneration";
import { Keybindings } from "./keybindings";
import { createLocalPreviewGrant } from "./localImageFiles";
import { listLocalServers, stopLocalServer } from "./localServerMonitor";
import { Open, resolveAvailableEditors } from "./open";
import { makeDispatchCommandNormalizer } from "./orchestration/dispatchCommandNormalization";
import { makeImportThreadHandler } from "./orchestration/importThreadRoute";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { shouldPublishThreadShellForEvent } from "./orchestration/threadShellEvents";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { discoverSkillsCatalog, synaraSkillsDir } from "./provider/skillsCatalog";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { listProviderUsage } from "./providerUsage";
import { getProviderUsageSnapshot } from "./providerUsageSnapshot";
import { ProfileStatsQuery } from "./profileStats";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { TerminalThreadTitleTracker } from "./terminal/terminalThreadTitleTracker";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { shouldRejectUntrustedRequestOrigin } from "./trustedOrigins";
import { bufferLiveUiStream, type LiveUiStreamDropReport } from "./wsStreamBackpressure";
import {
  isPullRequestMergeMethodAllowed,
  isViewerReviewRequested,
  isValidGitHubRepositoryNameWithOwner,
  pullRequestListCacheKey,
} from "./pullRequests.logic";

const MAX_DIAGNOSTIC_CHILD_PROCESSES = 80;
const MAX_DIAGNOSTIC_ARGS_CHARS = 500;

// Relative subdirectories scaffolded under a freshly created chat container workspace root.
// The Studio layout lives in studioWorkspaceScaffold.ts alongside its instruction files.
const CHAT_WORKSPACE_SUBDIRECTORIES = ["work", "outputs"] as const;

interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly virtualSizeBytes: number;
  readonly command: string;
  readonly args: string;
}

function normalizeGitRemoteName(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized !== "." ? normalized : null;
}

function uniqueRemoteCandidates(candidates: ReadonlyArray<string | null>): string[] {
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeGitRemoteName(candidate);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

function readGitStdoutOrNull(
  git: GitCoreShape,
  cwd: string,
  operation: string,
  args: ReadonlyArray<string>,
) {
  return git
    .execute({
      operation,
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: 16_384,
    })
    .pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        const trimmed = result.stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );
}

function parseGitRemoteNames(stdout: string | null): string[] {
  if (!stdout) {
    return [];
  }
  return stdout
    .split(/\r?\n/g)
    .map((line) => normalizeGitRemoteName(line))
    .filter((remoteName): remoteName is string => remoteName !== null);
}

interface GitHubRepositoryLink {
  readonly nameWithOwner: string;
  readonly url: string;
}

// Resolves every GitHub remote in preference order. The first entry remains the preferred
// repository link; the complete set drives PR listing and binds detail/action RPCs to repositories
// actually configured for the project.
function resolveGitHubRepositories(git: GitCoreShape, cwd: string) {
  return Effect.gen(function* () {
    const branch = yield* readGitStdoutOrNull(git, cwd, "WsRpc.githubRepository.currentBranch", [
      "branch",
      "--show-current",
    ]);
    const remoteNames = parseGitRemoteNames(
      yield* readGitStdoutOrNull(git, cwd, "WsRpc.githubRepository.remotes", ["remote"]),
    );
    const branchRemote = branch ? yield* git.readConfigValue(cwd, `branch.${branch}.remote`) : null;
    const pushDefaultRemote = yield* git.readConfigValue(cwd, "remote.pushDefault");

    const repositories: GitHubRepositoryLink[] = [];
    const seen = new Set<string>();
    for (const remoteName of uniqueRemoteCandidates([
      branchRemote,
      pushDefaultRemote,
      "origin",
      ...remoteNames,
    ])) {
      const remoteUrl = yield* git.readConfigValue(cwd, `remote.${remoteName}.url`);
      const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      const key = nameWithOwner?.toLowerCase() ?? null;
      if (nameWithOwner && key && !seen.has(key)) {
        seen.add(key);
        repositories.push({
          nameWithOwner,
          url: `https://github.com/${nameWithOwner}`,
        });
      }
    }

    return repositories;
  });
}

// Resolves the preferred GitHub repository link from Git config without running full status.
function resolveGitHubRepository(git: GitCoreShape, cwd: string) {
  return resolveGitHubRepositories(git, cwd).pipe(
    Effect.map((repositories) => ({ repository: repositories[0] ?? null, repositories })),
  );
}

function truncateDiagnosticText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 15))}... [truncated]` : value;
}

function redactProcessArgs(args: string): string {
  const redacted = args
    .replace(
      /(--?(?:api[-_]?key|auth|authorization|key|password|secret|token)(?:=|\s+))(\S+)/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  return truncateDiagnosticText(redacted, MAX_DIAGNOSTIC_ARGS_CHARS);
}

function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      virtualSizeBytes: Number(match[4]) * 1024,
      command: match[5] ?? "",
      args: redactProcessArgs(match[6] ?? ""),
    });
  }
  return rows;
}

function collectDescendantProcesses(
  rows: readonly ProcessTableRow[],
  rootPid: number,
): ProcessTableRow[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const descendants: ProcessTableRow[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const row = stack.pop()!;
    descendants.push(row);
    stack.push(...(childrenByParent.get(row.pid) ?? []));
  }
  return descendants.toSorted((left, right) => right.rssBytes - left.rssBytes);
}

function readDescendantProcesses(rootPid: number): Promise<ProcessTableRow[]> {
  if (process.platform === "win32") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,rss=,vsz=,comm=,args="],
      { maxBuffer: 2 * 1024 * 1024 },
      (_error, stdout) => {
        resolve(collectDescendantProcesses(parseProcessTable(stdout), rootPid));
      },
    );
  });
}

function toWsRpcError(cause: unknown, fallbackMessage: string) {
  return Schema.is(WsRpcError)(cause)
    ? cause
    : new WsRpcError({
        message:
          cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
        cause,
      });
}

const failLiveUiStreamForSnapshotResync = (report: LiveUiStreamDropReport) =>
  Effect.fail(
    new WsRpcError({
      message: `${report.message}; restarting stream to refresh snapshot.`,
    }),
  );

// Must mirror the cases of toShellStreamEvent: events rejected here are dropped
// before the live-UI buffer so the sliding window only holds events that can
// actually project to a shell update.
function isShellRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "thread.deleted":
      return true;
    default:
      return event.aggregateKind === "thread" && shouldPublishThreadShellForEvent(event);
  }
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.conversation-rolled-back"
      | "thread.session-set"
      | "thread.meta-updated"
      | "thread.pinned-message-added"
      | "thread.pinned-message-removed"
      | "thread.pinned-message-done-set"
      | "thread.pinned-message-label-set"
      | "thread.marker-added"
      | "thread.marker-removed"
      | "thread.marker-done-set"
      | "thread.marker-label-set"
      | "thread.archived"
      | "thread.unarchived";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.conversation-rolled-back" ||
    event.type === "thread.session-set" ||
    event.type === "thread.meta-updated" ||
    event.type === "thread.pinned-message-added" ||
    event.type === "thread.pinned-message-removed" ||
    event.type === "thread.pinned-message-done-set" ||
    event.type === "thread.pinned-message-label-set" ||
    event.type === "thread.marker-added" ||
    event.type === "thread.marker-removed" ||
    event.type === "thread.marker-done-set" ||
    event.type === "thread.marker-label-set" ||
    event.type === "thread.archived" ||
    event.type === "thread.unarchived"
  );
}

export const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const automationService = yield* AutomationService;
      const config = yield* ServerConfig;
      const devServerManager = yield* DevServerManager;
      const fileSystem = yield* FileSystem.FileSystem;
      const git = yield* GitCore;
      const github = yield* GitHubCli;
      const gitManager = yield* GitManager;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const path = yield* Path.Path;
      const profileStatsQuery = yield* ProfileStatsQuery;
      const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
      const providerAdapterRegistry = yield* ProviderAdapterRegistry;
      const providerDiscoveryService = yield* ProviderDiscoveryService;
      const providerHealth = yield* ProviderHealth;
      const providerService = yield* ProviderService;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const runtimeStartup = yield* ServerRuntimeStartup;
      const serverEnvironment = yield* ServerEnvironment;
      const serverSettings = yield* ServerSettingsService;
      const terminalManager = yield* TerminalManager;
      const textGeneration = yield* TextGeneration;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;

      const repositoryCache = new Map<
        string,
        {
          expiresAt: number;
          generation: number;
          repositories: ReadonlyArray<GitHubRepositoryLink>;
        }
      >();
      type ResolvedRepositories = ReadonlyArray<GitHubRepositoryLink>;
      const repositoryInFlight = new Map<string, Effect.Effect<ResolvedRepositories, unknown>>();
      const pullRequestListCache = new Map<
        string,
        {
          expiresAt: number;
          generation: number;
          value: {
            entries: ReadonlyArray<GitHubPullRequestListItem>;
            truncated: boolean;
          };
        }
      >();
      const pullRequestListInFlight = new Map<
        string,
        Effect.Effect<
          { entries: ReadonlyArray<GitHubPullRequestListItem>; truncated: boolean },
          GitHubCliError
        >
      >();
      const mergeCapabilitiesCache = new Map<
        string,
        {
          expiresAt: number;
          value: PullRequestDetail["mergeCapabilities"];
        }
      >();
      let viewerCache: { expiresAt: number; login: string } | null = null;
      const viewerInFlight = new Map<string, Effect.Effect<string, GitHubCliError>>();
      const repositoryCacheLock = yield* Semaphore.make(1);
      const pullRequestListCacheLock = yield* Semaphore.make(1);
      const viewerCacheLock = yield* Semaphore.make(1);
      let repositoryCacheGeneration = 0;
      let pullRequestListCacheGeneration = 0;
      let viewerCacheGeneration = 0;

      const isGlobalGitHubCliError = (error: unknown): error is GitHubCliError =>
        error instanceof GitHubCliError &&
        (error.reason === "not-installed" || error.reason === "not-authenticated");

      const toPullRequestsRpcError = (cause: unknown, fallbackMessage: string) => {
        if (isGlobalGitHubCliError(cause)) {
          return new PullRequestsUnavailableError({
            reason: cause.reason === "not-installed" ? "gh-not-installed" : "gh-not-authenticated",
            message: cause.detail,
          });
        }
        return toWsRpcError(cause, fallbackMessage);
      };

      const pullRequestsEffect = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        fallbackMessage: string,
      ) => effect.pipe(Effect.mapError((cause) => toPullRequestsRpcError(cause, fallbackMessage)));

      const resolveProjectRepositories = (project: OrchestrationProject) =>
        Effect.gen(function* () {
          const cached = repositoryCache.get(project.workspaceRoot);
          const generation = repositoryCacheGeneration;
          if (cached && cached.generation === generation && cached.expiresAt > Date.now()) {
            return cached.repositories;
          }
          const inFlightKey = `${generation}:${project.workspaceRoot}`;
          const shared = yield* repositoryCacheLock.withPermits(1)(
            Effect.gen(function* () {
              const freshCached = repositoryCache.get(project.workspaceRoot);
              if (
                freshCached &&
                freshCached.generation === generation &&
                freshCached.expiresAt > Date.now()
              ) {
                return Effect.succeed(freshCached.repositories);
              }
              const existing = repositoryInFlight.get(inFlightKey);
              if (existing) return existing;
              let singleFlight!: Effect.Effect<ResolvedRepositories, unknown>;
              singleFlight = yield* Effect.cached(
                resolveGitHubRepositories(git, project.workspaceRoot).pipe(
                  Effect.tap((repositories) =>
                    Effect.sync(() => {
                      if (repositoryCacheGeneration === generation) {
                        repositoryCache.set(project.workspaceRoot, {
                          expiresAt: Date.now() + 30_000,
                          generation,
                          repositories,
                        });
                      }
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (repositoryInFlight.get(inFlightKey) === singleFlight) {
                        repositoryInFlight.delete(inFlightKey);
                      }
                    }),
                  ),
                ),
              );
              repositoryInFlight.set(inFlightKey, singleFlight);
              return singleFlight;
            }),
          );
          return yield* shared;
        });

      const loadViewer = () =>
        Effect.gen(function* () {
          if (viewerCache && viewerCache.expiresAt > Date.now()) return viewerCache.login;
          const generation = viewerCacheGeneration;
          const inFlightKey = String(generation);
          const shared = yield* viewerCacheLock.withPermits(1)(
            Effect.gen(function* () {
              if (viewerCache && viewerCache.expiresAt > Date.now()) {
                return Effect.succeed(viewerCache.login);
              }
              const existing = viewerInFlight.get(inFlightKey);
              if (existing) return existing;
              let singleFlight!: Effect.Effect<string, GitHubCliError>;
              singleFlight = yield* Effect.cached(
                github.getViewerLogin({ cwd: config.homeDir }).pipe(
                  Effect.tap((login) =>
                    Effect.sync(() => {
                      if (viewerCacheGeneration === generation) {
                        viewerCache = { expiresAt: Date.now() + 5 * 60_000, login };
                      }
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (viewerInFlight.get(inFlightKey) === singleFlight) {
                        viewerInFlight.delete(inFlightKey);
                      }
                    }),
                  ),
                ),
              );
              viewerInFlight.set(inFlightKey, singleFlight);
              return singleFlight;
            }),
          );
          return yield* shared;
        });

      const loadRepositoryPullRequests = (
        cwd: string,
        repository: string,
        state: "open" | "closed" | "merged",
        involvement: PullRequestInvolvement,
        viewer: string,
      ) =>
        Effect.gen(function* () {
          const cacheKey = pullRequestListCacheKey(repository, state, involvement, viewer);
          const cached = pullRequestListCache.get(cacheKey);
          const generation = pullRequestListCacheGeneration;
          if (cached && cached.generation === generation && cached.expiresAt > Date.now()) {
            return cached.value;
          }
          const inFlightKey = `${generation}:${cacheKey}`;
          const shared = yield* pullRequestListCacheLock.withPermits(1)(
            Effect.gen(function* () {
              const freshCached = pullRequestListCache.get(cacheKey);
              if (
                freshCached &&
                freshCached.generation === generation &&
                freshCached.expiresAt > Date.now()
              ) {
                return Effect.succeed(freshCached.value);
              }
              const existing = pullRequestListInFlight.get(inFlightKey);
              if (existing) return existing;
              const limit = 50;
              const fetchLimit = limit + 1;
              let singleFlight!: Effect.Effect<
                { entries: ReadonlyArray<GitHubPullRequestListItem>; truncated: boolean },
                GitHubCliError
              >;
              singleFlight = yield* Effect.cached(
                github
                  .listRepositoryPullRequests({
                    cwd,
                    repository,
                    state,
                    involvement,
                    viewer,
                    limit: fetchLimit,
                  })
                  .pipe(
                    Effect.map((entries) => ({
                      entries: entries.slice(0, limit),
                      truncated: entries.length > limit,
                    })),
                    Effect.tap((value) =>
                      Effect.sync(() => {
                        if (pullRequestListCacheGeneration === generation) {
                          pullRequestListCache.set(cacheKey, {
                            expiresAt: Date.now() + 30_000,
                            generation,
                            value,
                          });
                        }
                      }),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (pullRequestListInFlight.get(inFlightKey) === singleFlight) {
                          pullRequestListInFlight.delete(inFlightKey);
                        }
                      }),
                    ),
                  ),
              );
              pullRequestListInFlight.set(inFlightKey, singleFlight);
              return singleFlight;
            }),
          );
          return yield* shared;
        });

      const findProject = (projectId: ProjectId) =>
        projectionReadModelQuery.getSnapshot().pipe(
          Effect.flatMap((snapshot) => {
            const project = snapshot.projects.find(
              (candidate) =>
                candidate.id === projectId &&
                candidate.kind === "project" &&
                candidate.deletedAt === null,
            );
            return project ? Effect.succeed(project) : Effect.fail(new Error("Project not found."));
          }),
        );

      const loadMergeCapabilities = (cwd: string, repository: string) =>
        Effect.gen(function* () {
          const key = repository.toLowerCase();
          const cached = mergeCapabilitiesCache.get(key);
          if (cached && cached.expiresAt > Date.now()) return cached.value;
          const value = yield* github.getRepositoryMergeCapabilities({ cwd, repository });
          mergeCapabilitiesCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
          return value;
        });

      const validatePullRequestRepository = (repository: string) => {
        const normalized = repository.trim();
        return isValidGitHubRepositoryNameWithOwner(normalized)
          ? Effect.succeed(normalized)
          : Effect.fail(new Error("Invalid GitHub repository identity."));
      };

      const validateProjectPullRequestRepository = (
        project: OrchestrationProject,
        repositoryInput: string,
      ) =>
        Effect.gen(function* () {
          const repository = yield* validatePullRequestRepository(repositoryInput);
          const configuredRepositories = yield* resolveProjectRepositories(project);
          const matched = configuredRepositories.find(
            (candidate) => candidate.nameWithOwner.toLowerCase() === repository.toLowerCase(),
          );
          if (!matched) {
            return yield* Effect.fail(
              new Error("GitHub repository does not belong to the selected project."),
            );
          }
          return matched.nameWithOwner;
        });

      const loadPullRequestDetail = (
        project: OrchestrationProject,
        repositoryInput: string,
        number: number,
      ) =>
        Effect.gen(function* () {
          const repository = yield* validateProjectPullRequestRepository(project, repositoryInput);
          const [detail, mergeCapabilities] = yield* Effect.all(
            [
              github.getPullRequestDetail({
                cwd: project.workspaceRoot,
                repository,
                number,
              }),
              loadMergeCapabilities(project.workspaceRoot, repository),
            ],
            { concurrency: 2 },
          );
          const [owner = "", repo = ""] = repository.split("/");
          const reviewCommentsResult = yield* github
            .getPullRequestReviewComments({
              cwd: project.workspaceRoot,
              host: "github.com",
              owner,
              repo,
              number,
            })
            .pipe(
              Effect.map((result) => ({ ...result, incomplete: false })),
              Effect.catch(() =>
                Effect.succeed({ comments: [], truncated: false, incomplete: true }),
              ),
            );
          const comments = [
            ...detail.comments,
            ...reviewCommentsResult.comments.map((comment) => ({
              id: comment.id,
              kind: "review-comment" as const,
              author: comment.author
                ? { login: comment.author, name: null, avatarUrl: null, url: null }
                : null,
              body: comment.body,
              createdAt: comment.createdAt ?? detail.updatedAt,
              updatedAt: null,
              url: comment.url,
              path: comment.path,
              reviewState: null,
            })),
          ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
          return {
            projectId: project.id,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
            repository,
            ...detail,
            comments,
            commentsTruncated: reviewCommentsResult.truncated,
            commentsIncomplete: reviewCommentsResult.incomplete,
            mergeCapabilities,
          } satisfies PullRequestDetail;
        });

      const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (
        workspaceRoot: string,
        options: { readonly createIfMissing?: boolean } = {},
      ) {
        const rawWorkspaceRoot = workspaceRoot.trim();
        const expandedWorkspaceRoot =
          rawWorkspaceRoot === "~"
            ? config.homeDir
            : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
              ? path.join(config.homeDir, rawWorkspaceRoot.slice(2))
              : rawWorkspaceRoot;
        const normalizedWorkspaceRoot = path.resolve(expandedWorkspaceRoot);
        let workspaceStat = yield* fileSystem
          .stat(normalizedWorkspaceRoot)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!workspaceStat) {
          if (!options.createIfMissing) {
            return yield* new WsRpcError({
              message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
            });
          }
          yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
                  cause,
                }),
            ),
          );
          workspaceStat = yield* fileSystem
            .stat(normalizedWorkspaceRoot)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!workspaceStat) {
            return yield* new WsRpcError({
              message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
            });
          }
        }
        if (workspaceStat.type !== "Directory") {
          return yield* new WsRpcError({
            message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
          });
        }
        return yield* realpathNearestExisting(normalizedWorkspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      });
      // One mkdir loop shared by every container kind; the relative directory set is the
      // only thing that varies (general chats scaffold work/outputs, Studio mirrors the
      // Claude Outbox layout). Keeping a single implementation keeps error handling and
      // idempotency identical across kinds.
      const prepareWorkspaceSubdirectories = Effect.fnUntraced(function* (
        workspaceRoot: string,
        relativeDirnames: readonly string[],
      ) {
        for (const dirname of relativeDirnames) {
          const childPath = path.join(workspaceRoot, dirname);
          yield* fileSystem.makeDirectory(childPath, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create workspace directory: ${childPath}`,
                  cause,
                }),
            ),
          );
        }
      });
      const prepareChatWorkspaceRoot = (workspaceRoot: string) =>
        prepareWorkspaceSubdirectories(workspaceRoot, CHAT_WORKSPACE_SUBDIRECTORIES);
      // Instruction files are best-effort: they steer agents toward the Outbox layout but
      // must never fail (or retry-loop) the container create that scaffolds the folders.
      const prepareStudioWorkspaceRoot = (workspaceRoot: string) =>
        prepareWorkspaceSubdirectories(workspaceRoot, STUDIO_WORKSPACE_SUBDIRECTORIES).pipe(
          Effect.andThen(
            ensureStudioWorkspaceInstructionsFiles(workspaceRoot).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to write studio workspace instructions", {
                  workspaceRoot,
                  cause,
                }),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
        );

      const normalizeDispatchCommand = makeDispatchCommandNormalizer<WsRpcError>({
        attachmentsDir: config.attachmentsDir,
        chatWorkspaceRoot: config.chatWorkspaceRoot,
        studioWorkspaceRoot: config.studioWorkspaceRoot,
        fileSystem,
        path,
        canonicalizeProjectWorkspaceRoot,
        prepareChatWorkspaceRoot,
        prepareStudioWorkspaceRoot,
      });

      const importThread = makeImportThreadHandler({
        fileSystem,
        orchestrationEngine,
        path,
        platform: process.platform,
        projectionSnapshotQuery: projectionReadModelQuery,
        providerAdapterRegistry,
        providerService,
      });

      // Terminal-first threads are created with the generic "New terminal" placeholder.
      // The tracker buffers per-terminal input and, once a meaningful command is submitted,
      // surfaces a safe title used to auto-rename the thread on its first command.
      const terminalTitleTracker = new TerminalThreadTitleTracker();
      const resetTerminalTitleBuffer = (threadId: string, terminalId: string | null) =>
        Effect.sync(() => terminalTitleTracker.reset(threadId, terminalId));
      // Terminal auto-titles are best-effort metadata and must never block or fail terminal writes.
      const maybeAutoRenameTerminalThread = Effect.fnUntraced(function* (input: {
        threadId: string;
        terminalId: string;
        data: string;
      }) {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === input.threadId);
        if (!thread) {
          return;
        }
        const nextTitle = terminalTitleTracker.consumeWrite({
          currentTitle: thread.title,
          data: input.data,
          terminalId: input.terminalId,
          threadId: input.threadId,
        });
        if (!nextTitle) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`server:terminal-title-rename:${crypto.randomUUID()}`),
          threadId: ThreadId.makeUnsafe(input.threadId),
          title: nextTitle,
        });
      });

      const stopLocalServerAndTrackedProjectRun = Effect.fnUntraced(function* (input: {
        pid: number;
        port: number;
      }) {
        const localServerSnapshot = yield* Effect.promise(() => listLocalServers());
        const localServer =
          localServerSnapshot.servers.find(
            (server) => server.pid === input.pid && server.ports.includes(input.port),
          ) ?? null;
        const result = yield* Effect.promise(() => stopLocalServer(input, localServer));
        if (localServer?.isStoppable) {
          const devServers = yield* devServerManager.list;
          const trackedServer = findProjectDevServerForLocalServer({
            localServer,
            devServers: devServers.servers,
          });
          if (trackedServer) {
            yield* devServerManager
              .stop({ projectId: trackedServer.projectId })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
        return result;
      });

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd: config.cwd,
          homeDir: config.homeDir,
          chatWorkspaceRoot: config.chatWorkspaceRoot,
          studioWorkspaceRoot: config.studioWorkspaceRoot,
          worktreesDir: config.worktreesDir,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors: resolveAvailableEditors(),
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster.refreshStatus(cwd).pipe(Effect.catchCause(() => Effect.void));

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionReadModelQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
            return projectionReadModelQuery
              .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const isThreadDetailEventFor = (threadId: ThreadId, event: OrchestrationEvent) =>
        event.aggregateKind === "thread" &&
        event.aggregateId === threadId &&
        isThreadDetailEvent(event);

      const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
        effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          rpcEffect(
            Effect.gen(function* () {
              const { command: normalizedCommand, prepareWorkspaceRoot } =
                yield* normalizeDispatchCommand({ command });
              const result = yield* runtimeStartup.enqueueCommand(
                orchestrationEngine.dispatch(normalizedCommand),
              );
              // Only scaffold managed workspace-root subdirectories (Inbox/Outbox/work/outputs)
              // AFTER the decider has accepted the command. A rejected dispatch (e.g. a
              // cross-kind workspace-root ownership conflict) must never mutate the filesystem.
              if (prepareWorkspaceRoot) {
                yield* prepareWorkspaceRoot;
              }
              return result;
            }),
            "Failed to dispatch orchestration command",
          ),
        [ORCHESTRATION_WS_METHODS.importThread]: (input) =>
          rpcEffect(importThread(input), "Failed to import thread"),
        [ORCHESTRATION_WS_METHODS.getSnapshot]: () =>
          rpcEffect(
            projectionReadModelQuery.getSnapshot(),
            "Failed to load orchestration snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.getShellSnapshot]: () =>
          rpcEffect(
            projectionReadModelQuery.getShellSnapshot(),
            "Failed to load orchestration shell snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.repairState]: () =>
          rpcEffect(orchestrationEngine.repairState(), "Failed to repair orchestration state"),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          rpcEffect(checkpointDiffQuery.getTurnDiff(input), "Failed to load turn diff"),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          rpcEffect(
            checkpointDiffQuery.getFullThreadDiff(input),
            "Failed to load full thread diff",
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          rpcEffect(
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(Effect.map((events) => Array.from(events))),
            "Failed to replay orchestration events",
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.merge(
            Stream.fromEffect(
              projectionReadModelQuery.getShellSnapshot().pipe(
                Effect.map((snapshot) => ({ kind: "snapshot" as const, snapshot })),
                Effect.mapError((cause) => toWsRpcError(cause, "Failed to load shell snapshot")),
              ),
            ),
            // Filter before buffering so the sliding window only evicts shell-relevant
            // events; project after it so a stalled subscriber does not keep driving
            // read-model queries for events it will never receive.
            bufferLiveUiStream(
              orchestrationEngine.streamDomainEvents.pipe(Stream.filter(isShellRelevantEvent)),
              {
                label: "orchestration.shell",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              },
            ).pipe(
              Stream.mapEffect(toShellStreamEvent),
              Stream.flatMap((event) =>
                Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeShell]: () => Effect.void,
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          Stream.merge(
            Stream.fromEffect(
              projectionReadModelQuery.getThreadDetailSnapshotById(input.threadId).pipe(
                Effect.map((snapshot) =>
                  Option.map(snapshot, (value) => ({
                    kind: "snapshot" as const,
                    snapshot: value,
                  })),
                ),
                Effect.mapError((cause) => toWsRpcError(cause, "Failed to load thread snapshot")),
              ),
            ).pipe(
              Stream.flatMap((snapshot) =>
                Option.isSome(snapshot) ? Stream.succeed(snapshot.value) : Stream.empty,
              ),
            ),
            // Filter to this thread before buffering: otherwise a burst on another
            // thread evicts this subscriber's own events from the sliding window.
            bufferLiveUiStream(
              orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter((event) => isThreadDetailEventFor(input.threadId, event)),
              ),
              {
                label: "orchestration.thread-detail",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              },
            ).pipe(
              Stream.map(
                (event): OrchestrationThreadStreamItem => ({
                  kind: "event",
                  event,
                }),
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeThread]: () => Effect.void,
        [WS_METHODS.subscribeOrchestrationDomainEvents]: () =>
          bufferLiveUiStream(orchestrationEngine.streamDomainEvents, {
            label: "orchestration.domain-events",
          }),

        [WS_METHODS.projectsListDirectories]: (input) =>
          rpcEffect(
            workspaceEntries.listDirectories(input),
            "Failed to list workspace directories",
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          rpcEffect(workspaceEntries.search(input), "Failed to search workspace entries"),
        [WS_METHODS.projectsDiscoverScripts]: (input) =>
          rpcEffect(workspaceEntries.discoverScripts(input), "Failed to discover project scripts"),
        [WS_METHODS.projectsSearchLocalEntries]: (input) =>
          rpcEffect(workspaceEntries.searchLocal(input), "Failed to search local entries"),
        [WS_METHODS.projectsReadFile]: (input) =>
          rpcEffect(workspaceFileSystem.readFile(input), "Failed to read workspace file"),
        [WS_METHODS.projectsCreateLocalFilePreviewGrant]: (input) =>
          rpcEffect(
            Effect.promise(() => createLocalPreviewGrant({ requestedPath: input.path })),
            "Failed to create local file preview grant",
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          rpcEffect(workspaceFileSystem.writeFile(input), "Failed to write workspace file"),
        [WS_METHODS.projectsRunDevServer]: (input) =>
          rpcEffect(devServerManager.run(input), "Failed to start dev server"),
        [WS_METHODS.projectsStopDevServer]: (input) =>
          rpcEffect(devServerManager.stop(input), "Failed to stop dev server"),
        [WS_METHODS.projectsListDevServers]: () =>
          rpcEffect(devServerManager.list, "Failed to list dev servers"),
        [WS_METHODS.subscribeProjectDevServerEvents]: () =>
          Stream.concat(
            Stream.fromEffect(
              devServerManager.list.pipe(
                Effect.map(
                  (result): ProjectDevServerEvent => ({
                    type: "snapshot",
                    servers: result.servers,
                  }),
                ),
              ),
            ),
            bufferLiveUiStream(devServerManager.stream, {
              label: "projects.dev-servers",
              onDroppedEvents: failLiveUiStreamForSnapshotResync,
            }),
          ),
        [WS_METHODS.studioListThreadOutputs]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              // Self-heal the Studio folder tree: an accepted create whose deferred scaffold
              // failed (crash, transient FS error) must not leave Studio without its Outbox
              // forever. mkdir -p is idempotent and cheap, and this endpoint only fires while
              // a Studio chat's environment panel is actually open. Failures degrade to the
              // empty-list behavior.
              yield* prepareStudioWorkspaceRoot(config.studioWorkspaceRoot).pipe(
                Effect.catch(() => Effect.void),
              );
              // Checkpoints cover Git workspaces; file-change activities preserve the same
              // attribution in the default non-Git Studio root. Unknown/non-Studio ids stay empty.
              const context = yield* projectionReadModelQuery.getThreadCheckpointContext(
                input.threadId,
                { includeFileChangeActivityPayloads: true },
              );
              if (Option.isNone(context) || context.value.projectKind !== "studio") {
                return { entries: [] };
              }
              const workspaceCwd = resolveThreadWorkspaceCwd({
                thread: {
                  projectId: context.value.projectId,
                  envMode: context.value.envMode,
                  worktreePath: context.value.worktreePath,
                },
                projects: [
                  {
                    id: context.value.projectId,
                    kind: context.value.projectKind,
                    workspaceRoot: context.value.workspaceRoot,
                  },
                ],
              });
              if (!workspaceCwd) {
                return { entries: [] };
              }
              return yield* listStudioThreadOutputs({
                workspaceRoot: workspaceCwd,
                checkpoints: context.value.checkpoints,
                ...(context.value.fileChangeActivityPayloads
                  ? { fileChangeActivityPayloads: context.value.fileChangeActivityPayloads }
                  : {}),
              });
            }),
            "Failed to list studio thread outputs",
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          rpcEffect(workspaceEntries.browse(input), "Failed to browse filesystem"),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          rpcEffect(open.openInEditor(input), "Failed to open editor"),

        [WS_METHODS.gitGithubRepository]: (input) =>
          rpcEffect(resolveGitHubRepository(git, input.cwd), "Failed to resolve GitHub repository"),
        [WS_METHODS.gitStatus]: (input) =>
          rpcEffect(gitStatusBroadcaster.getStatus(input), "Failed to read git status"),
        [WS_METHODS.gitReadWorkingTreeDiff]: (input) =>
          rpcEffect(gitManager.readWorkingTreeDiff(input), "Failed to read working tree diff"),
        [WS_METHODS.gitSummarizeDiff]: (input) =>
          rpcEffect(gitManager.summarizeDiff(input), "Failed to summarize diff"),
        [WS_METHODS.gitPull]: (input) =>
          rpcEffect(
            git.pullCurrentBranch(input.cwd).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to pull branch",
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          bufferLiveUiStream(
            Stream.callback<GitActionProgressEvent, WsRpcError>((queue) =>
              gitManager
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.tap(() => refreshGitStatus(input.cwd)),
                  Effect.matchCauseEffect({
                    onFailure: (cause) =>
                      Queue.fail(queue, toWsRpcError(cause, "Git action failed")),
                    onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                  }),
                ),
            ),
            { label: "git.stacked-action" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          rpcEffect(gitManager.resolvePullRequest(input), "Failed to resolve pull request"),
        [WS_METHODS.gitPullRequestSnapshot]: (input) =>
          rpcEffect(
            gitManager.pullRequestSnapshot(input),
            "Failed to load pull request checks and comments",
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          rpcEffect(
            gitManager
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to prepare pull request thread",
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          pullRequestsEffect(
            Effect.gen(function* () {
              if (input.forceRefresh === true) {
                yield* Effect.sync(() => {
                  repositoryCacheGeneration += 1;
                  repositoryCache.clear();
                  pullRequestListCacheGeneration += 1;
                  pullRequestListCache.clear();
                  mergeCapabilitiesCache.clear();
                  viewerCacheGeneration += 1;
                  viewerCache = null;
                });
              }
              const snapshot = yield* projectionReadModelQuery.getSnapshot();
              const projects = snapshot.projects.filter(
                (project) =>
                  project.deletedAt === null &&
                  project.kind === "project" &&
                  (input.projectId == null || project.id === input.projectId),
              );
              const resolved = yield* Effect.forEach(
                projects,
                (project) =>
                  resolveProjectRepositories(project).pipe(
                    Effect.match({
                      onFailure: (error) => ({ project, error, repositories: [] }),
                      onSuccess: (repositories) => ({ project, error: null, repositories }),
                    }),
                  ),
                { concurrency: 6 },
              );

              const errors: Array<{
                projectId: ProjectId;
                projectTitle: string;
                message: string;
              }> = resolved.flatMap(({ project, error }) =>
                error
                  ? [
                      {
                        projectId: project.id,
                        projectTitle: project.title,
                        message:
                          error instanceof Error ? error.message : "Repository lookup failed.",
                      },
                    ]
                  : [],
              );
              const uniqueRepositories = new Map<
                string,
                {
                  repository: { nameWithOwner: string; url: string };
                  projects: OrchestrationProject[];
                }
              >();
              for (const item of resolved) {
                for (const repository of item.repositories) {
                  const key = repository.nameWithOwner.toLowerCase();
                  const existing = uniqueRepositories.get(key);
                  if (existing) {
                    if (!existing.projects.some((project) => project.id === item.project.id)) {
                      existing.projects.push(item.project);
                    }
                  } else {
                    uniqueRepositories.set(key, {
                      repository,
                      projects: [item.project],
                    });
                  }
                }
              }

              if (uniqueRepositories.size === 0) {
                return {
                  viewer: null,
                  entries: [],
                  errors,
                  repositoryBatches: [],
                };
              }

              const involvement = input.involvement ?? "all";
              const viewer = yield* loadViewer();
              const batches = yield* Effect.forEach(
                uniqueRepositories.values(),
                ({ projects: repositoryProjects, repository }) =>
                  Effect.gen(function* () {
                    const cwd = repositoryProjects[0]!.workspaceRoot;
                    const [result, reviewingResult] = yield* Effect.all(
                      [
                        loadRepositoryPullRequests(
                          cwd,
                          repository.nameWithOwner,
                          input.state,
                          involvement,
                          viewer,
                        ),
                        involvement === "all"
                          ? loadRepositoryPullRequests(
                              cwd,
                              repository.nameWithOwner,
                              input.state,
                              "reviewing",
                              viewer,
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
                          (pullRequest): PullRequestListEntry => ({
                            projectId: project.id,
                            projectTitle: project.title,
                            repository: repository.nameWithOwner,
                            number: pullRequest.number,
                            title: pullRequest.title,
                            url: pullRequest.url,
                            author: pullRequest.author,
                            headBranch: pullRequest.headBranch,
                            baseBranch: pullRequest.baseBranch,
                            state: pullRequest.state,
                            isDraft: pullRequest.isDraft,
                            additions: pullRequest.additions,
                            deletions: pullRequest.deletions,
                            createdAt: pullRequest.createdAt,
                            updatedAt: pullRequest.updatedAt,
                            reviewDecision: pullRequest.reviewDecision,
                            viewerReviewRequested: isViewerReviewRequested(
                              pullRequest.author,
                              pullRequest.reviewRequestLogins,
                              viewer,
                              involvement === "reviewing" ||
                                reviewingNumbers.has(pullRequest.number),
                            ),
                            labels: pullRequest.labels,
                          }),
                        ),
                      ),
                      repositoryBatches: repositoryProjects.map((project) => ({
                        projectId: project.id,
                        projectTitle: project.title,
                        repository: repository.nameWithOwner,
                        truncated: result.truncated,
                      })),
                      errors: [],
                    };
                  }).pipe(
                    Effect.catch((error) =>
                      error.reason === "not-installed" || error.reason === "not-authenticated"
                        ? Effect.fail(error)
                        : Effect.succeed({
                            entries: [] as PullRequestListEntry[],
                            repositoryBatches: [],
                            errors: repositoryProjects.map((project) => ({
                              projectId: project.id,
                              projectTitle: project.title,
                              message: error.message,
                            })),
                          }),
                    ),
                  ),
                { concurrency: 6 },
              );
              return {
                viewer,
                entries: batches
                  .flatMap((batch) => batch.entries)
                  .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
                errors: [...errors, ...batches.flatMap((batch) => batch.errors)],
                repositoryBatches: batches.flatMap((batch) => batch.repositoryBatches),
              };
            }),
            "Failed to list pull requests",
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          pullRequestsEffect(
            findProject(input.projectId).pipe(
              Effect.flatMap((project) =>
                loadPullRequestDetail(project, input.repository, input.number),
              ),
            ),
            "Failed to load pull request",
          ),
        [WS_METHODS.pullRequestsDiff]: (input) =>
          pullRequestsEffect(
            Effect.gen(function* () {
              const project = yield* findProject(input.projectId);
              const repository = yield* validateProjectPullRequestRepository(
                project,
                input.repository,
              );
              return yield* github.getPullRequestDiff({
                cwd: project.workspaceRoot,
                repository,
                number: input.number,
              });
            }),
            "Failed to load pull request diff",
          ),
        [WS_METHODS.pullRequestsAction]: (input) =>
          pullRequestsEffect(
            Effect.gen(function* () {
              const project = yield* findProject(input.projectId);
              const repository = yield* validateProjectPullRequestRepository(
                project,
                input.repository,
              );
              if (input.action === "merge") {
                const mergeMethod = input.mergeMethod ?? "merge";
                const capabilities = yield* loadMergeCapabilities(
                  project.workspaceRoot,
                  repository,
                );
                if (!isPullRequestMergeMethodAllowed(capabilities, mergeMethod)) {
                  return yield* Effect.fail(
                    new Error(`The repository does not allow the ${mergeMethod} merge method.`),
                  );
                }
              }
              yield* github.runPullRequestAction({
                cwd: project.workspaceRoot,
                repository,
                number: input.number,
                action: input.action,
                ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
              });
              yield* Effect.sync(() => {
                pullRequestListCacheGeneration += 1;
                pullRequestListCache.clear();
              });
              return {
                projectId: project.id,
                repository,
                number: input.number,
                workspaceRoot: project.workspaceRoot,
              };
            }),
            "Pull request action failed",
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          rpcEffect(git.listBranches(input), "Failed to list branches"),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          rpcEffect(
            git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create worktree",
          ),
        [WS_METHODS.gitCreateDetachedWorktree]: (input) =>
          rpcEffect(
            git.createDetachedWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create detached worktree",
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          rpcEffect(
            git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to remove worktree",
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          rpcEffect(
            git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create branch",
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          rpcEffect(
            Effect.scoped(git.checkoutBranch(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            "Failed to checkout branch",
          ),
        [WS_METHODS.gitStashAndCheckout]: (input) =>
          rpcEffect(
            Effect.scoped(git.stashAndCheckout(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            "Failed to stash and checkout",
          ),
        [WS_METHODS.gitStashDrop]: (input) =>
          rpcEffect(
            git.stashDrop(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to drop stash",
          ),
        [WS_METHODS.gitStashInfo]: (input) =>
          rpcEffect(git.stashInfo(input), "Failed to read stash"),
        [WS_METHODS.gitRemoveIndexLock]: (input) =>
          rpcEffect(git.removeIndexLock(input), "Failed to remove Git index lock"),
        [WS_METHODS.gitInit]: (input) =>
          rpcEffect(
            git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to initialize repository",
          ),
        [WS_METHODS.gitStageFiles]: (input) =>
          rpcEffect(
            git.stageFiles(input.cwd, input.paths).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
              Effect.as({ ok: true }),
            ),
            "Failed to stage files",
          ),
        [WS_METHODS.gitUnstageFiles]: (input) =>
          rpcEffect(
            git.unstageFiles(input.cwd, input.paths).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
              Effect.as({ ok: true }),
            ),
            "Failed to unstage files",
          ),
        [WS_METHODS.gitHandoffThread]: (input) =>
          rpcEffect(
            gitManager.handoffThread(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to hand off thread",
          ),

        [WS_METHODS.terminalOpen]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
              Effect.andThen(terminalManager.open(input)),
            ),
            "Failed to open terminal",
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          rpcEffect(
            terminalManager.write(input).pipe(
              Effect.tap(() =>
                maybeAutoRenameTerminalThread({
                  threadId: input.threadId,
                  terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
                  data: input.data,
                }).pipe(Effect.catch(() => Effect.void)),
              ),
            ),
            "Failed to write terminal",
          ),
        [WS_METHODS.terminalAckOutput]: (input) =>
          rpcEffect(terminalManager.ackOutput(input), "Failed to acknowledge terminal output"),
        [WS_METHODS.terminalResize]: (input) =>
          rpcEffect(terminalManager.resize(input), "Failed to resize terminal"),
        [WS_METHODS.terminalClear]: (input) =>
          rpcEffect(terminalManager.clear(input), "Failed to clear terminal"),
        [WS_METHODS.terminalRestart]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
              Effect.andThen(terminalManager.restart(input)),
            ),
            "Failed to restart terminal",
          ),
        [WS_METHODS.terminalClose]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? null).pipe(
              Effect.andThen(terminalManager.close(input)),
            ),
            "Failed to close terminal",
          ),
        [WS_METHODS.subscribeTerminalEvents]: () =>
          // Terminal output is an ordered byte stream with renderer ACK accounting.
          // Keep this lossless: dropping chunks would create holes until reattach.
          Stream.callback((queue) =>
            Effect.gen(function* () {
              const unsubscribe = yield* terminalManager.subscribe((event) => {
                Effect.runFork(Queue.offer(queue, event).pipe(Effect.asVoid));
              });
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
            }),
          ),

        [WS_METHODS.serverGetConfig]: () =>
          rpcEffect(loadServerConfig, "Failed to load server config"),
        [WS_METHODS.serverGetEnvironment]: () =>
          rpcEffect(serverEnvironment.getDescriptor, "Failed to load server environment"),
        [WS_METHODS.serverGetSettings]: () =>
          rpcEffect(serverSettings.getSettings, "Failed to load server settings"),
        [WS_METHODS.serverUpdateSettings]: (input) =>
          rpcEffect(serverSettings.updateSettings(input), "Failed to update server settings"),
        [WS_METHODS.serverRefreshProviders]: () =>
          rpcEffect(
            providerHealth.refresh.pipe(Effect.map((providers) => ({ providers }))),
            "Failed to refresh providers",
          ),
        [WS_METHODS.serverUpdateProvider]: (input) => providerHealth.updateProvider(input),
        [WS_METHODS.serverListWorktrees]: () => Effect.succeed({ worktrees: [] }),
        [WS_METHODS.serverListLocalServers]: () =>
          rpcEffect(
            Effect.promise(() => listLocalServers()),
            "Failed to list local servers",
          ),
        [WS_METHODS.serverStopLocalServer]: (input) =>
          rpcEffect(stopLocalServerAndTrackedProjectRun(input), "Failed to stop local server"),
        [WS_METHODS.statsGetProfileStats]: (input) =>
          rpcEffect(profileStatsQuery.getProfileStats(input), "Failed to load profile stats"),
        [WS_METHODS.statsGetProfileTokenStats]: (input) =>
          rpcEffect(
            profileStatsQuery.getProfileTokenStats(input),
            "Failed to load profile token stats",
          ),
        [WS_METHODS.serverGetProviderUsageSnapshot]: (input) =>
          rpcEffect(getProviderUsageSnapshot(input), "Failed to load provider usage"),
        [WS_METHODS.serverListProviderUsage]: (input) =>
          rpcEffect(listProviderUsage(input), "Failed to load provider usage"),
        [WS_METHODS.serverGetDiagnostics]: () =>
          rpcEffect(
            Effect.gen(function* () {
              const [projection, fullChildProcesses] = yield* Effect.all([
                projectionReadModelQuery.getCounts(),
                Effect.promise(() => readDescendantProcesses(process.pid)),
              ]);
              const childProcesses = fullChildProcesses.slice(0, MAX_DIAGNOSTIC_CHILD_PROCESSES);
              const memory = process.memoryUsage();
              const diagnostics: ServerDiagnosticsResult = {
                generatedAt: new Date().toISOString(),
                process: {
                  pid: process.pid,
                  uptimeSeconds: Math.max(0, Math.round(process.uptime())),
                  memory: {
                    rssBytes: Math.max(0, Math.round(memory.rss)),
                    heapTotalBytes: Math.max(0, Math.round(memory.heapTotal)),
                    heapUsedBytes: Math.max(0, Math.round(memory.heapUsed)),
                    externalBytes: Math.max(0, Math.round(memory.external)),
                    arrayBuffersBytes: Math.max(0, Math.round(memory.arrayBuffers)),
                  },
                },
                childProcesses,
                childProcessTotalCount: fullChildProcesses.length,
                childProcessTotalRssBytes: fullChildProcesses.reduce(
                  (total, processRow) => total + processRow.rssBytes,
                  0,
                ),
                projection,
              };
              return diagnostics;
            }),
            "Failed to load server diagnostics",
          ),
        [WS_METHODS.serverTranscribeVoice]: (input) =>
          rpcEffect(
            providerAdapterRegistry
              .getByProvider(input.provider)
              .pipe(
                Effect.flatMap((adapter) =>
                  adapter.transcribeVoice
                    ? adapter.transcribeVoice(input)
                    : Effect.fail(
                        new Error(
                          `Voice transcription is unavailable for provider '${input.provider}'.`,
                        ),
                      ),
                ),
              ),
            "Voice transcription failed",
          ),
        [WS_METHODS.serverGenerateThreadRecap]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const modelSelection =
                input.textGenerationModelSelection ?? settings.textGenerationModelSelection;
              return yield* textGeneration.generateThreadRecap({
                cwd: input.cwd,
                newMaterial: input.newMaterial,
                ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
                ...(input.currentState ? { currentState: input.currentState } : {}),
                ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
                model: input.textGenerationModel ?? modelSelection.model,
                modelSelection,
                ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
              });
            }),
            "Failed to generate thread recap",
          ),
        [WS_METHODS.serverGenerateAutomationIntent]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const modelSelection =
                input.textGenerationModelSelection ?? settings.textGenerationModelSelection;
              return yield* textGeneration.generateAutomationIntent({
                cwd: input.cwd,
                message: input.message,
                ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
                nowIso: input.nowIso,
                ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
                model: input.textGenerationModel ?? modelSelection.model,
                modelSelection,
                ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
              });
            }),
            "Failed to generate automation intent",
          ),
        [WS_METHODS.serverUpsertKeybinding]: (input) =>
          rpcEffect(
            keybindings
              .upsertKeybindingRule(input)
              .pipe(
                Effect.map((keybindingsConfig) => ({ keybindings: keybindingsConfig, issues: [] })),
              ),
            "Failed to update keybinding",
          ),
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.concat(
            Stream.fromEffect(
              lifecycleEvents.snapshot.pipe(
                Effect.map((snapshot) =>
                  Array.from(snapshot.events).toSorted(
                    (left, right) => left.sequence - right.sequence,
                  ),
                ),
              ),
            ).pipe(Stream.flatMap(Stream.fromIterable)),
            bufferLiveUiStream(lifecycleEvents.stream, {
              label: "server.lifecycle",
              onDroppedEvents: failLiveUiStreamForSnapshotResync,
            }),
          ).pipe(
            Stream.map(
              (event): ServerLifecycleStreamEvent =>
                event.type === "welcome"
                  ? { type: "welcome", payload: event.payload }
                  : event.type === "ready"
                    ? { type: "ready", payload: event.payload }
                    : { type: "maintenance", payload: event.payload },
            ),
          ),
        [WS_METHODS.subscribeServerConfig]: () =>
          Stream.concat(
            Stream.fromEffect(
              loadServerConfig.pipe(
                Effect.map(
                  (config): ServerConfigStreamEvent => ({ type: "snapshot" as const, config }),
                ),
              ),
            ),
            Stream.merge(
              bufferLiveUiStream(keybindings.streamChanges, {
                label: "server.keybindings",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(
                Stream.map((event) => ({
                  type: "configUpdated" as const,
                  payload: { issues: event.issues, providers: [] },
                })),
              ),
              Stream.merge(
                bufferLiveUiStream(providerHealth.streamChanges, {
                  label: "server.provider-statuses",
                  onDroppedEvents: failLiveUiStreamForSnapshotResync,
                }).pipe(
                  Stream.map((providers) => ({
                    type: "providerStatuses" as const,
                    payload: { providers },
                  })),
                ),
                bufferLiveUiStream(serverSettings.streamChanges, {
                  label: "server.settings",
                  onDroppedEvents: failLiveUiStreamForSnapshotResync,
                }).pipe(
                  Stream.map((settings) => ({
                    type: "settingsUpdated" as const,
                    payload: { settings },
                  })),
                ),
              ),
            ),
          ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server config stream failed"))),
        [WS_METHODS.subscribeServerProviderStatuses]: () =>
          Stream.concat(
            Stream.fromEffect(
              providerHealth.getStatuses.pipe(Effect.map((providers) => ({ providers }))),
            ),
            bufferLiveUiStream(providerHealth.streamChanges, {
              label: "server.provider-statuses",
              onDroppedEvents: failLiveUiStreamForSnapshotResync,
            }).pipe(Stream.map((providers) => ({ providers }))),
          ),
        [WS_METHODS.subscribeServerSettings]: () =>
          Stream.concat(
            Stream.fromEffect(
              serverSettings.getSettings.pipe(Effect.map((settings) => ({ settings }))),
            ),
            bufferLiveUiStream(serverSettings.streamChanges, {
              label: "server.settings",
              onDroppedEvents: failLiveUiStreamForSnapshotResync,
            }).pipe(Stream.map((settings) => ({ settings }))),
          ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server settings stream failed"))),

        [WS_METHODS.providerGetComposerCapabilities]: (input) =>
          rpcEffect(
            providerDiscoveryService.getComposerCapabilities(input),
            "Failed to get composer capabilities",
          ),
        [WS_METHODS.providerCompactThread]: (input) =>
          rpcEffect(providerService.compactThread(input), "Failed to compact thread"),
        [WS_METHODS.providerListCommands]: (input) =>
          rpcEffect(providerDiscoveryService.listCommands(input), "Failed to list commands"),
        [WS_METHODS.providerListSkills]: (input) =>
          rpcEffect(providerDiscoveryService.listSkills(input), "Failed to list skills"),
        [WS_METHODS.providerListSkillsCatalog]: (input) =>
          rpcEffect(
            Effect.tryPromise(() =>
              discoverSkillsCatalog({
                cwd: input.cwd ?? null,
                homeDir: config.homeDir,
                synaraBaseDir: config.baseDir,
                includeDuplicateOrigins: true,
              }),
            ).pipe(
              Effect.map((skills) => ({
                skills,
                synaraSkillsDir: synaraSkillsDir(config.baseDir),
              })),
            ),
            "Failed to list the skills catalog",
          ),
        [WS_METHODS.providerListPlugins]: (input) =>
          rpcEffect(providerDiscoveryService.listPlugins(input), "Failed to list plugins"),
        [WS_METHODS.providerReadPlugin]: (input) =>
          rpcEffect(providerDiscoveryService.readPlugin(input), "Failed to read plugin"),
        [WS_METHODS.providerListModels]: (input) =>
          rpcEffect(providerDiscoveryService.listModels(input), "Failed to list models"),
        [WS_METHODS.providerListAgents]: (input) =>
          rpcEffect(providerDiscoveryService.listAgents(input), "Failed to list agents"),
        [WS_METHODS.automationList]: (input) =>
          rpcEffect(automationService.list(input), "Failed to list automations"),
        [WS_METHODS.automationCreate]: (input) =>
          rpcEffect(automationService.create(input), "Failed to create automation"),
        [WS_METHODS.automationUpdate]: (input) =>
          rpcEffect(automationService.update(input), "Failed to update automation"),
        [WS_METHODS.automationDelete]: (input) =>
          rpcEffect(automationService.delete(input), "Failed to delete automation"),
        [WS_METHODS.automationRunNow]: (input) =>
          rpcEffect(automationService.runNow(input), "Failed to run automation"),
        [WS_METHODS.automationCancelRun]: (input) =>
          rpcEffect(automationService.cancelRun(input), "Failed to cancel automation run"),
        [WS_METHODS.automationMarkRunRead]: (input) =>
          rpcEffect(automationService.markRunRead(input), "Failed to update automation run"),
        [WS_METHODS.automationArchiveRun]: (input) =>
          rpcEffect(automationService.archiveRun(input), "Failed to update automation run"),
        [WS_METHODS.subscribeAutomationEvents]: () =>
          Stream.merge(
            Stream.fromEffect(
              automationService.list({}).pipe(
                Effect.map(({ definitions, runs }) => ({
                  type: "snapshot" as const,
                  definitions,
                  runs,
                })),
              ),
            ),
            automationService.streamEvents,
          ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Automation event stream failed"))),
      });
    }),
  );

const makeRpcWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
  spanPrefix: "ws.rpc",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
  // JSON keeps the wire format symmetric with any web build. A serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs server and web on independently-built copies.
}).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

export const websocketRpcRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* makeRpcWebSocketHttpEffect;
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const url = HttpServerRequest.toURL(request);
        if (
          !url ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url.origin,
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const legacyToken = url.searchParams.get("token");
        const authenticatedSession =
          !config.authToken || legacyToken === config.authToken
            ? null
            : yield* serverAuth.authenticateWebSocketUpgrade(makeEffectAuthRequest(request));

        if (!authenticatedSession) {
          return yield* rpcWebSocketHttpEffect;
        }

        return yield* Effect.acquireUseRelease(
          sessions.markConnected(authenticatedSession.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(authenticatedSession.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
    );
  }),
);
