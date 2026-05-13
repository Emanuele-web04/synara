import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
} from "@t3tools/contracts";

import type { GitStatusDetails } from "./Services/GitCore";

export interface CachedValue<T> {
  readonly fingerprint: string;
  readonly updatedAt: number;
  readonly value: T;
}

export interface CachedGitStatus {
  readonly local: CachedValue<GitStatusLocalResult> | null;
  readonly remote: CachedValue<GitStatusRemoteResult | null> | null;
}

export const REMOTE_STATUS_CACHE_TTL_MS = 30_000;

export function makeCachedStatusValue<T>(value: T): CachedValue<T> {
  return {
    fingerprint: JSON.stringify(value),
    updatedAt: Date.now(),
    value,
  };
}

export function splitLocalStatus(status: GitStatusResult): GitStatusLocalResult {
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function splitLocalStatusDetails(status: GitStatusDetails): GitStatusLocalResult {
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function splitRemoteStatus(status: GitStatusResult): GitStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: status.pr,
  };
}

export function splitRemoteStatusDetails(
  status: GitStatusDetails,
  cachedRemote: GitStatusRemoteResult | null,
): GitStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: cachedRemote?.pr ?? null,
  };
}

export function canReuseCachedRemoteStatus(input: {
  readonly cached: CachedGitStatus;
  readonly details: GitStatusDetails;
  readonly now?: number;
  readonly ttlMs?: number;
}): boolean {
  if (!input.cached.local || !input.cached.remote) return false;
  if (input.details.branch !== input.cached.local.value.branch) return false;
  return (
    (input.now ?? Date.now()) - input.cached.remote.updatedAt <
    (input.ttlMs ?? REMOTE_STATUS_CACHE_TTL_MS)
  );
}
