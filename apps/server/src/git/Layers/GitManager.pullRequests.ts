// Purpose: Pure pull-request parsers, matchers, and shape converters for GitManager.
// Layer: Layers (pure helpers; no Effect/service binding).
// Exports: resolveHeadRepositoryNameWithOwner, resolvePullRequestWorktreeLocalBranchName,
//   parseGitHubRepositoryNameWithOwnerFromRemoteUrl, parseRepositoryOwnerLogin,
//   normalizeOptionalString, resolvePullRequestHeadRepositoryNameWithOwner,
//   matchesBranchHeadContext, toPullRequestInfo, isPullRequestAlreadyExistsError,
//   extractPullRequestUrlFromError, parsePullRequestList, toStatusPr,
//   normalizePullRequestReference, toResolvedPullRequest, shouldPreferSshRemote,
//   toPullRequestHeadRemoteInfo, inferPullRequestHeadRemoteInfoFromSelector.

import { parseRepositoryNameFromPullRequestUrl, sanitizeBranchFragment } from "@t3tools/shared/git";

import type { GitHubPullRequestSummary } from "../Services/GitHubCli.ts";
import type {
  BranchHeadContext,
  PullRequestHeadRemoteInfo,
  PullRequestInfo,
  ResolvedPullRequest,
} from "./GitManager.types.ts";

export function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `t3code/pr-${pullRequest.number}/${suffix}`;
}

export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function resolvePullRequestHeadRepositoryNameWithOwner(
  pr: PullRequestHeadRemoteInfo & { url: string },
): string | null {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

export function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  const expectedHeadOwner =
    normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(expectedHeadRepository);
  const prHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  const prHeadOwner =
    normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(prHeadRepository);

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if ((expectedHeadRepository || expectedHeadOwner) && !prHeadRepository && !prHeadOwner) {
      return false;
    }
    if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
      return false;
    }
    if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    return false;
  }
  if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
    return false;
  }
  if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
    return false;
  }
  return true;
}

// Normalizes `gh pr view` service output into the richer internal PR shape.
export function toPullRequestInfo(pullRequest: GitHubPullRequestSummary): PullRequestInfo {
  return {
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
  };
}

// Detects GitHub's duplicate-PR response from `gh pr create`.
export function isPullRequestAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("pull request") &&
    message.includes("branch") &&
    message.includes("already exists")
  );
}

// Pulls the existing PR URL out of GitHub's duplicate-PR error when present.
export function extractPullRequestUrlFromError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/i.exec(error.message);
  return match?.[0] ?? null;
}

export function parsePullRequestList(raw: unknown): PullRequestInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: PullRequestInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    const state = record.state;
    const mergedAt = record.mergedAt;
    const updatedAt = record.updatedAt;
    const isCrossRepository = record.isCrossRepository;
    const headRepository = record.headRepository;
    const headRepositoryOwner = record.headRepositoryOwner;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      continue;
    }
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }

    let normalizedState: "open" | "closed" | "merged";
    if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
      normalizedState = "merged";
    } else if (state === "OPEN" || state === undefined || state === null) {
      normalizedState = "open";
    } else if (state === "CLOSED") {
      normalizedState = "closed";
    } else {
      continue;
    }

    parsed.push({
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
      ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
      ...(headRepository &&
      typeof headRepository === "object" &&
      typeof (headRepository as { nameWithOwner?: unknown }).nameWithOwner === "string"
        ? {
            headRepositoryNameWithOwner: (headRepository as { nameWithOwner: string })
              .nameWithOwner,
          }
        : {}),
      ...(headRepositoryOwner &&
      typeof headRepositoryOwner === "object" &&
      typeof (headRepositoryOwner as { login?: unknown }).login === "string"
        ? {
            headRepositoryOwnerLogin: (headRepositoryOwner as { login: string }).login,
          }
        : {}),
    });
  }
  return parsed;
}

export function toStatusPr(pr: PullRequestInfo): {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
} {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state,
  };
}

export function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

export function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state?: "open" | "closed" | "merged";
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? "open",
  };
}

export function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

export function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}

export function inferPullRequestHeadRemoteInfoFromSelector(
  headSelector: string,
  headContext: Pick<
    BranchHeadContext,
    | "headBranch"
    | "remoteName"
    | "headRepositoryNameWithOwner"
    | "headRepositoryOwnerLogin"
    | "isCrossRepository"
  >,
): PullRequestHeadRemoteInfo {
  const separatorIndex = headSelector.indexOf(":");
  if (separatorIndex > 0 && separatorIndex < headSelector.length - 1) {
    const selectorPrefix = headSelector.slice(0, separatorIndex);
    if (selectorPrefix === headContext.remoteName) {
      return {
        isCrossRepository: headContext.isCrossRepository,
        ...(headContext.headRepositoryNameWithOwner
          ? { headRepositoryNameWithOwner: headContext.headRepositoryNameWithOwner }
          : {}),
        ...(headContext.headRepositoryOwnerLogin
          ? { headRepositoryOwnerLogin: headContext.headRepositoryOwnerLogin }
          : {}),
      };
    }

    return {
      isCrossRepository: true,
      headRepositoryOwnerLogin: selectorPrefix,
    };
  }

  if (headContext.isCrossRepository && headSelector === headContext.headBranch) {
    return {
      isCrossRepository: true,
      ...(headContext.headRepositoryNameWithOwner
        ? { headRepositoryNameWithOwner: headContext.headRepositoryNameWithOwner }
        : {}),
      ...(headContext.headRepositoryOwnerLogin
        ? { headRepositoryOwnerLogin: headContext.headRepositoryOwnerLogin }
        : {}),
    };
  }

  return {};
}
