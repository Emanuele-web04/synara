// FILE: githubInbox.logic.ts
// Purpose: Pure logic behind the GitHub inbox page: URL search parsing (including links from the
//          older pull request page), the effective filters (URL overrides over persisted
//          settings), the visible-row pipeline over the one list superset, label options,
//          selection, the active-filter count, and which notes the list needs.
// Layer: Web domain helpers (no React)
// Exports: GitHubInboxSearch and helpers, GitHubInboxFilters and helpers, row pipeline helpers

import type {
  GitHubInboxItem,
  GitHubInboxItemKind,
  GitHubInboxListError,
  GitHubInboxRepositoryBatch,
  GitHubInboxState,
  GitHubInboxSort,
  PullRequestDetailInput,
  ProjectId,
} from "@synara/contracts";
import {
  coalescePullRequestListEntries,
  isValidGitHubRepositoryNameWithOwner,
} from "@synara/shared/githubRepository";

import type {
  AppSettings,
  GitHubInboxInvolvementFilter,
  GitHubInboxKindFilter,
  GitHubInboxStateFilter,
} from "~/appSettings";
import {
  filterInboxItemsByInvolvement,
  matchesPullRequestSearchQuery,
  groupPullRequestEntriesPinnedThenAll,
  orderPullRequestEntriesPinnedFirst,
  pullRequestListEntryKey,
  safeGitHubLabelColor,
  scopeInboxItemsToProjects,
  type PullRequestListGroup,
  type PullRequestListGroupKey,
} from "~/components/pullRequest/pullRequestList.logic";

// ── URL search ─────────────────────────────────────────────────────────────

/**
 * The inbox URL. Filter fields are one-visit overrides of the persisted filters (a deep link or
 * the sidebar's per-project button); selection fields keep an open item linkable.
 */
export interface GitHubInboxSearch {
  type?: GitHubInboxKindFilter;
  state?: GitHubInboxStateFilter;
  involvement?: GitHubInboxInvolvementFilter;
  projectId?: ProjectId;
  q?: string;
  kind?: GitHubInboxItemKind;
  selectedProjectId?: ProjectId;
  selectedRepo?: string;
  number?: number;
}

export type GitHubInboxSearchPatch = {
  [Key in keyof GitHubInboxSearch]?: GitHubInboxSearch[Key] | undefined;
};

const SEARCH_QUERY_MAX_LENGTH = 200;

const INVOLVEMENT_FILTERS: readonly GitHubInboxInvolvementFilter[] = [
  "everything",
  "involved",
  "reviewRequested",
  "authored",
  "assigned",
];

function parseInvolvement(value: unknown): GitHubInboxInvolvementFilter | undefined {
  // The pull request page used "all" / "reviewing" / "authored". "all" was forced by the sidebar
  // on every visit, so it is not an override; the other two map onto their inbox names.
  if (value === "reviewing") return "reviewRequested";
  return INVOLVEMENT_FILTERS.find((filter) => filter === value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseGitHubInboxSearch(raw: Record<string, unknown>): GitHubInboxSearch {
  const type =
    raw.type === "all" || raw.type === "pullRequest" || raw.type === "issue" ? raw.type : undefined;
  const state =
    raw.state === "open" || raw.state === "closed" || raw.state === "merged"
      ? raw.state
      : undefined;
  const involvement = parseInvolvement(raw.involvement);
  const projectId = nonEmptyString(raw.projectId) as ProjectId | undefined;
  const q = nonEmptyString(raw.q)?.slice(0, SEARCH_QUERY_MAX_LENGTH);
  const kind = raw.kind === "pullRequest" || raw.kind === "issue" ? raw.kind : undefined;
  const selectedProjectId = nonEmptyString(raw.selectedProjectId) as ProjectId | undefined;
  const selectedRepo =
    typeof raw.selectedRepo === "string" && isValidGitHubRepositoryNameWithOwner(raw.selectedRepo)
      ? raw.selectedRepo.trim()
      : undefined;
  const number =
    typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? raw.number
      : undefined;
  return compactGitHubInboxSearch({
    type,
    state,
    involvement,
    projectId,
    q,
    kind,
    selectedProjectId,
    selectedRepo,
    number,
  });
}

/** Drops unset fields so the URL carries only what is actually overridden or selected. */
function compactGitHubInboxSearch(search: GitHubInboxSearchPatch): GitHubInboxSearch {
  const compact: GitHubInboxSearch = {};
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== "") {
      (compact as Record<string, unknown>)[key] = value;
    }
  }
  return compact;
}

export function mergeGitHubInboxSearch(
  previous: GitHubInboxSearch,
  patch: GitHubInboxSearchPatch,
): GitHubInboxSearch {
  return compactGitHubInboxSearch({ ...previous, ...patch });
}

/** Closing the detail (or going back on a narrow window) drops every selection field. */
export const CLEARED_GITHUB_INBOX_SELECTION = {
  kind: undefined,
  selectedProjectId: undefined,
  selectedRepo: undefined,
  number: undefined,
} as const satisfies GitHubInboxSearchPatch;

export interface GitHubInboxSelection extends Pick<
  PullRequestDetailInput,
  "projectId" | "repository" | "number"
> {
  kind: GitHubInboxItemKind;
}

/**
 * The item the URL opens. Links from the pull request page carry no kind, and only ever pointed
 * at pull requests. A crafted URL must not show Project A's list while opening Project B's item,
 * so a project override in the URL also scopes the selection.
 */
export function githubInboxSelection(search: GitHubInboxSearch): GitHubInboxSelection | null {
  if (!search.selectedProjectId || !search.selectedRepo || !search.number) return null;
  if (search.projectId !== undefined && search.selectedProjectId !== search.projectId) return null;
  return {
    kind: search.kind ?? "pullRequest",
    projectId: search.selectedProjectId,
    repository: search.selectedRepo,
    number: search.number,
  };
}

export function githubInboxSelectionForItem(
  item: Pick<GitHubInboxItem, "kind" | "projectId" | "repository" | "number">,
): GitHubInboxSearchPatch {
  return {
    kind: item.kind,
    selectedProjectId: item.projectId,
    selectedRepo: item.repository,
    number: item.number,
  };
}

export function isGitHubInboxItemSelected(
  item: Pick<GitHubInboxItem, "projectId" | "repository" | "number">,
  selection: GitHubInboxSelection | null,
): boolean {
  return (
    selection !== null &&
    selection.projectId === item.projectId &&
    selection.repository === item.repository &&
    selection.number === item.number
  );
}

/**
 * The projects Send to agent can open a thread in for the selected item: every project whose
 * repository lists it, narrowed to the project filter when that leaves any. Empty when the
 * item is not in the loaded list; the detail panel then offers the item's own project.
 */
export function githubInboxSendTargets(
  items: ReadonlyArray<GitHubInboxItem>,
  selection: GitHubInboxSelection,
  filters: Pick<GitHubInboxFilters, "projectIds">,
): Array<{ projectId: ProjectId; projectTitle: string }> {
  const repository = selection.repository.toLowerCase();
  const byProjectId = new Map<ProjectId, string>();
  for (const item of items) {
    if (
      item.kind !== selection.kind ||
      item.number !== selection.number ||
      item.repository.toLowerCase() !== repository
    ) {
      continue;
    }
    byProjectId.set(item.projectId, item.projectTitle);
    for (const context of item.projectContexts ?? []) {
      byProjectId.set(context.projectId, context.projectTitle);
    }
  }
  const all = [...byProjectId].map(([projectId, projectTitle]) => ({
    projectId,
    projectTitle,
  }));
  const filtered =
    filters.projectIds.length > 0
      ? all.filter((target) => filters.projectIds.includes(target.projectId))
      : all;
  return filtered.length > 0 ? filtered : all;
}

// ── Filters ────────────────────────────────────────────────────────────────

export interface GitHubInboxFilters {
  kind: GitHubInboxKindFilter;
  state: GitHubInboxStateFilter;
  involvement: GitHubInboxInvolvementFilter;
  /** Empty means every project. */
  projectIds: ProjectId[];
  /** Empty means any label. A row matches when it has any selected label. */
  labels: string[];
}

export type GitHubInboxFilterSettings = Pick<
  AppSettings,
  | "githubInboxKind"
  | "githubInboxState"
  | "githubInboxInvolvement"
  | "githubInboxProjectIds"
  | "githubInboxLabels"
>;

/** The filters "Clear filters" returns to: everything the filter bar can mark as changed. */
export const CLEARED_GITHUB_INBOX_FILTER_SETTINGS = {
  githubInboxKind: "all",
  githubInboxState: "open",
  githubInboxInvolvement: "everything",
  githubInboxProjectIds: [],
  githubInboxLabels: [],
} as const satisfies Partial<GitHubInboxFilterSettings>;

/** Every URL filter override, for dropping them all at once. */
export const CLEARED_GITHUB_INBOX_FILTER_SEARCH = {
  type: undefined,
  state: undefined,
  involvement: undefined,
  projectId: undefined,
  q: undefined,
} as const satisfies GitHubInboxSearchPatch;

/**
 * URL overrides win over the persisted filters. Persisted projects that no longer exist are
 * dropped here, so removing a project can never leave the inbox filtered down to nothing.
 */
export function resolveGitHubInboxFilters(
  search: GitHubInboxSearch,
  settings: GitHubInboxFilterSettings,
  existingProjectIds: ReadonlySet<ProjectId>,
): GitHubInboxFilters {
  return {
    kind: search.type ?? settings.githubInboxKind,
    state: search.state ?? settings.githubInboxState,
    involvement: search.involvement ?? settings.githubInboxInvolvement,
    projectIds: search.projectId
      ? [search.projectId]
      : (settings.githubInboxProjectIds as ProjectId[]).filter((projectId) =>
          existingProjectIds.has(projectId),
        ),
    labels: [...settings.githubInboxLabels],
  };
}

/** The server list a status filter reads. Merged pull requests live in the closed list. */
export function githubInboxListState(state: GitHubInboxStateFilter): GitHubInboxState {
  return state === "open" ? "open" : "closed";
}

/** Filters away from their default (kind, closed state, involvement, projects, labels, text).
 *  Each one is what the filter bar marks as changed and what "Clear filters" resets. */
export function countActiveGitHubInboxFilters(filters: GitHubInboxFilters, query: string): number {
  return (
    (filters.kind !== "all" ? 1 : 0) +
    (filters.state !== "open" ? 1 : 0) +
    (filters.involvement !== "everything" ? 1 : 0) +
    (filters.projectIds.length > 0 ? 1 : 0) +
    (filters.labels.length > 0 ? 1 : 0) +
    (query.trim().length > 0 ? 1 : 0)
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

function itemMatchesKind(item: GitHubInboxItem, kind: GitHubInboxKindFilter): boolean {
  return kind === "all" || item.kind === kind;
}

/** Merged narrows the closed list to merged pull requests; the other states are whole lists. */
function itemMatchesState(item: GitHubInboxItem, state: GitHubInboxStateFilter): boolean {
  return state !== "merged" || (item.kind === "pullRequest" && item.state === "merged");
}

function itemMatchesLabels(item: GitHubInboxItem, labels: ReadonlySet<string>): boolean {
  return (
    labels.size === 0 || item.labels.some((label) => labels.has(normalizeLabelName(label.name)))
  );
}

/** Rows before the involvement, label, and text filters: one per remote item, in scope. */
function scopedInboxItems(
  items: ReadonlyArray<GitHubInboxItem>,
  filters: Pick<GitHubInboxFilters, "kind" | "state" | "projectIds">,
  preferredProjectId: ProjectId | undefined,
): GitHubInboxItem[] {
  return scopeInboxItemsToProjects(
    coalescePullRequestListEntries(items, { preferredProjectId }),
    filters.projectIds,
  ).filter((item) => itemMatchesKind(item, filters.kind) && itemMatchesState(item, filters.state));
}

/** The rows the list shows, pinned first, from the list superset of the current state. */
export function selectVisibleInboxItems(
  items: ReadonlyArray<GitHubInboxItem>,
  filters: GitHubInboxFilters,
  context: {
    viewer: string | null | undefined;
    normalizedQuery: string;
    sort?: GitHubInboxSort;
    preferredProjectId?: ProjectId | undefined;
  },
): GitHubInboxItem[] {
  const labels = new Set(filters.labels.map(normalizeLabelName));
  const timestamp = context.sort === "updated" ? "updatedAt" : "createdAt";
  return orderPullRequestEntriesPinnedFirst(
    filterInboxItemsByInvolvement(
      scopedInboxItems(items, filters, context.preferredProjectId),
      context.viewer,
      filters.involvement,
    )
      .filter(
        (item) =>
          itemMatchesLabels(item, labels) &&
          matchesPullRequestSearchQuery(item, context.normalizedQuery),
      )
      .toSorted(
        (left, right) =>
          right[timestamp].localeCompare(left[timestamp]) || right.number - left.number,
      ),
  );
}

export interface GitHubInboxKindCounts {
  all: number;
  pullRequest: number;
  issue: number;
}

/**
 * GitHub's own totals for the repositories in scope, or null when a filter the server does not
 * apply (merged, involvement, labels, text) narrows the view or a repository did not report its totals.
 */
function repositoryKindTotals(
  batches: ReadonlyArray<GitHubInboxRepositoryBatch>,
  filters: GitHubInboxFilters,
  normalizedQuery: string,
): GitHubInboxKindCounts | null {
  if (
    filters.state === "merged" ||
    filters.involvement !== "everything" ||
    filters.labels.length > 0 ||
    normalizedQuery
  ) {
    return null;
  }
  const inScope = batches.filter((batch) => inProjectScope(batch.projectIds, filters.projectIds));
  if (inScope.length === 0) return null;
  let pullRequest = 0;
  let issue = 0;
  for (const batch of inScope) {
    if (batch.totalPullRequests === undefined || batch.totalIssues === undefined) return null;
    pullRequest += batch.totalPullRequests;
    issue += batch.totalIssues;
  }
  return { all: pullRequest + issue, pullRequest, issue };
}

/**
 * The count beside each kind tab. Unfiltered, it is GitHub's real total for the state, which can
 * be more than the rows loaded; once a filter narrows the view it is the rows that match.
 */
export function countInboxItemsByKind(
  items: ReadonlyArray<GitHubInboxItem>,
  filters: GitHubInboxFilters,
  context: {
    viewer: string | null | undefined;
    normalizedQuery: string;
    repositoryBatches?: ReadonlyArray<GitHubInboxRepositoryBatch>;
  },
): GitHubInboxKindCounts {
  const totals = repositoryKindTotals(
    context.repositoryBatches ?? [],
    filters,
    context.normalizedQuery,
  );
  if (totals) return totals;
  const counts: GitHubInboxKindCounts = { all: 0, pullRequest: 0, issue: 0 };
  for (const item of selectVisibleInboxItems(items, { ...filters, kind: "all" }, context)) {
    counts.all += 1;
    counts[item.kind] += 1;
  }
  return counts;
}

/**
 * The list's sections: Pinned, then everything else in one list by latest activity, as on
 * GitHub. Narrowing to the viewer's own or review-requested items is the involvement filter's job.
 */
export function groupVisibleInboxItems(
  items: ReadonlyArray<GitHubInboxItem>,
): PullRequestListGroup[] {
  return groupPullRequestEntriesPinnedThenAll(items);
}

// ── Section state ──────────────────────────────────────────────────────────

/** Rows a section shows, and how many more each "Show more" reveals. */
export const INBOX_SECTION_PAGE_SIZE = 10;

/** The sections that start expanded; the rest start collapsed until the user opens them. */
export const DEFAULT_EXPANDED_INBOX_SECTIONS: ReadonlyArray<PullRequestListGroupKey> = [
  "authored",
  "reviewRequested",
];

/**
 * What a pasted search text points at, when it is exactly one loaded item: a GitHub pull
 * request URL (its repository must be in the list) or `#123`. Null when nothing or several
 * rows match, so the paste falls through to a plain search.
 */
export function resolveInboxItemReference(
  text: string,
  items: ReadonlyArray<GitHubInboxItem>,
): GitHubInboxItem | null {
  const trimmed = text.trim();
  const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i.exec(
    trimmed,
  );
  let matches: GitHubInboxItem[];
  if (url) {
    const repository = url[1]!.toLowerCase();
    const kind = url[2]!.toLowerCase() === "issues" ? "issue" : "pullRequest";
    const number = Number(url[3]);
    matches = items.filter(
      (item) =>
        item.repository.toLowerCase() === repository &&
        item.number === number &&
        item.kind === kind,
    );
  } else {
    const number = /^#(\d+)$/.exec(trimmed)?.[1];
    if (!number) return null;
    matches = items.filter((item) => item.number === Number(number));
  }
  const identities = new Set(matches.map((item) => pullRequestListEntryKey(item) + item.kind));
  return identities.size === 1 ? (matches[0] ?? null) : null;
}

export interface GitHubInboxLabelOption {
  name: string;
  /** GitHub's six-digit hex color, validated; null when missing or malformed. */
  color: string | null;
  count: number;
}

/**
 * Labels present on the rows in scope (state, projects, kind), most used first. Selected labels
 * stay listed even when no row carries them any more, so they can always be cleared.
 */
export function collectInboxLabelOptions(
  items: ReadonlyArray<GitHubInboxItem>,
  filters: GitHubInboxFilters,
): GitHubInboxLabelOption[] {
  const byName = new Map<string, GitHubInboxLabelOption>();
  for (const item of scopedInboxItems(items, filters, undefined)) {
    for (const label of item.labels) {
      const key = normalizeLabelName(label.name);
      const existing = byName.get(key);
      if (existing) existing.count += 1;
      else
        byName.set(key, {
          name: label.name,
          color: safeGitHubLabelColor(label.color),
          count: 1,
        });
    }
  }
  for (const name of filters.labels) {
    const key = normalizeLabelName(name);
    if (!byName.has(key)) byName.set(key, { name, color: null, count: 0 });
  }
  return [...byName.values()].toSorted(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
}

export function toggleGitHubInboxLabel(labels: ReadonlyArray<string>, name: string): string[] {
  const key = normalizeLabelName(name);
  return labels.some((label) => normalizeLabelName(label) === key)
    ? labels.filter((label) => normalizeLabelName(label) !== key)
    : [...labels, name];
}

export function isGitHubInboxLabelSelected(labels: ReadonlyArray<string>, name: string): boolean {
  const key = normalizeLabelName(name);
  return labels.some((label) => normalizeLabelName(label) === key);
}

// ── Notes ──────────────────────────────────────────────────────────────────

function inProjectScope(projectIds: ReadonlyArray<ProjectId>, filter: ReadonlyArray<ProjectId>) {
  return filter.length === 0 || projectIds.some((projectId) => filter.includes(projectId));
}

/** Repositories in scope whose list for the shown kind was cut at the per-repository cap. */
export function countTruncatedInboxRepositories(
  batches: ReadonlyArray<GitHubInboxRepositoryBatch>,
  filters: Pick<GitHubInboxFilters, "kind" | "state" | "projectIds">,
): number {
  return batches.filter(
    (batch) =>
      inProjectScope(batch.projectIds, filters.projectIds) &&
      ((filters.kind !== "issue" && batch.truncatedPullRequests) ||
        (filters.state !== "merged" && filters.kind !== "pullRequest" && batch.truncatedIssues)),
  ).length;
}

export function inboxErrorsInScope(
  errors: ReadonlyArray<GitHubInboxListError>,
  filters: Pick<GitHubInboxFilters, "projectIds">,
): GitHubInboxListError[] {
  return errors.filter((error) => inProjectScope([error.projectId], filters.projectIds));
}

/** How the list names what it holds, for empty states and notes. */
export function githubInboxItemNoun(kind: GitHubInboxKindFilter): string {
  if (kind === "pullRequest") return "pull requests";
  if (kind === "issue") return "issues";
  return "pull requests and issues";
}
