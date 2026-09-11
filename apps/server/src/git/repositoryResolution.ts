import {
  parseRepositoryIdentityFromRemoteUrl,
  repositoryWebUrl,
  type GitHostKind,
} from "@synara/shared/gitHostRepository";
import { Effect } from "effect";

import type { GitCoreShape } from "./Services/GitCore";

export interface RepositoryLink {
  readonly kind: GitHostKind;
  /** Canonical identity: `owner/repo` on GitHub, `host/group/project` on GitLab. */
  readonly reference: string;
  /** Host-relative display path. */
  readonly nameWithOwner: string;
  readonly url: string;
}

export interface RepositoryInventory {
  readonly repositories: ReadonlyArray<RepositoryLink>;
  /** False means discovery was incomplete and must never drive destructive cleanup. */
  readonly authoritative: boolean;
}

export interface ResolveRepositoriesOptions {
  /** Hosts `glab` is configured for; an unlisted non-github host stays unsupported. */
  readonly gitlabHosts: ReadonlySet<string>;
}

function normalizeGitRemoteName(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized !== "." ? normalized : null;
}

function uniqueRemoteCandidates(candidates: ReadonlyArray<string | null>): string[] {
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeGitRemoteName(candidate);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function readCurrentBranch(git: GitCoreShape, cwd: string) {
  const operation = "GitHost.repository.currentBranch";
  return git
    .execute({
      operation,
      cwd,
      args: ["branch", "--show-current"],
      allowNonZeroExit: true,
      maxOutputBytes: 16_384,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.code !== 0) {
          return Effect.fail(
            new Error(result.stderr.trim() || `${operation} failed with exit code ${result.code}.`),
          );
        }
        const trimmed = result.stdout.trim();
        return Effect.succeed(trimmed.length > 0 ? trimmed : null);
      }),
    );
}

function escapeGitConfigKeyForRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

type RepositoryConfig = {
  readonly branchRemote: string | null;
  readonly pushDefaultRemote: string | null;
  readonly remoteUrls: ReadonlyMap<string, string>;
};

function repositoryLinkFromRemoteUrl(
  remoteUrl: string,
  gitlabHosts: ReadonlySet<string>,
): RepositoryLink | null {
  const identity = parseRepositoryIdentityFromRemoteUrl(remoteUrl, { gitlabHosts });
  return identity
    ? {
        kind: identity.kind,
        reference: identity.reference,
        nameWithOwner: identity.path,
        url: repositoryWebUrl(identity),
      }
    : null;
}

function parseRepositoryConfig(stdout: string, branch: string | null): RepositoryConfig {
  let branchRemote: string | null = null;
  let pushDefaultRemote: string | null = null;
  const remoteUrls = new Map<string, string>();
  const branchRemoteKey = branch ? `branch.${branch}.remote`.toLowerCase() : null;

  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const separatorIndex = record.indexOf("\n");
    if (separatorIndex < 0) continue;
    const key = record.slice(0, separatorIndex).replace(/\r$/, "");
    const value = record.slice(separatorIndex + 1).trim();
    const normalizedValue = normalizeGitRemoteName(value);
    if (!normalizedValue) continue;

    const lowerKey = key.toLowerCase();
    if (branchRemoteKey && lowerKey === branchRemoteKey) {
      branchRemote = normalizedValue;
      continue;
    }
    if (lowerKey === "remote.pushdefault") {
      pushDefaultRemote = normalizedValue;
      continue;
    }
    const remoteMatch = /^remote\.(.+)\.url$/i.exec(key);
    if (remoteMatch?.[1] && !remoteUrls.has(remoteMatch[1])) {
      remoteUrls.set(remoteMatch[1], value);
    }
  }

  return { branchRemote, pushDefaultRemote, remoteUrls };
}

function readRepositoryConfig(git: GitCoreShape, cwd: string, branch: string | null) {
  const branchPattern = branch ? `branch\\.${escapeGitConfigKeyForRegex(branch)}\\.remote|` : "";
  return git
    .execute({
      operation: "GitHost.repository.config",
      cwd,
      args: [
        "config",
        "--null",
        "--get-regexp",
        `^(${branchPattern}remote\\.pushDefault|remote\\..*\\.url)$`,
      ],
      allowNonZeroExit: true,
      maxOutputBytes: 256 * 1024,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.code === 0) return Effect.succeed(parseRepositoryConfig(result.stdout, branch));
        // `git config --get-regexp` uses exit code 1 when no keys match. That is an
        // authoritative repository with no configured remotes, not a discovery failure.
        if (result.code === 1 && result.stdout.length === 0 && result.stderr.trim().length === 0) {
          return Effect.succeed(parseRepositoryConfig("", branch));
        }
        return Effect.fail(
          new Error(
            result.stderr.trim() ||
              `GitHost.repository.config failed with exit code ${result.code}.`,
          ),
        );
      }),
    );
}

function readExpandedRemoteUrl(git: GitCoreShape, cwd: string, remoteName: string) {
  const operation = "GitHost.repository.expandedRemoteUrl";
  return git
    .execute({
      operation,
      cwd,
      // Unlike the batched config read, this applies Git's url.*.insteadOf aliases.
      args: ["remote", "get-url", remoteName],
      allowNonZeroExit: true,
      maxOutputBytes: 64 * 1024,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.code !== 0) {
          return Effect.fail(
            new Error(result.stderr.trim() || `${operation} failed with exit code ${result.code}.`),
          );
        }
        return Effect.succeed(result.stdout.trim());
      }),
    );
}

function resolveRemote(
  git: GitCoreShape,
  cwd: string,
  remoteName: string,
  configuredUrl: string,
  gitlabHosts: ReadonlySet<string>,
) {
  const direct = repositoryLinkFromRemoteUrl(configuredUrl, gitlabHosts);
  if (direct) return Effect.succeed(direct);

  // Preserve the two-process common path. Only URLs the parser cannot understand need a
  // targeted Git call so aliases such as `gh:owner/repo.git` are expanded correctly.
  return readExpandedRemoteUrl(git, cwd, remoteName).pipe(
    Effect.map((expanded) => repositoryLinkFromRemoteUrl(expanded, gitlabHosts)),
  );
}

/** Resolve every unique supported repository configured by a workspace, in remote preference order. */
export function resolveRepositories(
  git: GitCoreShape,
  cwd: string,
  options: ResolveRepositoriesOptions,
) {
  return Effect.gen(function* () {
    // A branch query succeeds with empty output in detached/unborn repositories and fails when
    // `cwd` is not a repository, so it also preserves the old authoritative repo boundary.
    const branch = yield* readCurrentBranch(git, cwd);
    // This is the authoritative boundary. A failed local-config inventory must remain an error
    // rather than becoming an empty list, because consumers may remove state for repositories
    // not returned. Reading the relevant keys together avoids one process per config/remote.
    const { branchRemote, pushDefaultRemote, remoteUrls } = yield* readRepositoryConfig(
      git,
      cwd,
      branch,
    );

    const remoteNames = [...remoteUrls.keys()].toSorted((left, right) => left.localeCompare(right));
    const configuredRemoteNames = new Set(remoteNames);
    const candidates = uniqueRemoteCandidates([
      branchRemote,
      pushDefaultRemote,
      "origin",
      ...remoteNames,
    ]).flatMap((remoteName) => {
      if (!configuredRemoteNames.has(remoteName)) return [];
      const configuredUrl = remoteUrls.get(remoteName);
      return configuredUrl ? [{ remoteName, configuredUrl }] : [];
    });
    const resolved = yield* Effect.forEach(
      candidates,
      ({ remoteName, configuredUrl }) =>
        resolveRemote(git, cwd, remoteName, configuredUrl, options.gitlabHosts),
      { concurrency: 6 },
    );

    const repositories: RepositoryLink[] = [];
    const seen = new Set<string>();
    for (const repository of resolved) {
      if (!repository) continue;
      const key = repository.reference.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        repositories.push(repository);
      }
    }
    return { repositories, authoritative: true } satisfies RepositoryInventory;
  });
}

/** Resolve the preferred link while retaining all configured repositories for callers that list. */
export function resolveRepository(
  git: GitCoreShape,
  cwd: string,
  options: ResolveRepositoriesOptions,
) {
  return resolveRepositories(git, cwd, options).pipe(
    Effect.map(({ repositories }) => ({ repository: repositories[0] ?? null, repositories })),
  );
}
