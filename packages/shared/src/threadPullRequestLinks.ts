// FILE: threadPullRequestLinks.ts
// Purpose: Pure rules for the pull requests linked to a thread: identity, provenance precedence,
//          tombstones, and which link is the thread's current PR (`lastKnownPr`).
// Layer: Shared domain logic (server decider/projections, web rendering)
// Exports: link/unlink/sync transforms, current-PR resolution, legacy replay helpers

import type {
  OrchestrationThreadPullRequest,
  OrchestrationThreadPullRequestExplicitLinkSource,
  OrchestrationThreadPullRequestLink,
  OrchestrationThreadPullRequestLinkSource,
} from "@synara/contracts";

import { normalizeGitHubPullRequestUrl } from "./githubRepository";

type PullRequestLinks = ReadonlyArray<OrchestrationThreadPullRequestLink>;

/** Bounds the stored list; tombstones are dropped first, then the oldest settled links. */
export const THREAD_PULL_REQUEST_LINK_LIMIT = 50;

const EXPLICIT_LINK_SOURCES: ReadonlySet<OrchestrationThreadPullRequestLinkSource> = new Set([
  "created",
  "agent",
  "user",
  "checkout",
]);

/** Canonical PR identity (host/owner/repo/number), stable across URL casing and suffixes. */
export function pullRequestLinkKey(url: string): string {
  return (
    normalizeGitHubPullRequestUrl(url) ??
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase()
  );
}

export function isExplicitPullRequestLinkSource(
  source: OrchestrationThreadPullRequestLinkSource,
): source is OrchestrationThreadPullRequestExplicitLinkSource {
  return EXPLICIT_LINK_SOURCES.has(source);
}

export function isPullRequestLinkVisible(link: OrchestrationThreadPullRequestLink): boolean {
  return link.dismissedAt == null;
}

export function visiblePullRequestLinks(
  links: PullRequestLinks | null | undefined,
): OrchestrationThreadPullRequestLink[] {
  return (links ?? []).filter(isPullRequestLinkVisible);
}

export function findPullRequestLink(
  links: PullRequestLinks | null | undefined,
  url: string,
): OrchestrationThreadPullRequestLink | null {
  const key = pullRequestLinkKey(url);
  return (links ?? []).find((link) => pullRequestLinkKey(link.pullRequest.url) === key) ?? null;
}

function linkedAtMs(link: OrchestrationThreadPullRequestLink): number {
  const parsed = Date.parse(link.linkedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The thread's current PR: an open link beats a settled one, and among equals the most
 * recently linked wins (the top of a stack is linked after its base). Tombstones never count.
 */
export function resolveCurrentPullRequestLink(
  links: PullRequestLinks | null | undefined,
): OrchestrationThreadPullRequestLink | null {
  let current: OrchestrationThreadPullRequestLink | null = null;
  for (const link of links ?? []) {
    if (!isPullRequestLinkVisible(link)) continue;
    if (current === null) {
      current = link;
      continue;
    }
    const isOpen = link.pullRequest.state === "open";
    const currentIsOpen = current.pullRequest.state === "open";
    if (isOpen !== currentIsOpen) {
      if (isOpen) current = link;
      continue;
    }
    if (linkedAtMs(link) >= linkedAtMs(current)) current = link;
  }
  return current;
}

export function resolveCurrentPullRequest(
  links: PullRequestLinks | null | undefined,
): OrchestrationThreadPullRequest | null {
  return resolveCurrentPullRequestLink(links)?.pullRequest ?? null;
}

/** The visible branch-managed (`discovered` / `legacy`) PR, which branch observations replace. */
export function resolveBranchManagedPullRequest(
  links: PullRequestLinks | null | undefined,
): OrchestrationThreadPullRequest | null {
  return resolveCurrentPullRequest(
    (links ?? []).filter((link) => !isExplicitPullRequestLinkSource(link.source)),
  );
}

/** The pre-link single `lastKnownPr` slot expressed as links (used by replay and backfill). */
export function legacyPullRequestLinks(
  pullRequest: OrchestrationThreadPullRequest | null | undefined,
  linkedAt: string,
): OrchestrationThreadPullRequestLink[] {
  return pullRequest ? [{ pullRequest, source: "legacy", linkedAt }] : [];
}

/**
 * Link list carried by a `thread.created` / `thread.meta-updated` payload. Events written before
 * links existed only carry `lastKnownPr`, which then replaced the thread's single PR slot.
 * Returns `undefined` when the event does not touch PRs.
 */
export function pullRequestLinksFromEventPayload(
  payload: {
    readonly pullRequests?: PullRequestLinks | undefined;
    readonly lastKnownPr?: OrchestrationThreadPullRequest | null | undefined;
  },
  occurredAt: string,
): OrchestrationThreadPullRequestLink[] | undefined {
  if (payload.pullRequests !== undefined) return [...payload.pullRequests];
  if (payload.lastKnownPr !== undefined) {
    return legacyPullRequestLinks(payload.lastKnownPr, occurredAt);
  }
  return undefined;
}

function capPullRequestLinks(
  links: OrchestrationThreadPullRequestLink[],
): OrchestrationThreadPullRequestLink[] {
  if (links.length <= THREAD_PULL_REQUEST_LINK_LIMIT) return links;
  const current = resolveCurrentPullRequestLink(links);
  // Removal order: tombstones, then settled links, then open links; oldest first within each.
  const removalRank = (link: OrchestrationThreadPullRequestLink) =>
    !isPullRequestLinkVisible(link) ? 0 : link.pullRequest.state !== "open" ? 1 : 2;
  const removable = links
    .filter((link) => link !== current)
    .toSorted((left, right) => {
      const rank = removalRank(left) - removalRank(right);
      return rank !== 0 ? rank : linkedAtMs(left) - linkedAtMs(right);
    });
  const removed = new Set(removable.slice(0, links.length - THREAD_PULL_REQUEST_LINK_LIMIT));
  return links.filter((link) => !removed.has(link));
}

function replaceLinkAt(
  links: PullRequestLinks,
  index: number,
  next: OrchestrationThreadPullRequestLink,
): OrchestrationThreadPullRequestLink[] {
  return links.map((link, candidate) => (candidate === index ? next : link));
}

function indexOfPullRequestLink(links: PullRequestLinks, url: string): number {
  const key = pullRequestLinkKey(url);
  return links.findIndex((link) => pullRequestLinkKey(link.pullRequest.url) === key);
}

/**
 * Adds an explicit link, or refreshes the stored state of an existing one. An explicit source
 * upgrades a branch-managed link (keeping its original `linkedAt`) and revives a tombstone.
 */
export function linkPullRequest(
  links: PullRequestLinks | null | undefined,
  input: {
    readonly pullRequest: OrchestrationThreadPullRequest;
    readonly source: OrchestrationThreadPullRequestExplicitLinkSource;
    readonly linkedAt: string;
  },
): OrchestrationThreadPullRequestLink[] {
  const current = links ?? [];
  const index = indexOfPullRequestLink(current, input.pullRequest.url);
  const fresh: OrchestrationThreadPullRequestLink = {
    pullRequest: input.pullRequest,
    source: input.source,
    linkedAt: input.linkedAt,
  };
  if (index === -1) return capPullRequestLinks([...current, fresh]);
  const existing = current[index]!;
  if (!isPullRequestLinkVisible(existing)) return replaceLinkAt(current, index, fresh);
  return replaceLinkAt(current, index, {
    pullRequest: input.pullRequest,
    source: isExplicitPullRequestLinkSource(existing.source) ? existing.source : input.source,
    linkedAt: existing.linkedAt,
  });
}

/** Tombstones a visible link. Returns `null` when the PR is not currently linked. */
export function unlinkPullRequest(
  links: PullRequestLinks | null | undefined,
  url: string,
  dismissedAt: string,
): OrchestrationThreadPullRequestLink[] | null {
  const current = links ?? [];
  const index = indexOfPullRequestLink(current, url);
  const existing = index === -1 ? null : current[index]!;
  if (existing === null || !isPullRequestLinkVisible(existing)) return null;
  return replaceLinkAt(current, index, { ...existing, dismissedAt });
}

/**
 * Applies a branch observation. Branch-managed links (`discovered`, `legacy`) for other PRs are
 * dropped, matching the old single-slot replacement; `null` drops them all. Explicit links and
 * tombstones are left alone, so a PR the user unlinked is not re-added by its branch.
 */
export function syncDiscoveredPullRequest(
  links: PullRequestLinks | null | undefined,
  pullRequest: OrchestrationThreadPullRequest | null,
  observedAt: string,
): OrchestrationThreadPullRequestLink[] {
  const key = pullRequest ? pullRequestLinkKey(pullRequest.url) : null;
  const kept = (links ?? []).filter(
    (link) =>
      !isPullRequestLinkVisible(link) ||
      isExplicitPullRequestLinkSource(link.source) ||
      pullRequestLinkKey(link.pullRequest.url) === key,
  );
  if (pullRequest === null) return kept;
  const index = indexOfPullRequestLink(kept, pullRequest.url);
  if (index === -1) {
    return capPullRequestLinks([
      ...kept,
      { pullRequest, source: "discovered", linkedAt: observedAt },
    ]);
  }
  const existing = kept[index]!;
  if (!isPullRequestLinkVisible(existing)) return kept;
  return replaceLinkAt(kept, index, { ...existing, pullRequest });
}

/** Refreshes the stored state of PRs that are already linked; never adds or revives links. */
export function refreshPullRequestSnapshots(
  links: PullRequestLinks | null | undefined,
  pullRequests: ReadonlyArray<OrchestrationThreadPullRequest>,
): OrchestrationThreadPullRequestLink[] {
  const byKey = new Map(pullRequests.map((pr) => [pullRequestLinkKey(pr.url), pr] as const));
  return (links ?? []).map((link) => {
    if (!isPullRequestLinkVisible(link)) return link;
    const refreshed = byKey.get(pullRequestLinkKey(link.pullRequest.url));
    return refreshed ? { ...link, pullRequest: refreshed } : link;
  });
}

export function threadPullRequestsEqual(
  left: OrchestrationThreadPullRequest | null | undefined,
  right: OrchestrationThreadPullRequest | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.baseBranch === right.baseBranch &&
    left.headBranch === right.headBranch &&
    left.state === right.state &&
    (left.isDraft ?? false) === (right.isDraft ?? false) &&
    (left.mergeability ?? "unknown") === (right.mergeability ?? "unknown") &&
    (left.additions ?? null) === (right.additions ?? null) &&
    (left.deletions ?? null) === (right.deletions ?? null) &&
    (left.changedFiles ?? null) === (right.changedFiles ?? null)
  );
}

export function pullRequestLinksEqual(
  left: PullRequestLinks | null | undefined,
  right: PullRequestLinks | null | undefined,
): boolean {
  const leftLinks = left ?? [];
  const rightLinks = right ?? [];
  if (leftLinks.length !== rightLinks.length) return false;
  return leftLinks.every((link, index) => {
    const other = rightLinks[index]!;
    return (
      link.source === other.source &&
      link.linkedAt === other.linkedAt &&
      (link.dismissedAt ?? null) === (other.dismissedAt ?? null) &&
      threadPullRequestsEqual(link.pullRequest, other.pullRequest)
    );
  });
}
