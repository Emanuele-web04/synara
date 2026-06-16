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

export interface ReviewServerListFilters {
  readonly author?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly label?: string;
  readonly columns?: ReadonlyArray<ReviewColumnId>;
  readonly checks?: ReadonlyArray<ReviewPullRequestSummary["checksStatus"]>;
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

const CHECKS_ORDER: ReadonlyArray<ReviewPullRequestSummary["checksStatus"]> = [
  "passing",
  "failing",
  "pending",
];
const STATUS_VALUES: ReadonlySet<string> = new Set(STATUS_ORDER);
const CHECKS_VALUES: ReadonlySet<string> = new Set(CHECKS_ORDER);

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

export const baseBranchFilterDef: ReviewFilterDefinition = {
  id: "base",
  label: "Base",
  extractOptions: (items) => {
    const seen = new Set<string>();
    const options: ReviewFilterOption[] = [];
    for (const item of items) {
      const branch = item.baseBranch.trim();
      if (branch.length > 0 && !seen.has(branch)) {
        seen.add(branch);
        options.push({ value: branch, label: branch });
      }
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  },
  match: (item, values) => values.has(item.baseBranch.trim()),
};

export const headBranchFilterDef: ReviewFilterDefinition = {
  id: "head",
  label: "Head",
  extractOptions: (items) => {
    const seen = new Set<string>();
    const options: ReviewFilterOption[] = [];
    for (const item of items) {
      const branch = item.headBranch.trim();
      const selector = item.headSelector?.trim() || branch;
      if (selector.length > 0 && !seen.has(selector)) {
        seen.add(selector);
        options.push({ value: selector, label: selector });
      }
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  },
  match: (item, values) => values.has(item.headSelector?.trim() || item.headBranch.trim()),
};

export const labelFilterDef: ReviewFilterDefinition = {
  id: "label",
  label: "Label",
  extractOptions: (items) => {
    const seen = new Set<string>();
    const options: ReviewFilterOption[] = [];
    for (const item of items) {
      for (const rawLabel of item.labels) {
        const label = rawLabel.trim();
        if (label.length > 0 && !seen.has(label)) {
          seen.add(label);
          options.push({ value: label, label });
        }
      }
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  },
  match: (item, values) => item.labels.some((label) => values.has(label.trim())),
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
  baseBranchFilterDef,
  headBranchFilterDef,
  labelFilterDef,
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

function valuesForFilter(
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
  fieldId: string,
): ReadonlyArray<string> {
  return [...(activeFilters.find((filter) => filter.fieldId === fieldId)?.values ?? [])].sort();
}

function isReviewColumnId(value: string): value is ReviewColumnId {
  return STATUS_VALUES.has(value);
}

function isReviewChecksStatus(value: string): value is ReviewPullRequestSummary["checksStatus"] {
  return CHECKS_VALUES.has(value);
}

export function toReviewServerListFilters(
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
): ReviewServerListFilters {
  const authors = valuesForFilter(activeFilters, authorFilterDef.id);
  const baseBranches = valuesForFilter(activeFilters, baseBranchFilterDef.id);
  const headBranches = valuesForFilter(activeFilters, headBranchFilterDef.id);
  const labels = valuesForFilter(activeFilters, labelFilterDef.id);
  const columns = valuesForFilter(activeFilters, statusFilterDef.id).filter(isReviewColumnId);
  const checks = valuesForFilter(activeFilters, checksFilterDef.id).filter(isReviewChecksStatus);
  return {
    ...(authors.length === 1 ? { author: authors[0] } : {}),
    ...(baseBranches.length === 1 ? { baseBranch: baseBranches[0] } : {}),
    ...(headBranches.length === 1 ? { headBranch: headBranches[0] } : {}),
    ...(labels.length === 1 ? { label: labels[0] } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...(checks.length > 0 ? { checks } : {}),
  };
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
