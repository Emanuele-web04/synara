// FILE: pullRequestList.logic.ts
// Purpose: Pure list helpers shared by every GitHub item list (pull requests and issues): the
//          viewer's relation to an item, involvement grouping and filtering, project scoping,
//          free-text search, pinned ordering, row identity, and pin toggles. The inbox page
//          composes them in githubInbox.logic.ts.
// Layer: Web domain helpers (no React)
// Exports: PullRequestListGroupKey, PullRequestListGroup, inboxItemViewerRelation, grouping,
//          project scoping, involvement/search filters, identity, and pin helpers

import type {
  GitHubInboxItem,
  GitHubInboxItemKind,
  GitHubViewerInvolvement,
  ProjectId,
  PullRequestActor,
  PullRequestLabel,
  PullRequestSetPinnedInput,
} from "@synara/contracts";
import {
  pullRequestListProjectContexts,
  pullRequestListRepositoryIdentity,
} from "@synara/shared/githubRepository";

import type { GitHubInboxInvolvementFilter } from "~/appSettings";

export type PullRequestListGroupKey =
  | "pinned"
  | "authored"
  | "reviewRequested"
  | "involved"
  | "others"
  | "all";

export interface PullRequestListGroup<T = GitHubInboxItem> {
  key: PullRequestListGroupKey;
  label: string;
  entries: T[];
}

const GROUP_LABELS: Record<PullRequestListGroupKey, string> = {
  pinned: "Pinned",
  authored: "Authored by me",
  reviewRequested: "Needs my review",
  involved: "Involving me",
  others: "Everything else",
  all: "All",
};

const GROUP_ORDER: readonly PullRequestListGroupKey[] = [
  "pinned",
  "authored",
  "reviewRequested",
  "involved",
  "others",
  "all",
];

/** The fields that say how the viewer relates to a row. Structural so older pull request rows
 *  (no kind, no involvement flags) and issue rows (no review request) both qualify. */
export interface InboxRelationSource {
  readonly kind?: GitHubInboxItemKind;
  readonly isPinned?: boolean | undefined;
  readonly author: PullRequestActor | null;
  readonly assignees?: ReadonlyArray<PullRequestActor> | undefined;
  readonly viewerReviewRequested?: boolean | undefined;
  readonly viewerInvolvement?: GitHubViewerInvolvement | undefined;
}

export interface InboxViewerRelation {
  authored: boolean;
  assigned: boolean;
  reviewRequested: boolean;
  /** Authored, assigned, review requested, or matched by GitHub's `involves:@me`. */
  involved: boolean;
}

function normalizeLogin(login: string | null | undefined): string | null {
  return login?.trim().toLowerCase() || null;
}

/**
 * We only claim relationships the list data represents. The server's involvement flags are the
 * source of truth; the login comparison covers rows from an older server and recovered pins.
 * Review requests only exist on pull requests, and include team-routed requests.
 */
export function inboxItemViewerRelation(
  item: InboxRelationSource,
  viewerLogin: string | null | undefined,
): InboxViewerRelation {
  const viewer = normalizeLogin(viewerLogin);
  const isViewer = (actor: PullRequestActor | null) =>
    viewer !== null && normalizeLogin(actor?.login) === viewer;
  const authored = item.viewerInvolvement?.authored === true || isViewer(item.author);
  const assigned =
    item.viewerInvolvement?.assigned === true || (item.assignees ?? []).some(isViewer);
  const reviewRequested = item.kind !== "issue" && item.viewerReviewRequested === true;
  return {
    authored,
    assigned,
    reviewRequested,
    involved: authored || assigned || reviewRequested || item.viewerInvolvement?.involved === true,
  };
}

/**
 * Rows limited to the selected projects. A repository-level row can belong to several projects;
 * it stays when any of them is selected and keeps only the selected projects' contexts, so its
 * pin reflects (and its pin toggle writes) those projects alone. No selection means every project.
 */
export function scopeInboxItemsToProjects<T extends GitHubInboxItem>(
  items: ReadonlyArray<T>,
  projectIds: ReadonlyArray<ProjectId>,
): T[] {
  if (projectIds.length === 0) return [...items];
  const selected = new Set(projectIds);
  return items.flatMap((item) => {
    const contexts = pullRequestListProjectContexts(item).filter((context) =>
      selected.has(context.projectId),
    );
    const preferred =
      contexts.find((context) => context.projectId === item.projectId) ?? contexts[0];
    if (!preferred) return [];
    return [
      {
        ...item,
        projectId: preferred.projectId,
        projectTitle: preferred.projectTitle,
        projectContexts: contexts,
        isPinned: contexts.some((context) => context.isPinned),
      },
    ];
  });
}

/** GitHub label colors are untrusted text; only a plain six-digit hex may reach a style. */
export function safeGitHubLabelColor(color: string | null | undefined): string | null {
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
}

export function pullRequestListEntryKey(entry: { repository: string; number: number }): string {
  return pullRequestListRepositoryIdentity(entry);
}

/** The one visible pin toggle applies consistently across every project context the row
 * carries: pinning pins it in each, unpinning clears each project that has it pinned. */
export function pullRequestPinToggleInputs(
  entry: Pick<GitHubInboxItem, "projectId" | "repository" | "number" | "isPinned"> & {
    projectTitle?: string;
    projectContexts?: GitHubInboxItem["projectContexts"];
  },
): PullRequestSetPinnedInput[] {
  return pullRequestListProjectContexts(entry)
    .filter((context) => !entry.isPinned || context.isPinned)
    .map((context) => ({
      projectId: context.projectId,
      repository: entry.repository,
      number: entry.number,
      isPinned: !entry.isPinned,
    }));
}

// The list is fetched once per state as a superset; every involvement view is a filter over it,
// so switching views never waits on the network.
export function filterInboxItemsByInvolvement<T extends InboxRelationSource>(
  items: readonly T[],
  viewerLogin: string | null | undefined,
  involvement: GitHubInboxInvolvementFilter,
): T[] {
  if (involvement === "everything") return [...items];
  return items.filter((item) => inboxItemViewerRelation(item, viewerLogin)[involvement]);
}

/** Free-text list filter: title, repository, head branch, "#123"/"123", author, and labels. */
export function matchesPullRequestSearchQuery(
  entry: {
    title: string;
    repository: string;
    number: number;
    author: PullRequestActor | null;
    headBranch?: string;
    labels?: ReadonlyArray<PullRequestLabel>;
  },
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return true;
  const labels = (entry.labels ?? []).map((label) => label.name).join(" ");
  return `${entry.title} ${entry.repository} ${entry.headBranch ?? ""} #${entry.number} ${entry.author?.login ?? ""} ${labels}`
    .toLowerCase()
    .includes(normalizedQuery);
}

/** Stable partition used by ungrouped views after an optimistic pin toggle. */
export function orderPullRequestEntriesPinnedFirst<T extends { isPinned?: boolean | undefined }>(
  entries: readonly T[],
): T[] {
  return [
    ...entries.filter((entry) => entry.isPinned === true),
    ...entries.filter((entry) => entry.isPinned !== true),
  ];
}

/**
 * The list as GitHub shows it: pins first, then every other row in one section, keeping the
 * caller's order (newest activity first). Empty sections are dropped.
 */
export function groupPullRequestEntriesPinnedThenAll<T extends { isPinned?: boolean | undefined }>(
  entries: readonly T[],
): PullRequestListGroup<T>[] {
  const groups: PullRequestListGroup<T>[] = [
    {
      key: "pinned",
      label: GROUP_LABELS.pinned,
      entries: entries.filter((entry) => entry.isPinned === true),
    },
    {
      key: "all",
      label: GROUP_LABELS.all,
      entries: entries.filter((entry) => entry.isPinned !== true),
    },
  ];
  return groups.filter((group) => group.entries.length > 0);
}

/**
 * Buckets rows into the list's sections. Pins lead. Then the viewer's own items, then items
 * waiting on the viewer's review (teams included), then the rest that involve the viewer
 * (assigned or mentioned), then everything else. Empty sections are dropped.
 */
export function groupPullRequestEntriesByInvolvement<T extends InboxRelationSource>(
  entries: readonly T[],
  viewerLogin: string | null | undefined,
): PullRequestListGroup<T>[] {
  const buckets: Record<PullRequestListGroupKey, T[]> = {
    pinned: [],
    authored: [],
    reviewRequested: [],
    involved: [],
    others: [],
    all: [],
  };

  for (const entry of entries) {
    if (entry.isPinned === true) {
      buckets.pinned.push(entry);
      continue;
    }
    const relation = inboxItemViewerRelation(entry, viewerLogin);
    if (relation.authored) {
      buckets.authored.push(entry);
    } else if (relation.reviewRequested) {
      buckets.reviewRequested.push(entry);
    } else if (relation.involved) {
      buckets.involved.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }

  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: GROUP_LABELS[key],
    entries: buckets[key],
  }));
}
