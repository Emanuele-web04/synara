import type { ReviewPullRequestSummary } from "@t3tools/contracts";

import { type ReviewColumnId, deriveReviewColumn, filterBySearch } from "./reviewBoardColumns";

// Generic, data-derived filter system modeled on diffkit's FilterDefinition:
// each facet derives its available options from the items actually present and
// tests an item against a selected value set (OR within a facet, AND across).
export interface ReviewFilterOption {
  value: string;
  label: string;
}

export interface ReviewFilterDefinition {
  id: string;
  label: string;
  extractOptions: (items: ReadonlyArray<ReviewPullRequestSummary>) => ReviewFilterOption[];
  match: (item: ReviewPullRequestSummary, values: ReadonlySet<string>) => boolean;
}

export interface ReviewSortOption {
  id: string;
  label: string;
  compare: (a: ReviewPullRequestSummary, b: ReviewPullRequestSummary) => number;
}

export interface ActiveReviewFilter {
  fieldId: string;
  values: ReadonlySet<string>;
}

const STATUS_LABEL: Record<ReviewColumnId, string> = {
  "needs-review": "Needs Review",
  "changes-requested": "Changes Requested",
  approved: "Approved",
  draft: "Draft",
  merged: "Merged",
};

const STATUS_ORDER: ReadonlyArray<ReviewColumnId> = [
  "needs-review",
  "changes-requested",
  "approved",
  "draft",
  "merged",
];

const CHECKS_LABEL: Record<string, string> = {
  passing: "Passing",
  failing: "Failing",
  pending: "Pending",
};

const CHECKS_ORDER: ReadonlyArray<string> = ["passing", "failing", "pending"];

export const authorFilterDef: ReviewFilterDefinition = {
  id: "author",
  label: "Author",
  extractOptions: (items) => {
    const seen = new Set<string>();
    const options: ReviewFilterOption[] = [];
    for (const item of items) {
      const login = item.author.trim();
      if (login.length > 0 && !seen.has(login)) {
        seen.add(login);
        options.push({ value: login, label: login });
      }
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  },
  match: (item, values) => values.has(item.author.trim()),
};

export const statusFilterDef: ReviewFilterDefinition = {
  id: "status",
  label: "Status",
  extractOptions: (items) => {
    const present = new Set<ReviewColumnId>();
    for (const item of items) {
      present.add(deriveReviewColumn(item));
    }
    return STATUS_ORDER.filter((status) => present.has(status)).map((status) => ({
      value: status,
      label: STATUS_LABEL[status],
    }));
  },
  match: (item, values) => values.has(deriveReviewColumn(item)),
};

export const checksFilterDef: ReviewFilterDefinition = {
  id: "checks",
  label: "Checks",
  extractOptions: (items) => {
    const present = new Set<string>();
    for (const item of items) {
      if (item.checksStatus !== "none") {
        present.add(item.checksStatus);
      }
    }
    return CHECKS_ORDER.filter((status) => present.has(status)).map((status) => ({
      value: status,
      label: CHECKS_LABEL[status] ?? status,
    }));
  },
  match: (item, values) => values.has(item.checksStatus),
};

export const reviewPullFilterDefs: ReadonlyArray<ReviewFilterDefinition> = [
  authorFilterDef,
  statusFilterDef,
  checksFilterDef,
];

export const reviewPullSortOptions: ReadonlyArray<ReviewSortOption> = [
  {
    id: "updated",
    label: "Recently updated",
    compare: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  },
  {
    id: "title",
    label: "Title (A–Z)",
    compare: (a, b) => a.title.localeCompare(b.title),
  },
  {
    id: "size",
    label: "Largest first",
    compare: (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  },
];

export function applyReviewFilters(
  items: ReadonlyArray<ReviewPullRequestSummary>,
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
  defs: ReadonlyArray<ReviewFilterDefinition>,
): ReadonlyArray<ReviewPullRequestSummary> {
  const active = activeFilters.filter((filter) => filter.values.size > 0);
  if (active.length === 0) {
    return items;
  }
  const defById = new Map(defs.map((def) => [def.id, def]));
  return items.filter((item) =>
    active.every((filter) => {
      const def = defById.get(filter.fieldId);
      return def ? def.match(item, filter.values) : true;
    }),
  );
}

export function sortReviewItems(
  items: ReadonlyArray<ReviewPullRequestSummary>,
  sortId: string,
  options: ReadonlyArray<ReviewSortOption>,
): ReadonlyArray<ReviewPullRequestSummary> {
  const option = options.find((entry) => entry.id === sortId);
  if (!option) {
    return items;
  }
  return [...items].sort(option.compare);
}

export function hasActiveReviewFilters(activeFilters: ReadonlyArray<ActiveReviewFilter>): boolean {
  return activeFilters.some((filter) => filter.values.size > 0);
}

// Search + facet filters in one pass (search reuses the board's matcher).
export function filterReviewPullRequests(
  items: ReadonlyArray<ReviewPullRequestSummary>,
  search: string,
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
  defs: ReadonlyArray<ReviewFilterDefinition> = reviewPullFilterDefs,
): ReadonlyArray<ReviewPullRequestSummary> {
  return applyReviewFilters(filterBySearch(items, search), activeFilters, defs);
}
