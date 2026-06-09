// Purpose: PR-resolution Effects for the GitManager layer — branch head-context resolution,
//   open/latest PR lookup, base-branch resolution, head-branch materialization, upstream config.
// Layer: dependency-parameterized Effect factory; built once per GitManager via makePrResolution(deps).
// Exports: PrResolution, PrResolutionDeps, makePrResolution.

import { Effect } from "effect";

import type { GitCore } from "../Services/GitCore.ts";
import type { GitHubCli } from "../Services/GitHubCli.ts";
import {
  OPEN_PR_LOOKUP_LIMIT,
  type BranchHeadContext,
  type PullRequestHeadRemoteInfo,
  type PullRequestInfo,
  type ResolvedPullRequest,
} from "./GitManager.types.ts";
import {
  appendUnique,
  extractBranchFromRef,
  gitManagerError,
} from "./GitManager.commits.ts";
import {
  extractPullRequestUrlFromError,
  inferPullRequestHeadRemoteInfoFromSelector,
  matchesBranchHeadContext,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parsePullRequestList,
  parseRepositoryOwnerLogin,
  resolveHeadRepositoryNameWithOwner,
  shouldPreferSshRemote,
  toPullRequestHeadRemoteInfo,
  toPullRequestInfo,
} from "./GitManager.pullRequests.ts";

export interface PrResolutionDeps {
  readonly gitCore: GitCore;
  readonly gitHubCli: GitHubCli;
}

export interface PrResolution {
  readonly configurePullRequestHeadUpstream: (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch?: string,
  ) => Effect.Effect<void>;
  readonly materializePullRequestHeadBranch: (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch?: string,
  ) => Effect.Effect<unknown, unknown>;
  readonly resolveBranchHeadContext: (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) => Effect.Effect<BranchHeadContext, unknown>;
  readonly findOpenPr: (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headSelectors"
      | "headBranch"
      | "remoteName"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) => Effect.Effect<PullRequestInfo | null, unknown>;
  readonly findLatestPr: (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) => Effect.Effect<PullRequestInfo | null, unknown>;
  readonly resolveAlreadyExistingPullRequest: (
    cwd: string,
    error: unknown,
    headContext: BranchHeadContext,
  ) => Effect.Effect<PullRequestInfo | null, unknown>;
  readonly resolveBaseBranch: (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository">,
  ) => Effect.Effect<string, unknown>;
}

export function makePrResolution(deps: PrResolutionDeps): PrResolution {
  const { gitCore, gitHubCli } = deps;

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        });
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch(() =>
        gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        }),
      ),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRemoteRepositoryContext = (cwd: string, remoteName: string | null) =>
    Effect.gen(function* () {
      if (!remoteName) {
        return {
          repositoryNameWithOwner: null,
          ownerLogin: null,
        };
      }

      const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
      const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      return {
        repositoryNameWithOwner,
        ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
      };
    });

  const resolveBranchHeadContext = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) =>
    Effect.gen(function* () {
      const remoteName = yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`);
      const headBranchFromUpstream = details.upstreamRef
        ? extractBranchFromRef(details.upstreamRef)
        : "";
      const headBranch =
        headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;

      const [remoteRepository, originRepository] = yield* Effect.all(
        [
          resolveRemoteRepositoryContext(cwd, remoteName),
          resolveRemoteRepositoryContext(cwd, "origin"),
        ],
        { concurrency: "unbounded" },
      );

      const isCrossRepository =
        remoteRepository.repositoryNameWithOwner !== null &&
        originRepository.repositoryNameWithOwner !== null
          ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
            originRepository.repositoryNameWithOwner.toLowerCase()
          : remoteName !== null &&
            remoteName !== "origin" &&
            remoteRepository.repositoryNameWithOwner !== null;

      const ownerHeadSelector =
        remoteRepository.ownerLogin && headBranch.length > 0
          ? `${remoteRepository.ownerLogin}:${headBranch}`
          : null;
      const remoteAliasHeadSelector =
        remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
      const shouldProbeRemoteOwnedSelectors = remoteName !== null;

      const headSelectors: string[] = [];
      if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
        appendUnique(headSelectors, headBranch);
      }

      appendUnique(headSelectors, details.branch);
      if (!isCrossRepository) {
        appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
      }
      if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
      }

      return {
        localBranch: details.branch,
        headBranch,
        headSelectors,
        preferredHeadSelector:
          ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
        remoteName,
        headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
        headRepositoryOwnerLogin: remoteRepository.ownerLogin,
        isCrossRepository,
      } satisfies BranchHeadContext;
    });

  const findOpenPr = (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headSelectors"
      | "headBranch"
      | "remoteName"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) =>
    Effect.gen(function* () {
      for (const headSelector of headContext.headSelectors) {
        const pullRequests = yield* gitHubCli.listOpenPullRequests({
          cwd,
          headSelector,
          limit: OPEN_PR_LOOKUP_LIMIT,
        });
        const inferredHeadInfo = inferPullRequestHeadRemoteInfoFromSelector(
          headSelector,
          headContext,
        );

        for (const pullRequest of pullRequests) {
          const candidate: PullRequestInfo = {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            baseRefName: pullRequest.baseRefName,
            headRefName: pullRequest.headRefName,
            state: pullRequest.state ?? "open",
            updatedAt: null,
            ...(pullRequest.isCrossRepository !== undefined
              ? { isCrossRepository: pullRequest.isCrossRepository }
              : {}),
            ...(pullRequest.headRepositoryNameWithOwner !== undefined
              ? { headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin !== undefined
              ? { headRepositoryOwnerLogin: pullRequest.headRepositoryOwnerLogin }
              : {}),
            ...(pullRequest.isCrossRepository === undefined &&
            pullRequest.headRepositoryNameWithOwner === undefined &&
            pullRequest.headRepositoryOwnerLogin === undefined
              ? toPullRequestHeadRemoteInfo(inferredHeadInfo)
              : {}),
          };
          if (!matchesBranchHeadContext(candidate, headContext)) {
            continue;
          }

          return {
            ...candidate,
          } satisfies PullRequestInfo;
        }
      }

      return null;
    });

  const findLatestPr = (cwd: string, details: { branch: string; upstreamRef: string | null }) =>
    Effect.gen(function* () {
      const headContext = yield* resolveBranchHeadContext(cwd, details);
      const parsedByNumber = new Map<number, PullRequestInfo>();

      for (const headSelector of headContext.headSelectors) {
        const inferredHeadInfo = inferPullRequestHeadRemoteInfoFromSelector(
          headSelector,
          headContext,
        );
        const stdout = yield* gitHubCli
          .execute({
            cwd,
            args: [
              "pr",
              "list",
              "--head",
              headSelector,
              "--state",
              "all",
              "--limit",
              "20",
              "--json",
              "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
            ],
          })
          .pipe(Effect.map((result) => result.stdout));

        const raw = stdout.trim();
        if (raw.length === 0) {
          continue;
        }

        const parsedJson = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (cause) =>
            gitManagerError("findLatestPr", "GitHub CLI returned invalid PR list JSON.", cause),
        });

        for (const pr of parsePullRequestList(parsedJson)) {
          const candidate =
            pr.isCrossRepository === undefined &&
            pr.headRepositoryNameWithOwner === undefined &&
            pr.headRepositoryOwnerLogin === undefined
              ? ({
                  ...pr,
                  ...toPullRequestHeadRemoteInfo(inferredHeadInfo),
                } satisfies PullRequestInfo)
              : pr;
          if (!matchesBranchHeadContext(candidate, headContext)) {
            continue;
          }
          parsedByNumber.set(candidate.number, candidate);
        }
      }

      const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
        const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return right - left;
      });

      const latestOpenPr = parsed.find((pr) => pr.state === "open");
      if (latestOpenPr) {
        return latestOpenPr;
      }
      return parsed[0] ?? null;
    });

  const resolveAlreadyExistingPullRequest = (
    cwd: string,
    error: unknown,
    headContext: BranchHeadContext,
  ) =>
    Effect.gen(function* () {
      const pullRequestUrl = extractPullRequestUrlFromError(error);
      if (pullRequestUrl) {
        const pullRequest = yield* gitHubCli
          .getPullRequest({ cwd, reference: pullRequestUrl })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (pullRequest) {
          const candidate = toPullRequestInfo(pullRequest);
          if (candidate.state === "open" && matchesBranchHeadContext(candidate, headContext)) {
            return candidate;
          }
        }
      }

      // `gh pr create` can race with an existing-PR probe. Treat GitHub's
      // create-time duplicate response as success when the PR can be found.
      return yield* findOpenPr(cwd, headContext);
    });

  const resolveBaseBranch = (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository">,
  ) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef && !headContext.isCrossRepository) {
        const upstreamBranch = extractBranchFromRef(upstreamRef);
        if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
          return upstreamBranch;
        }
      }

      const defaultFromGh = yield* gitHubCli
        .getDefaultBranch({ cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (defaultFromGh) {
        return defaultFromGh;
      }

      return "main";
    });

  return {
    configurePullRequestHeadUpstream,
    materializePullRequestHeadBranch,
    resolveBranchHeadContext,
    findOpenPr,
    findLatestPr,
    resolveAlreadyExistingPullRequest,
    resolveBaseBranch,
  };
}
