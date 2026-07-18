import type {
  GitPullRequestListFilter,
  PullRequestInvolvement,
  PullRequestState,
} from "@synara/contracts";

export const PULL_REQUEST_INVOLVEMENT_TABS: ReadonlyArray<{
  value: PullRequestInvolvement;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Review requested" },
  { value: "authored", label: "My PRs" },
];

export const PULL_REQUEST_STATE_TABS: ReadonlyArray<{
  value: PullRequestState;
  label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

export const PULL_REQUEST_PICKER_FILTERS: ReadonlyArray<{
  value: GitPullRequestListFilter;
  label: string;
}> = [
  { value: "reviewing", label: "Review requested" },
  { value: "authored", label: "My PRs" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

export function normalizePullRequestInvolvement(value: unknown): PullRequestInvolvement {
  if (value === "all" || value === "authored") return value;
  return "reviewing";
}

export function normalizePullRequestState(value: unknown): PullRequestState {
  return value === "closed" || value === "merged" ? value : "open";
}

export function pullRequestPickerScope(filter: GitPullRequestListFilter): {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
} {
  if (filter === "reviewing") return { involvement: "reviewing", state: "open" };
  if (filter === "authored") return { involvement: "authored", state: "open" };
  if (filter === "closed" || filter === "merged") {
    return { involvement: "all", state: filter };
  }
  return { involvement: "all", state: "open" };
}
